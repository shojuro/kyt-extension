/**
 * KYT Memory Extension - Gemini Content Script (MAIN World)
 *
 * Runs in page context (world: MAIN) to intercept fetch calls
 * and capture Google Gemini message submissions.
 *
 * Gemini uses Google's batchexecute RPC protocol — URL-encoded form data
 * with nested JSON arrays — NOT clean REST JSON like ChatGPT/Claude.
 *
 * Architecture:
 * MAIN world (this file) → CustomEvent → ISOLATED world (content_bridge.js) → chrome.runtime → background.js
 */

// Duplicate injection guard
if (window.KYT_GEMINI_INJECTED) {
  console.log('KYT Gemini: Already injected, skipping duplicate');
} else {
  window.KYT_GEMINI_INJECTED = true;

  console.log('KYT Gemini: Content script loaded in MAIN world at:', new Date().toISOString());

  // === DEDUPLICATION LAYER ===
  // Inlined from Claude's content_test.js — MAIN world can't use ES imports
  class MessageDeduplicator {
    constructor(options = {}) {
      if (options && typeof options !== 'object') {
        options = {};
      }
      this.recentMessages = new Map();
      this.processedMessageIds = new Set();
      this.maxMessageIdSetSize = options.maxMessageIdSetSize || 2000;
      this.dedupeWindow = options.dedupeWindow || 5000;
      this.maxMapSize = options.maxMapSize || 1000;
      this.cleanupInterval = setInterval(() => this.cleanup(), 2000);
      this.stats = {
        totalAttempts: 0,
        captured: 0,
        duplicatesSkipped: 0,
        upgradeCaptures: 0
      };
    }

    shouldCapture(content, captureMethod, messageId = null) {
      // MessageId-first dedup
      if (messageId && typeof messageId === 'string' && messageId.trim()) {
        const cleanId = messageId.trim();
        if (this.processedMessageIds.has(cleanId)) {
          this.stats.duplicatesSkipped++;
          return false;
        }
        this.processedMessageIds.add(cleanId);
        if (this.processedMessageIds.size >= this.maxMessageIdSetSize) {
          const oldest = this.processedMessageIds.values().next().value;
          this.processedMessageIds.delete(oldest);
        }
        this.stats.totalAttempts++;
        this.stats.captured++;
        return true;
      }

      // Content-hash fallback
      if (!content || (typeof content !== 'string' && typeof content !== 'number')) {
        return true; // fail-open
      }
      if (!captureMethod || typeof captureMethod !== 'string') {
        captureMethod = 'unknown';
      }

      this.stats.totalAttempts++;
      const normalized = String(content).trim().replace(/\s+/g, ' ').toLowerCase();
      const hash = this._hash(normalized);
      const now = Date.now();
      const confidence = this._confidence(captureMethod);

      if (this.recentMessages.has(hash)) {
        const last = this.recentMessages.get(hash);
        if (now - last.timestamp < this.dedupeWindow) {
          if (confidence > last.confidence) {
            this.recentMessages.set(hash, { timestamp: now, confidence, captureMethod });
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
      this.recentMessages.set(hash, { timestamp: now, confidence, captureMethod });
      this.stats.captured++;
      return true;
    }

    _confidence(method) {
      return { 'fetch': 95, 'dom': 70 }[method] || 50;
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

    cleanup() {
      const cutoff = Date.now() - this.dedupeWindow;
      for (const [hash, entry] of this.recentMessages.entries()) {
        if (!entry || entry.timestamp < cutoff) {
          this.recentMessages.delete(hash);
        }
      }
    }

    getStats() {
      return {
        ...this.stats,
        mapSize: this.recentMessages.size,
        duplicateRate: this.stats.totalAttempts > 0
          ? (this.stats.duplicatesSkipped / this.stats.totalAttempts * 100).toFixed(1) + '%'
          : '0%'
      };
    }

    resetStats() {
      this.stats = { totalAttempts: 0, captured: 0, duplicatesSkipped: 0, upgradeCaptures: 0 };
    }
  }

  window.KYT_Deduplicator = new MessageDeduplicator();

  // === BATCHEXECUTE PARSER ===

  const STREAM_GENERATE_PATH = '/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate';

  /**
   * Parse the f.req payload from batchexecute form data.
   * Handles single and double JSON encoding.
   *
   * @param {string} fReq - Raw f.req value from URLSearchParams
   * @returns {{ userMessage: string, conversationId: string|null, inner: Array }|null}
   */
  function parseFReq(fReq) {
    let outer;
    try {
      outer = JSON.parse(fReq);
    } catch (_) {
      try {
        outer = JSON.parse(JSON.parse(fReq));
      } catch (_2) {
        console.warn('KYT Gemini: Failed to parse f.req');
        return null;
      }
    }

    if (!Array.isArray(outer)) return null;

    // Navigate to inner array
    let inner = outer[0];
    if (Array.isArray(inner) && Array.isArray(inner[0]) && typeof inner[0][0] !== 'string') {
      inner = inner[0];
    }
    if (!Array.isArray(inner)) return null;

    const userMessage = typeof inner[0] === 'string' ? inner[0] : null;

    let conversationId = null;
    try {
      if (Array.isArray(inner[2]) && typeof inner[2][0] === 'string') {
        conversationId = inner[2][0];
      }
    } catch (_) { /* optional */ }

    return { userMessage, conversationId, inner };
  }

  /**
   * Re-encode the f.req payload back into URL-encoded form data.
   * Used by context injection.
   */
  function reEncodeFReq(originalBody, modifiedInner) {
    try {
      const params = new URLSearchParams(originalBody);
      const fReq = params.get('f.req');

      let outer;
      let isDoubleEncoded = false;

      try {
        outer = JSON.parse(fReq);
      } catch (_) {
        outer = JSON.parse(JSON.parse(fReq));
        isDoubleEncoded = true;
      }

      if (Array.isArray(outer[0]) && Array.isArray(outer[0][0]) && typeof outer[0][0][0] !== 'string') {
        outer[0][0] = modifiedInner;
      } else {
        outer[0] = modifiedInner;
      }

      let encoded = JSON.stringify(outer);
      if (isDoubleEncoded) {
        encoded = JSON.stringify(encoded);
      }
      params.set('f.req', encoded);
      return params.toString();
    } catch (error) {
      console.error('KYT Gemini: Failed to re-encode f.req:', error);
      return null;
    }
  }

  // === INJECTION BLOCK STRIPPING ===

  function stripInjectionBlock(content) {
    const hasKYTMarkers = content.includes('[SESSION_CONTEXT]') ||
                          content.includes('[RETRIEVAL_CONTEXT]') ||
                          content.includes('[DATA_PROVENANCE]') ||
                          content.includes('[Retrieved Items]') ||
                          content.includes('K.Y.T.');
    if (!hasKYTMarkers) return content;

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

  // === CONTEXT INJECTION ===

  const pendingContextRequests = new Map();

  function simpleHash(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash) + str.charCodeAt(i);
      hash = hash & hash;
    }
    return hash;
  }

  const inflightContextByHash = new Map();
  const DEDUP_WINDOW_MS = 500;

  function isRecoverableContextError(errorMsg) {
    return typeof errorMsg === 'string' && (
      errorMsg.includes('Extension context invalidated') ||
      errorMsg.includes('Service worker disconnected') ||
      errorMsg.includes('Service worker cooling down')
    );
  }

  // Persistent listener for context responses from bridge
  window.addEventListener('KYT_CONTEXT_RESPONSE', (event) => {
    const { requestId } = event.detail;
    const pending = pendingContextRequests.get(requestId);
    if (!pending) return;

    // Retry once on recoverable errors
    if (!event.detail.success && !pending.retried && isRecoverableContextError(event.detail.error)) {
      pending.retried = true;
      setTimeout(() => {
        if (!pendingContextRequests.has(requestId)) return;
        window.dispatchEvent(new CustomEvent('KYT_CONTEXT_REQUEST', {
          detail: { requestId, userMessage: pending.userMessage, config: pending.config }
        }));
      }, 3000);
      return;
    }

    clearTimeout(pending.timeout);
    pendingContextRequests.delete(requestId);
    inflightContextByHash.delete(pending.messageHash);

    if (event.detail.success && event.detail.formattedContext) {
      console.log('KYT Gemini: Context received, injecting...');
      // Prepend context to user message in the inner array
      const modified = [...pending.inner];
      modified[0] = `${event.detail.formattedContext}\n\n---\n\n${modified[0]}`;
      const reEncoded = reEncodeFReq(pending.originalBody, modified);
      if (reEncoded) {
        pending.resolve(reEncoded);
      } else {
        pending.resolve(pending.originalBody); // fallback
      }
    } else {
      pending.resolve(pending.originalBody);
    }
  });

  /**
   * Request context and inject into Gemini batchexecute body.
   */
  async function getAndInjectContext(bodyString) {
    try {
      const params = new URLSearchParams(bodyString);
      const fReq = params.get('f.req');
      if (!fReq) return bodyString;

      const parsed = parseFReq(fReq);
      if (!parsed || !parsed.userMessage) return bodyString;

      const messageHash = simpleHash(parsed.userMessage);
      const existing = inflightContextByHash.get(messageHash);
      if (existing && (Date.now() - existing.timestamp) < DEDUP_WINDOW_MS) {
        return existing.promise;
      }

      const requestId = `ctx_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

      const promise = new Promise((resolve) => {
        const timeout = setTimeout(() => {
          pendingContextRequests.delete(requestId);
          inflightContextByHash.delete(messageHash);
          console.warn('KYT Gemini: Context timeout after 30s');
          resolve(bodyString);
        }, 30000);

        const contextConfig = {
          threshold: 0.5,
          maxContextItems: 5,
          debugMode: false
        };

        pendingContextRequests.set(requestId, {
          resolve,
          timeout,
          inner: parsed.inner,
          originalBody: bodyString,
          messageHash,
          userMessage: parsed.userMessage,
          config: contextConfig,
        });

        window.dispatchEvent(new CustomEvent('KYT_CONTEXT_REQUEST', {
          detail: { requestId, userMessage: parsed.userMessage, config: contextConfig }
        }));
      });

      inflightContextByHash.set(messageHash, { promise, timestamp: Date.now() });
      return promise;
    } catch (error) {
      console.error('KYT Gemini: Context injection error:', error);
      return bodyString;
    }
  }

  // === RESPONSE CAPTURE (best-effort) ===

  /**
   * Extract assistant text from Gemini's batchexecute response.
   * Response format: anti-XSSI prefix `)]}'\n` followed by length-prefixed
   * frames, each containing a JSON array with nested text.
   */
  async function captureGeminiResponse(response, metadata) {
    try {
      if (!response?.body) return;

      const clone = response.clone();
      const text = await clone.text();

      // Strip anti-XSSI prefix
      let cleaned = text;
      if (cleaned.startsWith(")]}'")) {
        cleaned = cleaned.substring(cleaned.indexOf('\n') + 1);
      }

      // Gemini responses are length-prefixed frames
      // Each frame: number\n[json-array]\n
      // We do a depth-first search for the longest string, which is typically the assistant response
      const assistantText = extractLongestString(cleaned);

      if (!assistantText || assistantText.length < 2) return;

      const cleanedText = stripInjectionBlock(assistantText);
      if (!cleanedText || cleanedText.length < 2) return;

      const assistantMessage = {
        content: cleanedText,
        role: 'assistant',
        conversationId: metadata.conversationId || 'unknown',
        model: 'gemini',
        timestamp: Date.now(),
        messageId: `msg_assistant_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        platform: 'gemini'
      };

      let shouldCapture = true;
      try {
        shouldCapture = window.KYT_Deduplicator.shouldCapture(assistantMessage.content, 'fetch', assistantMessage.messageId);
      } catch (_) { /* fail-open */ }

      if (shouldCapture) {
        window.dispatchEvent(new CustomEvent('KYT_MESSAGE_CAPTURED', {
          detail: assistantMessage
        }));
        console.log('KYT Gemini: Assistant response captured (' + assistantMessage.content.length + ' chars)');
      }
    } catch (error) {
      if (error.name === 'AbortError') return;
      console.error('KYT Gemini: Error capturing response:', error);
    }
  }

  /**
   * Depth-first extraction of the longest string from Gemini's response frames.
   * Parses each JSON frame and walks nested arrays looking for text.
   */
  function extractLongestString(responseText) {
    let longest = '';

    // Try to parse as length-prefixed frames
    const lines = responseText.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || /^\d+$/.test(trimmed)) continue;

      try {
        const parsed = JSON.parse(trimmed);
        const found = findLongestStringInArray(parsed);
        if (found && found.length > longest.length) {
          longest = found;
        }
      } catch (_) {
        // Not valid JSON — skip
      }
    }

    return longest;
  }

  function findLongestStringInArray(arr) {
    if (!Array.isArray(arr)) {
      return typeof arr === 'string' ? arr : '';
    }

    let longest = '';
    for (const item of arr) {
      const found = findLongestStringInArray(item);
      if (found.length > longest.length) {
        longest = found;
      }
    }
    return longest;
  }

  // === FETCH OVERRIDE ===

  if (!window.__kytOriginalFetch) window.__kytOriginalFetch = window.fetch;
  const originalFetch = window.__kytOriginalFetch;

  window.fetch = async function(...args) {
    const [url, options] = args;
    const urlString = typeof url === 'string' ? url : String(url);

    // Only intercept Gemini StreamGenerate calls
    if (!urlString.includes('gemini.google.com') || !urlString.includes(STREAM_GENERATE_PATH)) {
      return originalFetch.apply(this, args);
    }

    if (!options?.body || options.method === 'GET') {
      return originalFetch.apply(this, args);
    }

    console.log('KYT Gemini: Intercepted StreamGenerate request');

    try {
      const bodyString = typeof options.body === 'string' ? options.body : null;

      if (!bodyString) {
        return originalFetch.apply(this, args);
      }

      // Parse the user message from batchexecute body
      const params = new URLSearchParams(bodyString);
      const fReq = params.get('f.req');

      if (!fReq) {
        return originalFetch.apply(this, args);
      }

      const parsed = parseFReq(fReq);
      if (!parsed || !parsed.userMessage) {
        console.warn('KYT Gemini: Could not parse user message from f.req');
        return originalFetch.apply(this, args);
      }

      // Strip injection blocks from content before saving
      const cleanContent = stripInjectionBlock(parsed.userMessage);

      // Build message data
      const messageData = {
        content: cleanContent,
        role: 'user',
        conversationId: parsed.conversationId || 'unknown',
        model: 'gemini',
        timestamp: Date.now(),
        messageId: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        platform: 'gemini'
      };

      // Dedup check
      let shouldCapture = true;
      try {
        shouldCapture = window.KYT_Deduplicator.shouldCapture(messageData.content, 'fetch', messageData.messageId);
      } catch (_) { /* fail-open */ }

      if (shouldCapture) {
        window.dispatchEvent(new CustomEvent('KYT_MESSAGE_CAPTURED', {
          detail: messageData
        }));
        console.log('KYT Gemini: User message captured (' + messageData.content.length + ' chars)');
      }

      // Context injection
      try {
        options.body = await getAndInjectContext(bodyString);
      } catch (error) {
        console.error('KYT Gemini: Context injection failed:', error);
        // Proceed with original body
      }
    } catch (error) {
      console.error('KYT Gemini: Error processing request:', error);
    }

    // Make the actual request
    const response = await originalFetch.apply(this, args);

    // Best-effort response capture
    if (response.ok) {
      const parsed = parseFReq(new URLSearchParams(typeof options?.body === 'string' ? options.body : '').get('f.req') || '');
      captureGeminiResponse(response, {
        conversationId: parsed?.conversationId || 'unknown',
        platform: 'gemini',
        model: 'gemini',
        timestamp: Date.now()
      }).catch(err => {
        console.error('KYT Gemini: Failed to capture response:', err);
      });
    }

    return response;
  };

  // === HEALTH CHECK API ===
  window.KYT_Gemini_Health = {
    getStats: function() {
      return {
        deduplication: window.KYT_Deduplicator.getStats(),
        contextInjection: {
          enabled: true,
          status: 'Context injection ENABLED'
        },
        platform: 'gemini',
        timestamp: Date.now()
      };
    },
    resetStats: function() {
      window.KYT_Deduplicator.resetStats();
    }
  };

  window.getInterceptionStats = function() {
    return window.KYT_Gemini_Health.getStats();
  };

  console.log('KYT Gemini: Fetch wrapper installed - ready to capture messages');
}
