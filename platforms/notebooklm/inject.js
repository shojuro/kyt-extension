/**
 * KYT Memory Extension — NotebookLM Inject Script (MAIN World)
 *
 * Capture model: SCREEN IS SHORT-TERM MEMORY, K.Y.T. IS LONG-TERM MEMORY.
 *
 * The user reads the response on screen for 20-30 seconds before typing their
 * next question. That's our capture window — not 200ms, not 3s. We don't race
 * to parse streaming wire frames. We wait for the user to move on, then scrape
 * what they were just looking at from the fully-rendered DOM.
 *
 * Primary capture path:
 *   User sends NEXT question → scrapeAllUncaptured() → captures PREVIOUS response
 *   The previous response has been on screen the whole time. It's complete.
 *
 * Secondary (DOM observer):
 *   Catches the response mid-conversation for single-turn sessions where
 *   there's no "next question" trigger. Not the primary path.
 *
 * Safety nets:
 *   - visibilitychange (tab switch) → scrape uncaptured
 *   - beforeunload (close/navigate) → scrape uncaptured
 *   - 60s periodic sweep → catch anything missed
 *
 * User questions: parsed from XHR/fetch request body (always clean, it's OUR request).
 * Assistant responses: scraped from rendered DOM (never parsed from streaming wire).
 *
 * Architecture:
 *   MAIN world (this file) → CustomEvent → ISOLATED world (content.js) → chrome.runtime → background.js
 */

