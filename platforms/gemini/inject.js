/**
 * KYT Memory Extension — Gemini Inject Script (MAIN World)
 *
 * Runs in page context to intercept XHR/fetch for StreamGenerate requests.
 * Captures ONLY live messages (user sends + assistant responses).
 * NO history-load interception. NO batchexecute RPC parsing for messages.
 *
 * Architecture:
 *   MAIN world (this file) → CustomEvent → ISOLATED world (content.js) → chrome.runtime → background.js
 */

(function () {
  'use strict';

  // Injection guard — prevents double-init on extension reload
  if (window.__kytGeminiInjected) return;
  window.__kytGeminiInjected = true;

  // ═══════════════════════════════════════════════════════════════════════
  // DEDUPLICATOR — Inlined (MAIN world can't use ES imports)
  // ═══════════════════════════════════════════════════════════════════════

  class MessageDeduplicator {
    constructor() {
      this.recentMessages = new Map();
      this.dedupeWindow = 5000;
      this.maxMapSize = 1000;
      this.cleanupInterval = setInterval(() => this._cleanup(), 2000);
      this.stats = { totalAttempts: 0, captured: 0, duplicatesSkipped: 0, upgradeCaptures: 0 };
    }

    shouldCapture(content, captureMethod) {
      if (!content || typeof content !== 'string') return true; // fail-open
      this.stats.totalAttempts++;

      const normalized = content.trim().replace(/\s+/g, ' ').toLowerCase();
      const hash = this._hash(normalized);
      const now = Date.now();
      const confidence = captureMethod === 'xhr' || captureMethod === 'fetch' ? 95 : 50;

      if (this.recentMessages.has(hash)) {
        const last = this.recentMessages.get(hash);
        if (now - last.timestamp < this.dedupeWindow) {
          if (confidence > last.confidence) {
            this.recentMessages.set(hash, { timestamp: now, confidence });
            this.stats.upgradeCaptures++;
            return true;
          }
          this.stats.duplicatesSkipped++;
          return false;
        }
      }

      if (this.recentMessages.size >= this.maxMapSize) {
        const oldestKey = this.recentMessages.keys().next().value;
        this.recentMessages.delete(oldestKey);
      }
      this.recentMessages.set(hash, { timestamp: now, confidence });
      this.stats.captured++;
      return true;
    }

    _hash(content) {
      const FNV_PRIME = 0x01000193;
      let hash = 0x811c9dc5;
      for (let i = 0; i < content.length; i++) {
        hash ^= content.charCodeAt(i);
        hash = Math.imul(hash, FNV_PRIME);
      }
      return (hash >>> 0).toString(16);
    }

    _cleanup() {
      const cutoff = Date.now() - this.dedupeWindow;
      for (const [hash, entry] of this.recentMessages.entries()) {
        if (entry.timestamp < cutoff) this.recentMessages.delete(hash);
      }
    }

    getStats() {
      return { ...this.stats, mapSize: this.recentMessages.size };
    }
  }

  const deduplicator = new MessageDeduplicator();

  // ═══════════════════════════════════════════════════════════════════════
  // URL HELPERS
  // ═══════════════════════════════════════════════════════════════════════

  function resolveUrl(url) {
    try {
      return new URL(url, window.location.origin).href;
    } catch (_) {
      return url;
    }
  }

  function isGeminiDomain(url) {
    try {
      const parsed = new URL(resolveUrl(url));
      return parsed.hostname === 'gemini.google.com';
    } catch (_) {
      return false;
    }
  }

  function isStreamGenerate(url) {
    const resolved = resolveUrl(url);
    return resolved.includes('/StreamGenerate') ||
           resolved.includes('assistant.lamda.BardFrontendService');
  }

  // ═══════════════════════════════════════════════════════════════════════
  // BODY COERCION
  // ═══════════════════════════════════════════════════════════════════════

  function bodyToString(body) {
    if (typeof body === 'string') return body;
    if (body instanceof URLSearchParams) return body.toString();
    if (body instanceof FormData) {
      const params = new URLSearchParams();
      for (const [key, value] of body.entries()) {
        if (typeof value === 'string') params.set(key, value);
      }
      return params.toString();
    }
    if (body instanceof ArrayBuffer || body instanceof Uint8Array) {
      try { return new TextDecoder('utf-8').decode(body); } catch (_) { return null; }
    }
    return null;
  }

  async function bodyToStringAsync(body) {
    const sync = bodyToString(body);
    if (sync !== null) return sync;
    if (body instanceof Blob) {
      try { return await body.text(); } catch (_) { return null; }
    }
    if (body instanceof ReadableStream) {
      try {
        const reader = body.getReader();
        const chunks = [];
        let result;
        while (!(result = await reader.read()).done) chunks.push(result.value);
        const decoder = new TextDecoder('utf-8');
        return chunks.map(c => decoder.decode(c, { stream: true })).join('') + decoder.decode();
      } catch (_) { return null; }
    }
    return null;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // f.req PARSER — StreamGenerate only
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Parse the f.req payload from StreamGenerate form data.
   *
   * StreamGenerate format:
   *   f.req = [null, "[[\"hello\",0,...],[\"en\"],[...]]"]
   *   - outer[0] = null
   *   - outer[1] = JSON string → parse → payload[0][0] = user message
   *
   * We deliberately skip batchexecute RPCs — they never carry live user messages.
   *
   * @param {string} bodyStr - URL-encoded form body
   * @returns {{ userMessage: string, conversationId: string|null }|null}
   */
  function parseFReq(bodyStr) {
    if (!bodyStr) return null;

    let params;
    try {
      params = new URLSearchParams(bodyStr);
    } catch (_) {
      return null;
    }

    const fReq = params.get('f.req');
    if (!fReq) return null;

    let outer;
    try {
      outer = JSON.parse(fReq);
    } catch (_) {
      return null;
    }

    // Handle double encoding
    if (typeof outer === 'string') {
      try { outer = JSON.parse(outer); } catch (_) { return null; }
    }

    if (!Array.isArray(outer)) return null;

    // StreamGenerate: [null, "json_payload_string"]
    if (outer[0] !== null || typeof outer[1] !== 'string') return null;

    try {
      const payload = JSON.parse(outer[1]);
      if (!Array.isArray(payload) || !Array.isArray(payload[0])) return null;

      const userMessage = typeof payload[0][0] === 'string' ? payload[0][0] : null;
      if (!userMessage || !userMessage.trim()) return null;

      // Find conversation ID (c_<hex> pattern)
      let conversationId = null;
      const scan = function walk(val, depth) {
        if (depth > 8) return;
        if (typeof val === 'string' && val !== userMessage && /^c_[0-9a-f]{8,}$/.test(val)) {
          conversationId = val;
          return;
        }
        if (Array.isArray(val)) {
          for (const item of val) {
            if (conversationId) return;
            walk(item, depth + 1);
          }
        }
      };
      scan(payload, 0);

      return { userMessage: userMessage.trim(), conversationId };
    } catch (_) {
      return null;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // RESPONSE EXTRACTION — Longest-string heuristic
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Extract assistant response from Gemini's response frames.
   * Response format: anti-XSSI prefix `)]}'\n` + length-prefixed JSON frames.
   * We depth-first search for the longest string (the assistant's reply).
   */
  function extractAssistantResponse(responseText) {
    if (!responseText || typeof responseText !== 'string') return null;

    // Strip anti-XSSI prefix
    let cleaned = responseText;
    if (cleaned.startsWith(")]}'")) {
      const nlIdx = cleaned.indexOf('\n');
      if (nlIdx >= 0) cleaned = cleaned.substring(nlIdx + 1);
    }

    let longest = '';

    // Parse length-prefixed frames
    const lines = cleaned.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || /^\d+$/.test(trimmed)) continue;

      try {
        const parsed = JSON.parse(trimmed);
        const found = findLongestString(parsed);
        if (found.length > longest.length) longest = found;
      } catch (_) {
        // Not valid JSON — skip
      }
    }

    if (longest.length < 2) return null;

    // Strip any KYT injection blocks to prevent feedback loops
    const stripped = stripInjectionBlock(longest);
    return stripped && stripped.length >= 2 ? stripped : null;
  }

  function findLongestString(val) {
    if (typeof val === 'string') return val;
    if (!Array.isArray(val)) return '';
    let longest = '';
    for (const item of val) {
      const found = findLongestString(item);
      if (found.length > longest.length) longest = found;
    }
    return longest;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // INJECTION BLOCK STRIPPING
  // ═══════════════════════════════════════════════════════════════════════

  function stripInjectionBlock(content) {
    if (!content) return content;
    const hasMarkers = content.includes('[SESSION_CONTEXT]') ||
                       content.includes('[RETRIEVAL_CONTEXT]') ||
                       content.includes('[DATA_PROVENANCE]') ||
                       content.includes('[Retrieved Items]') ||
                       content.includes('K.Y.T.');
    if (!hasMarkers) return content;

    const lines = content.split('\n');
    const result = [];
    let inBlock = false;
    let blockDepth = 0;

    for (const line of lines) {
      if (line.match(/^\[(SESSION_CONTEXT|RETRIEVAL_CONTEXT|DATA_PROVENANCE|Retrieved Items)\]/) ||
          line.match(/^={3,}.*K\.Y\.T\./)) {
        inBlock = true;
        blockDepth++;
        continue;
      }
      if (inBlock && (line.match(/^={3,}$/) || line.trim() === '')) {
        blockDepth--;
        if (blockDepth <= 0) { inBlock = false; blockDepth = 0; }
        continue;
      }
      if (line.match(/^\[(?:Memory Context|Query Optimized|End of (?:Memory|Knowledge Base) Context)\]/)) continue;
      if (line.match(/^={80,}$/)) continue;
      if (!inBlock) result.push(line);
    }

    return result.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  // ═══════════════════════════════════════════════════════════════════════
  // CONTEXT INJECTION — Re-encode f.req with context prefix
  // ═══════════════════════════════════════════════════════════════════════

  function reEncodeFReq(bodyStr, contextPrefix, parseResult) {
    try {
      const params = new URLSearchParams(bodyStr);
      const fReq = params.get('f.req');
      if (!fReq) return null;

      let outer = JSON.parse(fReq);
      let isDoubleEncoded = false;
      if (typeof outer === 'string') {
        isDoubleEncoded = true;
        outer = JSON.parse(outer);
      }

      // StreamGenerate: outer = [null, "json_payload"], payload[0][0] = user message
      const payload = JSON.parse(outer[1]);
      payload[0][0] = contextPrefix + '\n\n' + parseResult.userMessage;
      outer[1] = JSON.stringify(payload);

      let encoded = JSON.stringify(outer);
      if (isDoubleEncoded) encoded = JSON.stringify(encoded);
      params.set('f.req', encoded);
      return params.toString();
    } catch (error) {
      console.warn('KYT Gemini: Failed to re-encode f.req:', error.message);
      return null;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // CONTEXT INJECTION PLUMBING — Request/Response via CustomEvent
  // ═══════════════════════════════════════════════════════════════════════

  const pendingContextRequests = new Map();
  const CONTEXT_TIMEOUT_MS = 28000;

  function requestContext(userMessage) {
    return new Promise((resolve) => {
      const requestId = 'ctx_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);

      const timeoutId = setTimeout(() => {
        pendingContextRequests.delete(requestId);
        resolve(null); // fail-open: send without context
      }, CONTEXT_TIMEOUT_MS);

      pendingContextRequests.set(requestId, { resolve, timeoutId });

      window.dispatchEvent(new CustomEvent('KYT_CONTEXT_REQUEST', {
        detail: { requestId, userMessage, config: {} }
      }));
    });
  }

  // Listen for context responses from bridge (ISOLATED world)
  window.addEventListener('KYT_CONTEXT_RESPONSE', function (event) {
    const detail = event.detail;
    if (!detail || !detail.requestId) return;

    const pending = pendingContextRequests.get(detail.requestId);
    if (!pending) return;

    clearTimeout(pending.timeoutId);
    pendingContextRequests.delete(detail.requestId);
    pending.resolve(detail.formattedContext || null);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // DISPATCH CAPTURE
  // ═══════════════════════════════════════════════════════════════════════

  function dispatchCapture(content, role, captureMethod, conversationId) {
    if (!content || typeof content !== 'string' || content.trim().length < 2) return;

    if (!deduplicator.shouldCapture(content, captureMethod)) return;

    const messageData = {
      content: content.trim(),
      role: role,
      platform: 'gemini',
      conversationId: conversationId || null,
      model: 'gemini',
      timestamp: Date.now(),
      messageId: 'msg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 11),
      captureMethod: captureMethod,
      url: window.location.href,
    };

    window.dispatchEvent(new CustomEvent('KYT_MESSAGE_CAPTURED', {
      detail: messageData
    }));
  }

  // ═══════════════════════════════════════════════════════════════════════
  // XHR INTERCEPTION (primary — Gemini uses XHR for StreamGenerate)
  // ═══════════════════════════════════════════════════════════════════════

  const originalXHROpen = XMLHttpRequest.prototype.open;
  const originalXHRSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    this.__kytMethod = method;
    this.__kytUrl = resolveUrl(url);
    return originalXHROpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function (body) {
    // Only intercept POST to StreamGenerate on gemini.google.com
    if (this.__kytMethod !== 'POST' ||
        !isGeminiDomain(this.__kytUrl) ||
        !isStreamGenerate(this.__kytUrl)) {
      return originalXHRSend.apply(this, arguments);
    }

    const bodyStr = bodyToString(body);
    const parseResult = parseFReq(bodyStr);

    if (!parseResult) {
      return originalXHRSend.apply(this, arguments);
    }

    console.log('📤 KYT Gemini: User message captured via XHR (' + parseResult.userMessage.length + ' chars)');
    dispatchCapture(parseResult.userMessage, 'user', 'xhr', parseResult.conversationId);

    // Capture assistant response when XHR completes
    const conversationId = parseResult.conversationId;
    this.addEventListener('load', function () {
      try {
        if (this.responseText) {
          const assistantText = extractAssistantResponse(this.responseText);
          if (assistantText) {
            console.log('📥 KYT Gemini: Assistant response captured via XHR (' + assistantText.length + ' chars)');
            dispatchCapture(assistantText, 'assistant', 'xhr', conversationId);
          }
        }
      } catch (e) { /* non-fatal */ }
    }, { once: true });

    // Context injection: defer send until context resolves
    const xhr = this;
    const originalBody = body;

    requestContext(parseResult.userMessage).then(function (formattedContext) {
      if (formattedContext) {
        const modified = reEncodeFReq(bodyStr, formattedContext, parseResult);
        if (modified) {
          console.log('💉 KYT Gemini: Context injected into XHR request');
          originalXHRSend.call(xhr, modified);
          return;
        }
      }
      originalXHRSend.call(xhr, originalBody);
    }).catch(function () {
      originalXHRSend.call(xhr, originalBody);
    });

    // Don't call originalXHRSend here — it's called in the then/catch above
  };

  // ═══════════════════════════════════════════════════════════════════════
  // FETCH INTERCEPTION (fallback — in case Gemini switches transport)
  // ═══════════════════════════════════════════════════════════════════════

  if (!window.__kytOriginalFetch) window.__kytOriginalFetch = window.fetch;
  const originalFetch = window.__kytOriginalFetch;

  window.fetch = async function (input, init) {
    const url = resolveUrl(typeof input === 'string' ? input : (input instanceof Request ? input.url : String(input)));

    // Only intercept POST to StreamGenerate on gemini.google.com
    const method = (init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
    if (method !== 'POST' || !isGeminiDomain(url) || !isStreamGenerate(url)) {
      return originalFetch.apply(this, arguments);
    }

    // Read body
    let bodyStr = null;
    if (init?.body) {
      bodyStr = await bodyToStringAsync(init.body);
    } else if (input instanceof Request) {
      try {
        const cloned = input.clone();
        bodyStr = await cloned.text();
      } catch (_) {}
    }

    const parseResult = parseFReq(bodyStr);
    if (!parseResult) {
      return originalFetch.apply(this, arguments);
    }

    console.log('📤 KYT Gemini: User message captured via fetch (' + parseResult.userMessage.length + ' chars)');
    dispatchCapture(parseResult.userMessage, 'user', 'fetch', parseResult.conversationId);

    // Context injection
    const formattedContext = await requestContext(parseResult.userMessage);
    let finalInit = init || {};
    if (formattedContext && bodyStr) {
      const modified = reEncodeFReq(bodyStr, formattedContext, parseResult);
      if (modified) {
        console.log('💉 KYT Gemini: Context injected into fetch request');
        finalInit = { ...finalInit, body: modified };
      }
    }

    // Send the (possibly modified) request
    const response = await originalFetch.call(this, input, finalInit);

    // Capture assistant response (non-blocking)
    const conversationId = parseResult.conversationId;
    try {
      const cloned = response.clone();
      const responseText = await cloned.text();
      if (responseText) {
        const assistantText = extractAssistantResponse(responseText);
        if (assistantText) {
          console.log('📥 KYT Gemini: Assistant response captured via fetch (' + assistantText.length + ' chars)');
          dispatchCapture(assistantText, 'assistant', 'fetch', conversationId);
        }
      }
    } catch (e) { /* non-fatal */ }

    return response;
  };

  // ═══════════════════════════════════════════════════════════════════════
  // DIAGNOSTICS — Exposed for KYT_DEBUG
  // ═══════════════════════════════════════════════════════════════════════

  window.__kytGeminiStats = function () {
    return {
      deduplicator: deduplicator.getStats(),
      pendingContextRequests: pendingContextRequests.size,
    };
  };

  console.log('✅ KYT Gemini: inject.js loaded (live-capture only, no history interception)');
})();
