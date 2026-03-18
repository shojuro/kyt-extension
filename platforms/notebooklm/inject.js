/**
 * KYT Memory Extension — NotebookLM Inject Script (MAIN World)
 *
 * Runs in page context to intercept XHR/fetch for:
 * 1. GenerateFreeFormStreamed — live Q&A (user asks, NotebookLM answers with citations)
 * 2. batchexecute — notebook operations (for context, not captured)
 *
 * Architecture:
 *   MAIN world (this file) → CustomEvent → ISOLATED world (content.js) → chrome.runtime → background.js
 *
 * Safety:
 *   - Minimal footprint: capture only, no UI, no DOM mutation
 *   - Only intercepts NotebookLM streaming endpoint
 *   - Page JS cannot access extension APIs through this script
 */

(function () {
  'use strict';

  // Injection guard
  if (window.__kytNotebookLMInjected) return;
  window.__kytNotebookLMInjected = true;

  // ═══════════════════════════════════════════════════════════════════════
  // DEDUPLICATOR — Inlined (MAIN world can't use ES imports)
  // ═══════════════════════════════════════════════════════════════════════

  class MessageDeduplicator {
    constructor() {
      this.recentHashes = new Map();
      this.dedupeWindow = 8000;
      this.maxSize = 500;
      this.cleanupInterval = setInterval(() => this._cleanup(), 5000);
    }

    shouldCapture(content) {
      if (!content || typeof content !== 'string') return true;
      const hash = this._hash(content.trim().replace(/\s+/g, ' ').toLowerCase());
      const now = Date.now();
      if (this.recentHashes.has(hash)) {
        const last = this.recentHashes.get(hash);
        if (now - last < this.dedupeWindow) return false;
      }
      if (this.recentHashes.size >= this.maxSize) {
        const oldest = this.recentHashes.keys().next().value;
        this.recentHashes.delete(oldest);
      }
      this.recentHashes.set(hash, now);
      return true;
    }

    _hash(s) {
      let h = 0x811c9dc5;
      for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
      }
      return (h >>> 0).toString(16);
    }

    _cleanup() {
      const cutoff = Date.now() - this.dedupeWindow;
      for (const [k, v] of this.recentHashes) {
        if (v < cutoff) this.recentHashes.delete(k);
      }
    }
  }

  const deduplicator = new MessageDeduplicator();

  // Debug gate
  const _debug = () => {
    try { return localStorage.getItem('KYT_NLM_DEBUG') === '1'; } catch { return false; }
  };

  // ═══════════════════════════════════════════════════════════════════════
  // URL HELPERS
  // ═══════════════════════════════════════════════════════════════════════

  function resolveUrl(url) {
    try { return new URL(url, window.location.origin).href; } catch { return url; }
  }

  function isNLMDomain(url) {
    try { return new URL(resolveUrl(url)).hostname === 'notebooklm.google.com'; } catch { return false; }
  }

  function isStreamingEndpoint(url) {
    return resolveUrl(url).includes('GenerateFreeFormStreamed');
  }

  // Extract notebook ID from URL path: /notebook/{id}
  function getNotebookIdFromUrl() {
    const match = window.location.pathname.match(/\/notebook\/([^/]+)/);
    return match ? match[1] : null;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // BODY PARSING — Extract user question from streaming request
  // ═══════════════════════════════════════════════════════════════════════

  function bodyToString(body) {
    if (typeof body === 'string') return body;
    if (body instanceof URLSearchParams) return body.toString();
    if (body instanceof ArrayBuffer || body instanceof Uint8Array) {
      try { return new TextDecoder('utf-8').decode(body); } catch { return null; }
    }
    return null;
  }

  /**
   * Extract the user's question from a streaming request body.
   * Body format: f.req=[null, paramsJson]&at=...
   * paramsJson[1] = question string
   */
  function extractQuestion(bodyStr) {
    if (!bodyStr) return null;
    try {
      const params = new URLSearchParams(bodyStr);
      const fReq = params.get('f.req');
      if (!fReq) return null;
      const outer = JSON.parse(fReq);
      // outer = [null, paramsJson]
      if (!Array.isArray(outer) || !outer[1]) return null;
      const inner = JSON.parse(outer[1]);
      // inner[1] = question string
      if (Array.isArray(inner) && typeof inner[1] === 'string' && inner[1].length > 0) {
        return inner[1];
      }
    } catch { /* parse failure — not a streaming request */ }
    return null;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // RESPONSE PARSING — Extract answer from streaming response
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Parse chunked streaming response.
   * Format: )]}'\n followed by <byteCount>\n<JSON>\n pairs.
   */
  function parseStreamingResponse(responseText) {
    let text = responseText;
    if (text.startsWith(")]}'")) text = text.slice(text.indexOf('\n') + 1);

    const chunks = [];
    let pos = 0;

    while (pos < text.length) {
      while (pos < text.length && '\n\r '.includes(text[pos])) pos++;
      if (pos >= text.length) break;

      let numStr = '';
      while (pos < text.length && text[pos] >= '0' && text[pos] <= '9') { numStr += text[pos]; pos++; }
      if (!numStr) break;

      const byteCount = parseInt(numStr, 10);
      if (isNaN(byteCount) || byteCount <= 0) break;
      if (text[pos] === '\n') pos++;

      const remaining = text.slice(pos);
      const encoded = new TextEncoder().encode(remaining);
      const chunkBytes = encoded.slice(0, byteCount);
      const chunkText = new TextDecoder().decode(chunkBytes).trim();
      pos += new TextDecoder().decode(chunkBytes).length;

      try { chunks.push(JSON.parse(chunkText)); } catch { /* skip */ }
    }

    return chunks;
  }

  /**
   * Extract the answer text from parsed streaming chunks.
   * Walks wrb.fr frames looking for the longest string > 20 chars.
   */
  function extractAnswer(chunks) {
    let best = '';

    for (const chunk of chunks) {
      if (!Array.isArray(chunk)) continue;
      for (const item of chunk) {
        if (!Array.isArray(item) || item[0] !== 'wrb.fr') continue;
        const data = item[2];
        if (!data) continue;
        let parsed = data;
        if (typeof parsed === 'string') {
          try { parsed = JSON.parse(parsed); } catch { continue; }
        }
        const found = findLongestString(parsed, 0);
        if (found && found.length > best.length) best = found;
      }
    }

    return best.trim();
  }

  function findLongestString(obj, depth) {
    if (depth > 10) return '';
    if (typeof obj === 'string' && obj.length > 20) return obj;
    let best = '';
    if (Array.isArray(obj)) {
      for (const item of obj) {
        const found = findLongestString(item, depth + 1);
        if (found.length > best.length) best = found;
      }
    }
    return best;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // DISPATCH — Send captured message to ISOLATED world via CustomEvent
  // ═══════════════════════════════════════════════════════════════════════

  function dispatchCapture(content, role, captureMethod) {
    if (!content || typeof content !== 'string' || content.trim().length < 5) return;

    const cleaned = content.trim()
      .replace(/\n{3,}/g, '\n\n')
      .replace(/\s{20,}/g, ' ');

    if (!deduplicator.shouldCapture(cleaned)) return;

    const notebookId = getNotebookIdFromUrl();

    window.dispatchEvent(new CustomEvent('KYT_MESSAGE_CAPTURED', {
      detail: {
        content: cleaned,
        role: role,
        platform: 'notebooklm',
        conversationId: notebookId ? 'nlm-' + notebookId : null,
        timestamp: Date.now(),
        messageId: 'nlm_' + Date.now() + '_' + Math.random().toString(36).slice(2, 9),
        captureMethod: captureMethod,
        url: window.location.href,
      }
    }));

    _debug() && console.log('📥 KYT NLM: Captured ' + role + ' (' + cleaned.length + ' chars, ' + captureMethod + ')');
  }

  // ═══════════════════════════════════════════════════════════════════════
  // XHR INTERCEPTION — NotebookLM uses XHR for streaming Q&A
  // ═══════════════════════════════════════════════════════════════════════

  const originalXHROpen = XMLHttpRequest.prototype.open;
  const originalXHRSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    this.__kytMethod = method;
    this.__kytUrl = resolveUrl(url);
    return originalXHROpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function (body) {
    if (this.__kytMethod !== 'POST' || !isNLMDomain(this.__kytUrl)) {
      return originalXHRSend.apply(this, arguments);
    }

    // Only intercept streaming Q&A endpoint
    if (!isStreamingEndpoint(this.__kytUrl)) {
      return originalXHRSend.apply(this, arguments);
    }

    // Capture user question from request body
    const bodyStr = bodyToString(body);
    const question = extractQuestion(bodyStr);
    if (question) {
      dispatchCapture('User: ' + question, 'user', 'xhr');
    }

    // Capture assistant answer from response
    this.addEventListener('load', function () {
      try {
        const rt = this.responseText;
        if (!rt || rt.length < 50) return;

        const chunks = parseStreamingResponse(rt);
        const answer = extractAnswer(chunks);
        if (answer && answer.length > 20) {
          dispatchCapture('Assistant: ' + answer, 'assistant', 'xhr-response');
        }
      } catch (err) {
        _debug() && console.error('❌ KYT NLM: Error parsing XHR response:', err.message);
      }
    });

    return originalXHRSend.apply(this, arguments);
  };

  // ═══════════════════════════════════════════════════════════════════════
  // FETCH INTERCEPTION — Fallback (some requests may use fetch)
  // ═══════════════════════════════════════════════════════════════════════

  const originalFetch = window.fetch;

  window.fetch = async function (input, init) {
    const url = resolveUrl(typeof input === 'string' ? input : input?.url || '');

    if (!isNLMDomain(url) || !isStreamingEndpoint(url)) {
      return originalFetch.apply(this, arguments);
    }

    // Capture question
    const bodyStr = bodyToString(init?.body);
    const question = extractQuestion(bodyStr);
    if (question) {
      dispatchCapture('User: ' + question, 'user', 'fetch');
    }

    // Call original and capture response
    const response = await originalFetch.apply(this, arguments);
    const cloned = response.clone();

    cloned.text().then(text => {
      if (!text || text.length < 50) return;
      const chunks = parseStreamingResponse(text);
      const answer = extractAnswer(chunks);
      if (answer && answer.length > 20) {
        dispatchCapture('Assistant: ' + answer, 'assistant', 'fetch-response');
      }
    }).catch(() => { /* best-effort */ });

    return response;
  };

  // ═══════════════════════════════════════════════════════════════════════
  // STATS EXPOSURE
  // ═══════════════════════════════════════════════════════════════════════

  window.__kytNotebookLMStats = function () {
    return {
      injected: true,
      notebookId: getNotebookIdFromUrl(),
      deduplicator: {
        mapSize: deduplicator.recentHashes.size,
      },
    };
  };

  console.log('✅ KYT NotebookLM: inject.js loaded — intercepting streaming Q&A');
})();
