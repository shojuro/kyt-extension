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
  // DOM OBSERVER — Deferred capture for assistant responses
  // ═══════════════════════════════════════════════════════════════════════
  //
  // Lesson from Gemini: streaming wire responses come in incremental frames
  // that are unreliable to parse. The wire intercept tells us "a response is
  // happening" — the DOM tells us what it actually says once rendering is done.
  //
  // Strategy: XHR captures user question (from request body — always clean).
  // For assistant response, XHR triggers the DOM observer instead of parsing
  // the wire. Observer watches the rendered answer, waits for it to stabilize
  // (no new text for STABLE_DELAY_MS), then scrapes.

  // WeakSet of already-captured response elements — prevents re-scrape
  const capturedElements = new WeakSet();

  // Selectors for NotebookLM's answer container (may change as Google updates UI)
  const RESPONSE_SELECTORS = [
    '.response-container',
    '[data-response-id]',
    '.chat-response',
    '.model-response',
    'message-content',
  ];

  const responseDOMObserver = {
    observer: null,
    pendingConvId: null,
    lastTextLength: 0,
    stableTimeoutId: null,
    STABLE_DELAY_MS: 3000,
    MAX_WAIT_MS: 120000,
    maxWaitTimeoutId: null,
    _baselineElement: null,

    _findLastResponseElement() {
      // Try specific selectors first
      for (const selector of RESPONSE_SELECTORS) {
        try {
          const elements = document.querySelectorAll(selector);
          if (elements.length > 0) return elements[elements.length - 1];
        } catch { /* invalid selector */ }
      }
      // Fallback: find the last element with substantial text near the chat area
      return null;
    },

    start(conversationId) {
      this._flushPending();
      this.stop();
      this.pendingConvId = conversationId;
      this.lastTextLength = 0;
      this._baselineElement = this._findLastResponseElement();

      const target = document.querySelector('main') || document.body;
      this.observer = new MutationObserver((mutations) => this._onMutation(mutations));
      this.observer.observe(target, {
        childList: true, subtree: true, characterData: true,
        attributes: true, attributeFilter: ['aria-busy'],
      });

      // Safety: max wait to prevent leaking observers
      this.maxWaitTimeoutId = setTimeout(() => {
        _debug() && console.log('⏰ KYT NLM: DOM observer max wait reached, flushing');
        this._flushPending();
        this.stop();
      }, this.MAX_WAIT_MS);

      _debug() && console.log('👁️ KYT NLM: DOM observer started for response capture');
    },

    _onMutation(mutations) {
      // Fast path: aria-busy="false" = Google says streaming done
      if (mutations) {
        for (const m of mutations) {
          if (m.type === 'attributes' && m.attributeName === 'aria-busy') {
            if (m.target.getAttribute('aria-busy') === 'false' && m.target !== this._baselineElement) {
              if (this.lastTextLength === 0) this.lastTextLength = 1;
              if (this.stableTimeoutId) clearTimeout(this.stableTimeoutId);
              this.stableTimeoutId = setTimeout(() => this._onStable(), 500);
              return;
            }
          }
        }
      }

      // Debounce path: text is growing, wait for it to stop
      const text = this._getLatestResponseText();
      if (!text || text.length <= this.lastTextLength) return;
      this.lastTextLength = text.length;

      if (this.stableTimeoutId) clearTimeout(this.stableTimeoutId);
      this.stableTimeoutId = setTimeout(() => this._onStable(), this.STABLE_DELAY_MS);
    },

    _getLatestResponseText() {
      for (const selector of RESPONSE_SELECTORS) {
        try {
          const elements = document.querySelectorAll(selector);
          if (elements.length > 0) {
            const last = elements[elements.length - 1];
            if (last === this._baselineElement) continue;
            if (capturedElements.has(last)) continue;
            const clone = last.cloneNode(true);
            clone.querySelectorAll('button, [role="button"], .action-bar, .toolbar').forEach(el => el.remove());
            const text = clone.innerText?.trim();
            if (text && text.length > 20) return text;
          }
        } catch { /* skip */ }
      }
      return null;
    },

    _onStable() {
      if (this.lastTextLength === 0) return;
      const text = this._getLatestResponseText();
      if (!text || text.length < 20) { this.stop(); return; }

      // Mark element as captured
      const el = this._findLastResponseElement();
      if (el && el !== this._baselineElement) capturedElements.add(el);

      _debug() && console.log('📥 KYT NLM: DOM response captured (' + text.length + ' chars)');
      dispatchCapture('Assistant: ' + text, 'assistant', 'dom-observer');
      this.stop();
    },

    _flushPending() {
      if (!this.pendingConvId || this.lastTextLength === 0) return;
      const text = this._getLatestResponseText();
      if (!text || text.length < 20) return;

      const el = this._findLastResponseElement();
      if (el && el !== this._baselineElement) capturedElements.add(el);

      _debug() && console.log('📥 KYT NLM: DOM response flushed (' + text.length + ' chars)');
      dispatchCapture('Assistant: ' + text, 'assistant', 'dom-observer');
    },

    stop() {
      if (this.observer) { this.observer.disconnect(); this.observer = null; }
      if (this.stableTimeoutId) { clearTimeout(this.stableTimeoutId); this.stableTimeoutId = null; }
      if (this.maxWaitTimeoutId) { clearTimeout(this.maxWaitTimeoutId); this.maxWaitTimeoutId = null; }
      this.pendingConvId = null;
      this.lastTextLength = 0;
      this._baselineElement = null;
    },
  };

  // Safety nets: flush on leave
  window.addEventListener('beforeunload', () => responseDOMObserver._flushPending());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') responseDOMObserver._flushPending();
  });

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

    // Capture user question from request body (always clean — it's our own request)
    const bodyStr = bodyToString(body);
    const question = extractQuestion(bodyStr);
    const notebookId = getNotebookIdFromUrl();
    const convId = notebookId ? 'nlm-' + notebookId : null;

    if (question) {
      dispatchCapture('User: ' + question, 'user', 'xhr');
      // Start DOM observer for the response — deferred capture is the primary path
      responseDOMObserver.start(convId);
    }

    // Wire fallback: if DOM observer doesn't fire (selectors miss), try parsing the response
    this.addEventListener('load', function () {
      // Signal DOM observer that streaming is done — it will capture from DOM
      responseDOMObserver._onMutation && responseDOMObserver._onMutation(null);

      // Only fall back to wire parsing if DOM observer hasn't captured yet
      setTimeout(() => {
        if (responseDOMObserver.lastTextLength > 0) return; // DOM observer got it

        try {
          const rt = this.responseText;
          if (!rt || rt.length < 50) return;

          const chunks = parseStreamingResponse(rt);
          const answer = extractAnswer(chunks);
          if (answer && answer.length > 20) {
            _debug() && console.log('📥 KYT NLM: Wire fallback captured response (' + answer.length + ' chars)');
            dispatchCapture('Assistant: ' + answer, 'assistant', 'xhr-response');
            responseDOMObserver.stop(); // Don't double-capture
          }
        } catch (err) {
          _debug() && console.error('❌ KYT NLM: Wire fallback error:', err.message);
        }
      }, 1500); // Give DOM observer 1.5s head start
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
    const nbId = getNotebookIdFromUrl();
    const fetchConvId = nbId ? 'nlm-' + nbId : null;

    if (question) {
      dispatchCapture('User: ' + question, 'user', 'fetch');
      responseDOMObserver.start(fetchConvId);
    }

    // Call original and wire fallback
    const response = await originalFetch.apply(this, arguments);
    const cloned = response.clone();

    cloned.text().then(text => {
      // Signal DOM observer
      responseDOMObserver._onMutation && responseDOMObserver._onMutation(null);

      // Wire fallback after 1.5s if DOM observer didn't capture
      setTimeout(() => {
        if (responseDOMObserver.lastTextLength > 0) return;
        if (!text || text.length < 50) return;
        const chunks = parseStreamingResponse(text);
        const answer = extractAnswer(chunks);
        if (answer && answer.length > 20) {
          _debug() && console.log('📥 KYT NLM: Fetch wire fallback (' + answer.length + ' chars)');
          dispatchCapture('Assistant: ' + answer, 'assistant', 'fetch-response');
          responseDOMObserver.stop();
        }
      }, 1500);
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