(function () {
  'use strict';

  if (window.__kytNotebookLMInjected) return;
  window.__kytNotebookLMInjected = true;

  // ═══════════════════════════════════════════════════════════════════════
  // DEDUPLICATOR
  // ═══════════════════════════════════════════════════════════════════════

  class MessageDeduplicator {
    constructor() {
      this.recentHashes = new Map();
      this.dedupeWindow = 10000;
      this.maxSize = 500;
      this.cleanupInterval = setInterval(() => this._cleanup(), 10000);
    }

    shouldCapture(content) {
      if (!content || typeof content !== 'string') return true;
      const hash = this._hash(content.trim().replace(/\s+/g, ' ').toLowerCase());
      const now = Date.now();
      if (this.recentHashes.has(hash)) {
        if (now - this.recentHashes.get(hash) < this.dedupeWindow) return false;
      }
      if (this.recentHashes.size >= this.maxSize) {
        this.recentHashes.delete(this.recentHashes.keys().next().value);
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

  const _debug = () => {
    try { return localStorage.getItem('KYT_NLM_DEBUG') === '1'; } catch { return false; }
  };

  // ═══════════════════════════════════════════════════════════════════════
  // URL + BODY HELPERS
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

  function getNotebookIdFromUrl() {
    const match = window.location.pathname.match(/\/notebook\/([^/]+)/);
    return match ? match[1] : null;
  }

  function bodyToString(body) {
    if (typeof body === 'string') return body;
    if (body instanceof URLSearchParams) return body.toString();
    if (body instanceof ArrayBuffer || body instanceof Uint8Array) {
      try { return new TextDecoder('utf-8').decode(body); } catch { return null; }
    }
    return null;
  }

  /**
   * Extract user question from streaming request body.
   * f.req=[null, paramsJson] → paramsJson[1] = question
   */
  function extractQuestion(bodyStr) {
    if (!bodyStr) return null;
    try {
      const params = new URLSearchParams(bodyStr);
      const fReq = params.get('f.req');
      if (!fReq) return null;
      const outer = JSON.parse(fReq);
      if (!Array.isArray(outer) || !outer[1]) return null;
      const inner = JSON.parse(outer[1]);
      if (Array.isArray(inner) && typeof inner[1] === 'string' && inner[1].length > 0) {
        return inner[1];
      }
    } catch { /* not a streaming request */ }
    return null;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // DOM SCRAPING — The source of truth for response content
  // ═══════════════════════════════════════════════════════════════════════

  // WeakSet: each response element is captured at most once
  const capturedElements = new WeakSet();

  // Selectors for NotebookLM response containers.
  // Multiple selectors for resilience — Google may change the UI.
  const RESPONSE_SELECTORS = [
    '.response-container',
    '[data-response-id]',
    '.chat-response',
    '.model-response',
    'message-content',
  ];

  /**
   * Extract clean text from a response element.
   * Clones the node, strips UI chrome, returns innerText.
   */
  function scrapeResponseText(el) {
    if (!el) return null;
    try {
      const clone = el.cloneNode(true);
      // Strip buttons, toolbars, action bars — anything that isn't the answer text
      clone.querySelectorAll(
        'button, [role="button"], .action-bar, .toolbar, .response-actions, ' +
        '.export-button, .copy-button, .share-button, .citation-tooltip'
      ).forEach(e => e.remove());
      const text = clone.innerText?.trim();
      return (text && text.length > 20) ? text : null;
    } catch { return null; }
  }

  /**
   * PRIMARY CAPTURE: Scrape all uncaptured response elements from the DOM.
   *
   * Called when:
   * 1. User sends their NEXT question (previous response has been on screen 20-30s)
   * 2. User switches tabs (visibilitychange)
   * 3. User leaves page (beforeunload)
   * 4. Periodic sweep (every 60s)
   *
   * Each element is captured at most once (WeakSet tracking).
   */
  function scrapeAllUncaptured(conversationId) {
    for (const selector of RESPONSE_SELECTORS) {
      try {
        const elements = document.querySelectorAll(selector);
        for (const el of elements) {
          if (capturedElements.has(el)) continue;

          const text = scrapeResponseText(el);
          if (!text) continue;

          capturedElements.add(el);
          dispatchCapture('Assistant: ' + text, 'assistant', 'deferred-dom', conversationId);

          _debug() && console.log('📸 KYT NLM: Deferred capture (' + text.length + ' chars)');
        }
      } catch { /* selector may be invalid in future UI versions */ }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // DOM OBSERVER — Secondary capture for mid-conversation
  // ═══════════════════════════════════════════════════════════════════════
  //
  // Handles: single-turn sessions, last response before close, long pauses.
  // NOT the primary capture path — scrapeAllUncaptured on next turn is.

  const responseDOMObserver = {
    observer: null,
    pendingConvId: null,
    lastTextLength: 0,
    stableTimeoutId: null,
    STABLE_DELAY_MS: 8000, // 8 seconds — no rush, content is on screen
    MAX_WAIT_MS: 120000,
    maxWaitTimeoutId: null,
    _baselineElement: null,

    _findLastResponseElement() {
      for (const selector of RESPONSE_SELECTORS) {
        try {
          const elements = document.querySelectorAll(selector);
          if (elements.length > 0) return elements[elements.length - 1];
        } catch { /* skip */ }
      }
      return null;
    },

    start(conversationId) {
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

      this.maxWaitTimeoutId = setTimeout(() => {
        this._flush();
        this.stop();
      }, this.MAX_WAIT_MS);

      _debug() && console.log('👁️ KYT NLM: DOM observer started (secondary, 8s stabilization)');
    },

    _onMutation(mutations) {
      // aria-busy="false" fast path
      if (mutations) {
        for (const m of mutations) {
          if (m.type === 'attributes' && m.attributeName === 'aria-busy' &&
              m.target.getAttribute('aria-busy') === 'false' && m.target !== this._baselineElement) {
            if (this.lastTextLength === 0) this.lastTextLength = 1;
            if (this.stableTimeoutId) clearTimeout(this.stableTimeoutId);
            this.stableTimeoutId = setTimeout(() => this._onStable(), 2000);
            return;
          }
        }
      }

      // Text growth debounce
      const el = this._findLastResponseElement();
      if (!el || el === this._baselineElement || capturedElements.has(el)) return;
      const text = scrapeResponseText(el);
      if (!text || text.length <= this.lastTextLength) return;
      this.lastTextLength = text.length;

      if (this.stableTimeoutId) clearTimeout(this.stableTimeoutId);
      this.stableTimeoutId = setTimeout(() => this._onStable(), this.STABLE_DELAY_MS);
    },

    _onStable() {
      if (this.lastTextLength === 0) return;
      const el = this._findLastResponseElement();
      if (!el || el === this._baselineElement || capturedElements.has(el)) { this.stop(); return; }
      const text = scrapeResponseText(el);
      if (!text) { this.stop(); return; }

      capturedElements.add(el);
      dispatchCapture('Assistant: ' + text, 'assistant', 'dom-observer', this.pendingConvId);
      _debug() && console.log('📥 KYT NLM: DOM observer captured (' + text.length + ' chars)');
      this.stop();
    },

    _flush() {
      if (!this.pendingConvId || this.lastTextLength === 0) return;
      const el = this._findLastResponseElement();
      if (!el || el === this._baselineElement || capturedElements.has(el)) return;
      const text = scrapeResponseText(el);
      if (!text) return;

      capturedElements.add(el);
      dispatchCapture('Assistant: ' + text, 'assistant', 'dom-observer', this.pendingConvId);
      _debug() && console.log('📥 KYT NLM: DOM observer flushed (' + text.length + ' chars)');
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

  // ═══════════════════════════════════════════════════════════════════════
  // SAFETY NETS — Capture on leave/hide/periodic
  // ═══════════════════════════════════════════════════════════════════════

  window.addEventListener('beforeunload', () => {
    responseDOMObserver._flush();
    scrapeAllUncaptured(null);
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      scrapeAllUncaptured(null);
    }
  });

  // Periodic sweep: catches responses the user read but never followed up on
  setInterval(() => {
    scrapeAllUncaptured(null);
  }, 60000);

  // ═══════════════════════════════════════════════════════════════════════
  // DISPATCH — Send captured message to ISOLATED world
  // ═══════════════════════════════════════════════════════════════════════

  function dispatchCapture(content, role, captureMethod, conversationId) {
    if (!content || typeof content !== 'string' || content.trim().length < 5) return;

    const cleaned = content.trim()
      .replace(/\n{3,}/g, '\n\n')
      .replace(/\s{20,}/g, ' ');

    if (!deduplicator.shouldCapture(cleaned)) return;

    const notebookId = conversationId || (getNotebookIdFromUrl() ? 'nlm-' + getNotebookIdFromUrl() : null);

    window.dispatchEvent(new CustomEvent('KYT_MESSAGE_CAPTURED', {
      detail: {
        content: cleaned,
        role: role,
        platform: 'notebooklm',
        conversationId: notebookId,
        timestamp: Date.now(),
        messageId: 'nlm_' + Date.now() + '_' + Math.random().toString(36).slice(2, 9),
        captureMethod: captureMethod,
        url: window.location.href,
      }
    }));

    _debug() && console.log('📥 KYT NLM: Dispatched ' + role + ' (' + cleaned.length + ' chars, ' + captureMethod + ')');
  }

  // ═══════════════════════════════════════════════════════════════════════
  // XHR INTERCEPTION
  // ═══════════════════════════════════════════════════════════════════════

  const originalXHROpen = XMLHttpRequest.prototype.open;
  const originalXHRSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    this.__kytMethod = method;
    this.__kytUrl = resolveUrl(url);
    return originalXHROpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function (body) {
    if (this.__kytMethod !== 'POST' || !isNLMDomain(this.__kytUrl) || !isStreamingEndpoint(this.__kytUrl)) {
      return originalXHRSend.apply(this, arguments);
    }

    const bodyStr = bodyToString(body);
    const question = extractQuestion(bodyStr);
    const notebookId = getNotebookIdFromUrl();
    const convId = notebookId ? 'nlm-' + notebookId : null;

    if (question) {
      // === PRIMARY CAPTURE PATH ===
      // User is sending a new question. The previous response has been on screen
      // the entire time they were reading it and composing this question.
      // Scrape it now — it's fully rendered and complete.
      scrapeAllUncaptured(convId);

      // Capture the user's question from the request body (always clean)
      dispatchCapture('User: ' + question, 'user', 'xhr', convId);

      // Start DOM observer for the NEW response (secondary path)
      responseDOMObserver.start(convId);
    }

    // When streaming completes, nudge the observer
    this.addEventListener('load', function () {
      responseDOMObserver._onMutation && responseDOMObserver._onMutation(null);
    }, { once: true });

    return originalXHRSend.apply(this, arguments);
  };

  // ═══════════════════════════════════════════════════════════════════════
  // FETCH INTERCEPTION — Same pattern
  // ═══════════════════════════════════════════════════════════════════════

  const originalFetch = window.fetch;

  window.fetch = async function (input, init) {
    const url = resolveUrl(typeof input === 'string' ? input : input?.url || '');

    if (!isNLMDomain(url) || !isStreamingEndpoint(url)) {
      return originalFetch.apply(this, arguments);
    }

    const bodyStr = bodyToString(init?.body);
    const question = extractQuestion(bodyStr);
    const notebookId = getNotebookIdFromUrl();
    const convId = notebookId ? 'nlm-' + notebookId : null;

    if (question) {
      // Primary: scrape previous response, capture this question
      scrapeAllUncaptured(convId);
      dispatchCapture('User: ' + question, 'user', 'fetch', convId);
      responseDOMObserver.start(convId);
    }

    const response = await originalFetch.apply(this, arguments);

    // Nudge observer when streaming completes
    response.clone().text().then(() => {
      responseDOMObserver._onMutation && responseDOMObserver._onMutation(null);
    }).catch(() => {});

    return response;
  };

  // ═══════════════════════════════════════════════════════════════════════
  // STATS
  // ═══════════════════════════════════════════════════════════════════════

  window.__kytNotebookLMStats = function () {
    return {
      injected: true,
      notebookId: getNotebookIdFromUrl(),
      deduplicator: { mapSize: deduplicator.recentHashes.size },
    };
  };

  console.log('✅ KYT NotebookLM: inject.js loaded — deferred DOM capture (screen = short-term memory)');
})();
