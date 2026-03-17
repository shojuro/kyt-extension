/**
 * KYT Memory Extension — Gemini Inject Script (MAIN World)
 *
 * Runs in page context to intercept XHR/fetch for:
 * 1. StreamGenerate — live messages (user sends + assistant responses)
 * 2. batchexecute history loads — mobile/past conversations opened on web
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
      this.recentPrefixes = new Map(); // prefix hash → { contentHash, length, timestamp }
      this.dedupeWindow = 5000;
      this.maxMapSize = 1000;
      this.prefixLength = 100;
      this.cleanupInterval = setInterval(() => this._cleanup(), 2000);
      this.stats = { totalAttempts: 0, captured: 0, duplicatesSkipped: 0, upgradeCaptures: 0, prefixUpgrades: 0 };
    }

    shouldCapture(content, captureMethod) {
      if (!content || typeof content !== 'string') return true; // fail-open
      this.stats.totalAttempts++;

      const normalized = content.trim().replace(/\s+/g, ' ').toLowerCase();
      const hash = this._hash(normalized);
      const now = Date.now();
      const confidence = captureMethod === 'xhr' || captureMethod === 'xhr-response' || captureMethod === 'fetch' || captureMethod === 'fetch-response' ? 95 : 50;

      // Exact hash check (fast path)
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

      // Prefix check: handles wire+DOM race (truncated vs complete)
      const prefixStr = normalized.slice(0, this.prefixLength);
      const prefixHash = this._hash(prefixStr);
      if (this.recentPrefixes.has(prefixHash)) {
        const prev = this.recentPrefixes.get(prefixHash);
        if (now - prev.timestamp < this.dedupeWindow) {
          if (normalized.length > prev.length) {
            // New content is longer → upgrade (complete replacing truncated)
            this.recentMessages.delete(prev.contentHash);
            this.recentPrefixes.set(prefixHash, { contentHash: hash, length: normalized.length, timestamp: now });
            this._addToMessages(hash, now, confidence);
            this.stats.prefixUpgrades++;
            return true;
          } else {
            // New content is shorter/equal → reject as truncated duplicate
            this.stats.duplicatesSkipped++;
            return false;
          }
        }
      }

      // New entry
      this.recentPrefixes.set(prefixHash, { contentHash: hash, length: normalized.length, timestamp: now });
      this._addToMessages(hash, now, confidence);
      this.stats.captured++;
      return true;
    }

    _addToMessages(hash, timestamp, confidence) {
      if (this.recentMessages.size >= this.maxMapSize) {
        const oldestKey = this.recentMessages.keys().next().value;
        this.recentMessages.delete(oldestKey);
      }
      this.recentMessages.set(hash, { timestamp, confidence });
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
      for (const [hash, entry] of this.recentPrefixes.entries()) {
        if (entry.timestamp < cutoff) this.recentPrefixes.delete(hash);
      }
    }

    getStats() {
      return { ...this.stats, mapSize: this.recentMessages.size, prefixMapSize: this.recentPrefixes.size };
    }
  }

  const deduplicator = new MessageDeduplicator();

  // Debug gate — MAIN world can't access chrome.storage, so use localStorage.
  // Enable via devtools: localStorage.setItem('KYT_GEMINI_DEBUG', '1')
  const _kytDebug = () => {
    try { return localStorage.getItem('KYT_GEMINI_DEBUG') === '1'; } catch { return false; }
  };

  // ═══════════════════════════════════════════════════════════════════════
  // DOM OBSERVER — Captures assistant responses via MutationObserver
  // ═══════════════════════════════════════════════════════════════════════

  const responseDOMObserver = {
    observer: null,
    pendingConvId: null,
    lastTextLength: 0,
    stableTimeoutId: null,
    STABLE_DELAY_MS: 4000,
    MAX_WAIT_MS: 120000,
    startTimeoutId: null,
    _baselineElement: null,

    RESPONSE_SELECTORS: [
      'div[id^="model-response-message-content"]', // Primary: Angular ID prefix (model-response only, confirmed 2026-03)
    ],

    _findLastResponseElement() {
      for (const selector of this.RESPONSE_SELECTORS) {
        const elements = document.querySelectorAll(selector);
        if (elements.length > 0) return elements[elements.length - 1];
      }
      return null;
    },

    start(conversationId) {
      this._flushPending(); // flush previous response before resetting
      this.stop();
      this.pendingConvId = conversationId;
      this.lastTextLength = 0;
      this._baselineElement = this._findLastResponseElement();

      const target = document.querySelector('main') || document.body;

      this.observer = new MutationObserver((mutations) => this._onMutation(mutations));
      this.observer.observe(target, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['aria-busy'] });

      this.startTimeoutId = setTimeout(() => this.stop(), this.MAX_WAIT_MS);

      _kytDebug() && console.log('👁️ KYT Gemini: DOM observer started for response capture');
    },

    _onMutation(mutations) {
      // Fast path: aria-busy="false" means Google says streaming is complete
      // Use 300ms confirmation delay (not instant) — DOM may still be rendering
      if (mutations) {
        for (const m of mutations) {
          if (m.type === 'attributes' && m.attributeName === 'aria-busy') {
            if (m.target.getAttribute('aria-busy') === 'false' && m.target !== this._baselineElement) {
              _kytDebug() && console.log('👁️ KYT Gemini: aria-busy=false detected, confirming in 300ms');
              // Mark as having content so _onStable won't bail on the dedup guard
              if (this.lastTextLength === 0) this.lastTextLength = 1;
              if (this.stableTimeoutId) clearTimeout(this.stableTimeoutId);
              this.stableTimeoutId = setTimeout(() => this._onStable(), 300);
              return;
            }
          }
        }
      }

      // Debounce path (fallback when aria-busy not available)
      const text = this._getLastResponseText();
      if (!text || text.length <= this.lastTextLength) return;

      this.lastTextLength = text.length;

      if (this.stableTimeoutId) clearTimeout(this.stableTimeoutId);
      this.stableTimeoutId = setTimeout(() => this._onStable(), this.STABLE_DELAY_MS);
    },

    _getLastResponseText() {
      for (const selector of this.RESPONSE_SELECTORS) {
        const elements = document.querySelectorAll(selector);
        if (elements.length > 0) {
          const last = elements[elements.length - 1];
          if (last === this._baselineElement) return null; // still the old element
          // Clone and strip UI artifacts before extracting text
          const clone = last.cloneNode(true);
          clone.querySelectorAll('button, [role="button"], .export-button, .action-bar, .response-actions').forEach(el => el.remove());
          const text = clone.innerText?.trim();
          if (text && text.length > 20) return text;
        }
      }
      return null;
    },

    _onStable() {
      if (this.lastTextLength === 0) return; // already flushed
      const text = this._getLastResponseText();
      if (!text || text.length < 20) { this.stop(); return; }

      _kytDebug() && console.log('📥 KYT Gemini: DOM response captured (' + text.length + ' chars, conv=' + (this.pendingConvId || 'unknown') + ')');
      dispatchCapture(text, 'assistant', 'dom-observer', this.pendingConvId);
      this.stop();
    },

    _flushPending() {
      if (!this.pendingConvId || this.lastTextLength === 0) return;
      const text = this._getLastResponseText();
      if (!text || text.length < 20) return;

      _kytDebug() && console.log('📥 KYT Gemini: DOM response flushed (' + text.length + ' chars)');
      dispatchCapture(text, 'assistant', 'dom-observer', this.pendingConvId);
    },

    /**
     * Signal that response streaming is complete (called from XHR load / fetch).
     * Forces a mutation check so the stabilization timer starts from the final state,
     * even if MutationObserver missed the last DOM update.
     */
    notifyResponseComplete() {
      if (!this.observer) return;
      this._onMutation();
    },

    stop() {
      if (this.observer) { this.observer.disconnect(); this.observer = null; }
      if (this.stableTimeoutId) { clearTimeout(this.stableTimeoutId); this.stableTimeoutId = null; }
      if (this.startTimeoutId) { clearTimeout(this.startTimeoutId); this.startTimeoutId = null; }
      this.pendingConvId = null;
      this.lastTextLength = 0;
      this._baselineElement = null;
    }
  };

  window.addEventListener('beforeunload', function () {
    responseDOMObserver._flushPending();
  });

  // ═══════════════════════════════════════════════════════════════════════
  // BATCHEXECUTE PARAMETER SNIFFER — Captures live bl + RPC IDs
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Sniffs batchexecute request parameters from real Gemini traffic.
   * inject.js intercepts ALL XHR/fetch — we watch for batchexecute POSTs
   * and extract the `bl` param (from URL) and RPC IDs (from f.req body).
   *
   * These are exposed via window.__kytGeminiCapturedParams so the
   * history import fetcher can use live values instead of hardcoded ones.
   */
  const capturedParams = {
    bl: null,                    // Latest bl= value from any batchexecute URL
    blCapturedAt: 0,
    at: null,                    // XSRF/anti-forgery token from batchexecute body
    atCapturedAt: 0,
    rpcIds: new Map(),           // rpcId → { lastSeen, responseHint }
    conversationListRpcId: null, // Best-guess RPC for conversation list
    conversationDetailRpcId: null, // Best-guess RPC for conversation detail
  };

  /**
   * Extract bl and RPC IDs from a batchexecute request.
   * Called from both XHR and fetch interceptors on every POST to batchexecute.
   */
  function sniffBatchExecuteParams(urlString, bodyString) {
    try {
      const url = new URL(resolveUrl(urlString));

      // Capture bl parameter from URL query string
      const bl = url.searchParams.get('bl');
      if (bl && bl.length > 10) {
        capturedParams.bl = bl;
        capturedParams.blCapturedAt = Date.now();
      }

      // Extract RPC IDs and XSRF token from f.req body
      if (!bodyString) return;
      let params;
      try { params = new URLSearchParams(bodyString); } catch (_) { return; }

      // Capture `at` XSRF token (Google anti-forgery, required for batchexecute)
      const at = params.get('at');
      if (at && at.length > 5) {
        capturedParams.at = at;
        capturedParams.atCapturedAt = Date.now();
      }

      const fReq = params.get('f.req');
      if (!fReq) return;

      let outer;
      try { outer = JSON.parse(fReq); } catch (_) { return; }
      if (typeof outer === 'string') {
        try { outer = JSON.parse(outer); } catch (_) { return; }
      }

      // StreamGenerate format [null, "..."] — skip, not batchexecute
      if (!Array.isArray(outer) || (outer[0] === null && typeof outer[1] === 'string')) return;

      // batchexecute: [[["rpcId", "args", null, "generic"], ...]]
      if (!Array.isArray(outer[0])) return;

      for (const rpc of outer[0]) {
        if (!Array.isArray(rpc) || typeof rpc[0] !== 'string') continue;
        const rpcId = rpc[0];
        const rpcArgs = typeof rpc[1] === 'string' ? rpc[1] : '';

        capturedParams.rpcIds.set(rpcId, {
          lastSeen: Date.now(),
          argsPreview: rpcArgs.substring(0, 100),
        });

        // Heuristic: conversation detail RPC has a c_<hex> conversation ID in args
        if (/c_[0-9a-f]{8,}/.test(rpcArgs) && rpcArgs.length < 500) {
          capturedParams.conversationDetailRpcId = rpcId;
        }
      }

      // Also capture rpcids from URL params (Google puts the primary RPC ID there)
      const urlRpcIds = url.searchParams.get('rpcids');
      if (urlRpcIds) {
        for (const id of urlRpcIds.split(',')) {
          const trimmed = id.trim();
          if (trimmed && !SYSTEM_ONLY_RPCS.has(trimmed)) {
            capturedParams.rpcIds.set(trimmed, {
              lastSeen: Date.now(),
              argsPreview: '(from URL rpcids param)',
            });
          }
        }
      }

      // Evict stale RPC entries (>30 min old) and enforce max size
      if (capturedParams.rpcIds.size > 200) {
        const cutoff = Date.now() - 30 * 60 * 1000;
        for (const [id, entry] of capturedParams.rpcIds) {
          if (entry.lastSeen < cutoff) capturedParams.rpcIds.delete(id);
        }
        // Hard cap if still over limit (delete oldest first — Map is insertion-ordered)
        while (capturedParams.rpcIds.size > 200) {
          const oldest = capturedParams.rpcIds.keys().next().value;
          capturedParams.rpcIds.delete(oldest);
        }
      }
    } catch (_) {
      // Non-fatal — sniffing is best-effort
    }
  }

  /**
   * Called when we get a batchexecute response that contains conversation list data.
   * Associates the RPC ID with "conversation list" functionality.
   * Single call site (XHR batchexecute sniffing) — retained for future
   * conversation-list filtering when Gemini surfaces stable RPC IDs.
   */
  function markConversationListRpc(rpcId) {
    if (rpcId) {
      capturedParams.conversationListRpcId = rpcId;
    }
  }

  /**
   * Try to extract the XSRF `at` token from the page's embedded data.
   * Google embeds it as WIZ_global_data.SNlM0e in a <script> tag on page load.
   * This is a fallback for when no batchexecute POST has been intercepted yet.
   */
  function sniffAtTokenFromPage() {
    try {
      // Method 1: WIZ_global_data (used by Gemini/Bard)
      if (window.WIZ_global_data && window.WIZ_global_data.SNlM0e) {
        const at = window.WIZ_global_data.SNlM0e;
        if (at && at.length > 5) {
          capturedParams.at = at;
          capturedParams.atCapturedAt = Date.now();
          return;
        }
      }

      // Method 2: Search page source for SNlM0e pattern
      const scripts = document.querySelectorAll('script[data-id="_gd"]');
      for (const s of scripts) {
        const match = s.textContent.match(/SNlM0e.*?"([^"]+)"/);
        if (match && match[1]) {
          capturedParams.at = match[1];
          capturedParams.atCapturedAt = Date.now();
          return;
        }
      }
    } catch (_) {
      // Non-fatal
    }
  }

  // Try to capture `at` token from page on load (before any batchexecute fires)
  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    sniffAtTokenFromPage();
  } else {
    document.addEventListener('DOMContentLoaded', sniffAtTokenFromPage, { once: true });
  }

  // Expose captured params to tab-fetch queries
  window.__kytGeminiCapturedParams = capturedParams;

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
  // RESPONSE PARSING — Length-prefixed frame parser
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Parse Gemini's length-prefixed streaming format into JSON frames.
   * Each frame is preceded by a decimal UTF-8 byte count on its own line.
   * Uses TextEncoder/TextDecoder to handle multi-byte characters (emoji, CJK, Thai)
   * where UTF-8 byte count !== JS string length.
   */
  function parseLengthPrefixedFrames(text) {
    const frames = [];
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const sourceBytes = encoder.encode(text);
    let pos = 0;

    while (pos < sourceBytes.length) {
      while (pos < sourceBytes.length && (sourceBytes[pos] === 0x0A || sourceBytes[pos] === 0x0D)) pos++;
      if (pos >= sourceBytes.length) break;

      let numStr = '';
      while (pos < sourceBytes.length && sourceBytes[pos] >= 0x30 && sourceBytes[pos] <= 0x39) {
        numStr += String.fromCharCode(sourceBytes[pos++]);
      }
      if (!numStr) { pos++; continue; }
      const len = parseInt(numStr, 10);
      if (isNaN(len) || len <= 0 || len > 500000) continue;

      // NOTE: Do NOT skip \n here — Google's length prefix INCLUDES
      // the \n before the frame content in its byte count.

      if (pos + len > sourceBytes.length) break;
      const frameBytes = sourceBytes.slice(pos, pos + len);
      const frameStr = decoder.decode(frameBytes).trim();
      pos += len;

      try {
        frames.push(JSON.parse(frameStr));
      } catch (_) {}
    }
    return frames;
  }

  /**
   * Positive signal check: is this string natural language text?
   * Replaces the old isMetadataString negative-filter approach.
   */
  function isNaturalLanguage(str) {
    if (!str || str.length < 20) return false;
    // Must contain spaces (multi-word text)
    const words = str.split(/\s+/).filter(w => w.length > 0);
    if (words.length < 3) return false;
    // Must contain at least one lowercase letter (not ALL-CAPS IDs)
    if (!/[a-z]/.test(str)) return false;
    // Must not start with metadata patterns
    const trimmed = str.trimStart();
    if (/^[\[{]/.test(trimmed) || /^-?\d+$/.test(trimmed)) return false;
    if (/^(c_|r_|rc_|af\.)/.test(trimmed)) return false;
    // Reject strings where URLs dominate (UI metadata like "Personalization in progress<url>")
    const urlMatches = str.match(/https?:\/\/[^\s]+/g) || [];
    const totalUrlLength = urlMatches.reduce((sum, u) => sum + u.length, 0);
    if (totalUrlLength > str.length * 0.5) return false;
    // Reject Gemini UI metadata patterns
    if (/retrieve_personal_data|personalization in progress/i.test(str)) return false;
    // Reject strings where most "words" are camelCase/snake_case identifiers
    const identifiers = words.filter(w => /^[a-z]+[A-Z]|_[a-z]/.test(w));
    if (identifiers.length > words.length * 0.5) return false;
    return true;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // HISTORY-LOAD DETECTION & EXTRACTION
  // ═══════════════════════════════════════════════════════════════════════

  // Known system-only RPCs — never carry conversation history
  const SYSTEM_ONLY_RPCS = new Set([
    'L5adhe', 'GPRiHf', 'bYBfhb', 'aKUX7e', 'LCWRX',
    'jQ1olc', 'MkEWBc', 'ESY5D', 'otAQ7b', 'MaZiqc',
    'aPya6c', 'cYRIkd', 'maGuAc', 'K4WWud', 'ozz5Z',
    'CNgdBe', 'qpEbW', 'o30O0e', 'ku4Jyf', 'DYBcR',
  ]);

  const _capturedConversationIds = new Set();
  const HISTORY_CAPTURE_START = Date.now();
  const HISTORY_CAPTURE_INIT_MS = 5000; // Skip captures during initial page load

  // NOTE: Time-based and ID-based history-load guards were removed (2026-03-17).
  // They caused message DROPS by blocking batchexecute, which is the reliable backup
  // when the DOM observer fails. Doubling is preferable to data loss.
  // TODO: Smart dedup that handles truncated vs complete pairs (prefix matching).

  /**
   * Detect if a POST request is a Gemini conversation-history load (batchexecute).
   * Returns { rpcId, conversationIdHint } or false.
   */
  function isGeminiHistoryLoad(urlString, bodyString) {
    if (!isGeminiDomain(urlString)) return false;
    if (!bodyString || typeof bodyString !== 'string') return false;
    if (!bodyString.includes('f.req=') && !bodyString.includes('f.req%')) return false;

    try {
      const params = new URLSearchParams(bodyString);
      const fReq = params.get('f.req');
      if (!fReq) return false;

      let outer;
      try { outer = JSON.parse(fReq); } catch (_) { return false; }
      if (typeof outer === 'string') {
        try { outer = JSON.parse(outer); } catch (_) { return false; }
      }
      if (!Array.isArray(outer)) return false;

      // StreamGenerate format: [null, "json_payload"] — NOT a history load
      if (outer[0] === null && typeof outer[1] === 'string') return false;

      // batchexecute: [[["rpcId", "jsonArgs", null, "generic"], ...]]
      if (!Array.isArray(outer[0])) return false;

      for (const rpc of outer[0]) {
        if (!Array.isArray(rpc)) continue;
        const rpcId = rpc[0];
        const rpcArgs = rpc[1];
        if (typeof rpcArgs !== 'string') continue;
        if (SYSTEM_ONLY_RPCS.has(rpcId)) continue;

        // Look for conversation ID patterns in args
        const convIdMatch = rpcArgs.match(/"(c_[0-9a-f]{8,})"/) ||
                            rpcArgs.match(/"([0-9a-f]{20,})"/);
        if (convIdMatch && rpcArgs.length <= 2000) {
          return { rpcId, conversationIdHint: convIdMatch[1] };
        }
      }
    } catch (_) {}
    return false;
  }

  /**
   * DFS to collect all strings from a nested structure.
   */
  function findAllStrings(obj, maxDepth = 10) {
    const strings = [];
    function walk(val, depth) {
      if (depth > maxDepth) return;
      if (typeof val === 'string' && val.length > 3) {
        strings.push(val);
      } else if (Array.isArray(val)) {
        for (const item of val) walk(item, depth + 1);
      } else if (val && typeof val === 'object') {
        for (const v of Object.values(val)) walk(v, depth + 1);
      }
    }
    walk(obj, 0);
    return strings.sort((a, b) => b.length - a.length);
  }

  /**
   * Extract conversation messages from a Gemini batchexecute history-load response.
   * Parses wrb.fr frames → double-encoded JSON → conversation turn structure.
   */
  function extractConversationMessages(responseText) {
    if (!responseText || typeof responseText !== 'string') return [];

    // Strip anti-XSSI prefix
    let cleaned = responseText;
    if (cleaned.startsWith(")]}'")) {
      const nlIdx = cleaned.indexOf('\n');
      if (nlIdx >= 0) cleaned = cleaned.substring(nlIdx + 1);
    }

    // Use byte-accurate frame parser
    const frames = parseLengthPrefixedFrames(cleaned);
    let innerConversationData = null;

    for (const frame of frames) {
      if (!Array.isArray(frame)) continue;
      for (const entry of (Array.isArray(frame[0]) ? frame : [frame])) {
        if (!Array.isArray(entry) || entry[0] !== 'wrb.fr') continue;
        if (typeof entry[2] !== 'string') continue;
        try { innerConversationData = JSON.parse(entry[2]); } catch (_) {}
      }
    }

    if (!innerConversationData || !Array.isArray(innerConversationData)) {
      return extractConversationMessagesFallback(frames);
    }

    // Walk conversation turn structure
    const messages = [];
    let turns = innerConversationData;
    // Unwrap: [[turns...]] → [turns...]
    if (Array.isArray(turns[0]) && Array.isArray(turns[0][0]) && Array.isArray(turns[0][0][0])) {
      turns = turns[0];
    }

    for (const turn of turns) {
      if (!Array.isArray(turn)) continue;

      // Probe turn for epoch timestamps (seconds or milliseconds in 2020-2030 range)
      let turnTimestamp = null;
      for (let idx = 0; idx < Math.min(turn.length, 8); idx++) {
        const val = turn[idx];
        if (typeof val === 'number' && val > 1577836800 && val < 1893456000) {
          turnTimestamp = val * 1000; // seconds → ms
          break;
        } else if (typeof val === 'number' && val > 1577836800000 && val < 1893456000000) {
          turnTimestamp = val; // already ms
          break;
        }
      }

      // User message: turn[2][0][0]
      try {
        if (Array.isArray(turn[2]) && Array.isArray(turn[2][0])) {
          const userText = turn[2][0][0];
          if (typeof userText === 'string' && userText.trim().length > 0) {
            messages.push({ content: userText.trim(), role: 'user', timestamp: turnTimestamp });
          }
        }
      } catch (_) {}

      // Assistant response: turn[3][0][0][1][0]
      try {
        if (Array.isArray(turn[3]) && Array.isArray(turn[3][0]) && Array.isArray(turn[3][0][0])) {
          const textArr = turn[3][0][0][1];
          if (Array.isArray(textArr) && typeof textArr[0] === 'string' && textArr[0].trim().length > 0) {
            messages.push({ content: textArr[0].trim(), role: 'assistant', timestamp: turnTimestamp });
          }
        }
      } catch (_) {}
    }

    // Last resort: heuristic string extraction
    if (messages.length === 0) {
      return extractConversationMessagesFallback(frames, innerConversationData);
    }

    return messages;
  }

  /**
   * Fallback: extract messages by finding all long natural-language strings.
   */
  function extractConversationMessagesFallback(frames, innerData) {
    const allStrs = innerData
      ? findAllStrings(innerData, 20)
      : frames.flatMap(f => findAllStrings(f, 15));

    const contentStrs = allStrs.filter(s => {
      if (s.length < 20) return false;
      if (/^(r_|rc_|c_|af\.)/.test(s)) return false;
      if (/^[0-9a-f]{16,}$/i.test(s)) return false;
      if (/^https?:\/\//.test(s)) return false;
      if (/^[A-Za-z0-9+/=]{40,}$/.test(s)) return false;
      return isNaturalLanguage(s);
    });

    const messages = [];
    const seen = new Set();
    for (let i = 0; i < contentStrs.length; i++) {
      const t = contentStrs[i].trim();
      if (seen.has(t)) continue;
      seen.add(t);
      messages.push({ content: t, role: i % 2 === 0 ? 'user' : 'assistant' });
    }
    return messages;
  }

  /**
   * Extract assistant text from a StreamGenerate XHR/fetch response.
   * StreamGenerate sends progressive frames where each contains full text so far —
   * the longest natural-language string across all frames is the complete response.
   * Returns the extracted text or null if nothing usable found.
   */
  function extractAssistantFromStreamGenerate(responseText) {
    if (!responseText || responseText.length < 50) return null;

    // Strip anti-XSSI prefix
    let text = responseText;
    if (text.startsWith(')]}\'\n')) text = text.slice(5);
    else if (text.startsWith(')]}\'')) text = text.slice(4);

    const frames = parseLengthPrefixedFrames(text);
    if (frames.length === 0) return null;

    let longest = null;
    let longestLen = 0;

    for (const frame of frames) {
      const strings = findAllStrings(frame, 10);
      for (const s of strings) {
        if (s.length < 20) continue;
        if (s.length <= longestLen) continue;
        if (!isNaturalLanguage(s)) continue;
        // Skip strings that look like system IDs or metadata
        if (/^(r_|rc_|c_|af\.)/.test(s)) continue;
        if (/^[0-9a-f]{16,}$/i.test(s)) continue;
        if (/^https?:\/\//.test(s)) continue;
        if (/^[A-Za-z0-9+/=]{40,}$/.test(s)) continue;
        longest = s;
        longestLen = s.length;
      }
    }

    return longest && longestLen >= 20 ? longest : null;
  }

  /**
   * Capture all messages from a history-load response and dispatch events.
   */
  function captureConversationHistory(responseText, metadata) {
    const messages = extractConversationMessages(responseText);
    if (messages.length === 0) return;

    const isInitPhase = (Date.now() - HISTORY_CAPTURE_START) < HISTORY_CAPTURE_INIT_MS;
    if (isInitPhase) return; // Skip captures during initial page load

    const conversationId = metadata.conversationIdHint || 'history_' + Date.now();

    // Skip if we already captured this conversation via history-load
    if (_capturedConversationIds.has(conversationId)) return;
    if (_capturedConversationIds.size >= 500) {
      _capturedConversationIds.clear(); // Reset — re-capturing a conv is harmless (deduplicator catches content)
    }
    _capturedConversationIds.add(conversationId);

    _kytDebug() && console.log('📜 KYT Gemini: History load — ' + messages.length + ' messages from ' + conversationId);

    let captured = 0;
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const cleanContent = stripInjectionBlock(msg.content);
      if (!cleanContent || cleanContent.length < 2) continue;

      // Skip base64/binary payloads
      if (cleanContent.length > 40 && !cleanContent.includes(' ') && /^[A-Za-z0-9+/=]+$/.test(cleanContent)) continue;

      if (!deduplicator.shouldCapture(cleanContent, 'history')) continue;

      dispatchCapture(cleanContent, msg.role, 'history', conversationId, msg.timestamp);
      captured++;
    }

    _kytDebug() && console.log('📜 KYT Gemini: Captured ' + captured + '/' + messages.length + ' from ' + conversationId);
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
  let activeContextRequestId = null;

  function requestContext(userMessage) {
    // Safety valve: reject if too many pending (bridge is broken or overloaded)
    if (pendingContextRequests.size >= 10) {
      return Promise.resolve(null); // fail-open: send without context
    }

    // Cancel any active request — only the latest message matters for injection
    if (activeContextRequestId) {
      const prev = pendingContextRequests.get(activeContextRequestId);
      if (prev) {
        clearTimeout(prev.timeoutId);
        pendingContextRequests.delete(activeContextRequestId);
        prev.resolve(null); // fail-open: previous request gets no context
      }
    }

    return new Promise((resolve) => {
      const requestId = 'ctx_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
      activeContextRequestId = requestId;

      const timeoutId = setTimeout(() => {
        if (activeContextRequestId === requestId) activeContextRequestId = null;
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
    if (activeContextRequestId === detail.requestId) activeContextRequestId = null;
    pending.resolve(detail.formattedContext || null);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // DISPATCH CAPTURE
  // ═══════════════════════════════════════════════════════════════════════

  function dispatchCapture(content, role, captureMethod, conversationId, optionalTimestamp) {
    if (!content || typeof content !== 'string' || content.trim().length < 2) return;

    // Clean content: strip K.Y.T. injection blocks + role labels (defense-in-depth)
    content = stripInjectionBlock(content) || content;
    content = content.replace(/^(?:You said|Gemini said|User|Assistant)\s*:?\s*/i, '').trim();

    // Reject conversation dumps (both user and assistant labels = grabbed container)
    if (/\bYou said\b/i.test(content) && /\bGemini said\b/i.test(content)) return;

    // Strip Gemini UI button text and artifacts that leak into innerText/wire
    content = content.replace(/\n?Export to Sheets\n?/g, '\n').trim();
    content = content.replace(/\n?(?:Sources|Related topics)\n.*$/s, '').trim();
    content = content.replace(/\n?(?:Show drafts|Draft \d+ of \d+)\n?/g, '\n').trim();
    content = content.replace(/(?:^|\n)(?:Share|Copy|Report|Like|Dislike)\s*$/gm, '').trim();
    content = content.replace(/\[Image of .*?\]/g, '').trim();
    content = content.replace(/\n{3,}/g, '\n\n').trim();

    if (!content || content.length < 2) return;

    // Final safety net: reject raw JSON arrays/objects that slipped through extraction
    const t = content.trimStart();
    if (/^[\[{]/.test(t) && (t.includes('"c_') || t.includes('"r_') || t.includes('"rc_'))) return;

    // Reject Gemini UI metadata (loading states, image URLs, RPC artifacts)
    if (/^[A-Za-z ]{5,30}https?:\/\//.test(t)) return;

    if (!deduplicator.shouldCapture(content, captureMethod)) return;


    const messageData = {
      content: content.trim(),
      role: role,
      platform: 'gemini',
      conversationId: conversationId || null,
      model: 'gemini',
      timestamp: optionalTimestamp || Date.now(),
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
    // Only intercept POST to gemini.google.com
    if (this.__kytMethod !== 'POST' || !isGeminiDomain(this.__kytUrl)) {
      return originalXHRSend.apply(this, arguments);
    }

    // Sniff batchexecute params from ALL non-StreamGenerate POSTs
    if (!isStreamGenerate(this.__kytUrl) && this.__kytUrl.includes('batchexecute')) {
      sniffBatchExecuteParams(this.__kytUrl, bodyToString(body));
    }

    // Path 2: History-load detection (batchexecute with conversation ID)
    if (!isStreamGenerate(this.__kytUrl)) {
      const bodyStr = bodyToString(body);
      const historyInfo = isGeminiHistoryLoad(this.__kytUrl, bodyStr);
      if (historyInfo) {
        this.addEventListener('load', function () {
          try {
            const rt = this.responseText;
            if (rt && rt.length > 50) {
              captureConversationHistory(rt, historyInfo);
            }
          } catch (_) {}
        }, { once: true });
      }

      // Sniff for conversation-list responses (many c_ IDs = sidebar load)
      if (!historyInfo) {
        const xhrForSniff = this;
        this.addEventListener('load', function () {
          try {
            const rt = xhrForSniff.responseText;
            if (rt && rt.length > 200) {
              const cIdMatches = rt.match(/c_[0-9a-f]{8,}/g);
              if (cIdMatches && cIdMatches.length >= 3) {
                // This response had 3+ conversation IDs — likely the sidebar list
                const bStr = bodyToString(body);
                if (bStr) {
                  try {
                    const p = new URLSearchParams(bStr);
                    const fr = p.get('f.req');
                    if (fr) {
                      let o = JSON.parse(fr);
                      if (typeof o === 'string') o = JSON.parse(o);
                      if (Array.isArray(o) && Array.isArray(o[0]) && Array.isArray(o[0][0])) {
                        markConversationListRpc(o[0][0][0]);
                      }
                    }
                  } catch (_) {}
                }
              }
            }
          } catch (_) {}
        }, { once: true });
      }
      return originalXHRSend.apply(this, arguments);
    }

    // Path 1: StreamGenerate (live message capture + context injection)

    const bodyStr = bodyToString(body);
    const parseResult = parseFReq(bodyStr);

    if (!parseResult) {
      return originalXHRSend.apply(this, arguments);
    }

    _kytDebug() && console.log('📤 KYT Gemini: User message captured via XHR (' + parseResult.userMessage.length + ' chars)');
    dispatchCapture(parseResult.userMessage, 'user', 'xhr', parseResult.conversationId);

    // Start DOM observer to capture assistant response when it stabilizes
    responseDOMObserver.start(parseResult.conversationId);

    // Wire extraction primary, DOM observer fallback
    this.addEventListener('load', function () {
      try {
        if (this.responseText && this.responseText.length > 100) {
          _kytDebug() && console.log('📡 KYT Gemini: XHR StreamGenerate response complete (' + this.responseText.length + ' bytes)');
          const wireText = extractAssistantFromStreamGenerate(this.responseText);
          if (wireText && wireText.length >= 20) {
            _kytDebug() && console.log('🔌 KYT Gemini: Wire extraction success (' + wireText.length + ' chars)');
            dispatchCapture(wireText, 'assistant', 'xhr-response', parseResult.conversationId);
            responseDOMObserver.stop();
          } else {
            _kytDebug() && console.log('🔌 KYT Gemini: Wire extraction failed, falling back to DOM observer');
            responseDOMObserver.notifyResponseComplete();
          }
        }
      } catch (_) {
        responseDOMObserver.notifyResponseComplete();
      }
    }, { once: true });

    // Context injection: defer send until context resolves
    const xhr = this;
    const originalBody = body;

    requestContext(parseResult.userMessage).then(function (formattedContext) {
      if (formattedContext) {
        const modified = reEncodeFReq(bodyStr, formattedContext, parseResult);
        if (modified) {
          _kytDebug() && console.log('💉 KYT Gemini: Context injected into XHR request');
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

    // Only intercept POST to gemini.google.com
    const method = (init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
    if (method !== 'POST' || !isGeminiDomain(url)) {
      return originalFetch.apply(this, arguments);
    }

    // Sniff batchexecute params from ALL non-StreamGenerate POSTs
    if (!isStreamGenerate(url) && url.includes('batchexecute')) {
      let sniffBody = null;
      if (init?.body) sniffBody = bodyToString(init.body);
      else if (input instanceof Request) { try { sniffBody = await input.clone().text(); } catch (_) {} }
      if (sniffBody) sniffBatchExecuteParams(url, sniffBody);
    }

    // Path 2: History-load detection (batchexecute via fetch)
    if (!isStreamGenerate(url)) {
      let historyBodyStr = null;
      if (init?.body) historyBodyStr = await bodyToStringAsync(init.body);
      else if (input instanceof Request) {
        try { historyBodyStr = await input.clone().text(); } catch (_) {}
      }
      const historyInfo = isGeminiHistoryLoad(url, historyBodyStr);
      if (historyInfo) {
        const response = await originalFetch.apply(this, arguments);
        try {
          const rt = await response.clone().text();
          if (rt && rt.length > 50) captureConversationHistory(rt, historyInfo);
        } catch (_) {}
        return response;
      }
      return originalFetch.apply(this, arguments);
    }

    // Path 1: StreamGenerate (live message capture + context injection)

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

    _kytDebug() && console.log('📤 KYT Gemini: User message captured via fetch (' + parseResult.userMessage.length + ' chars)');
    dispatchCapture(parseResult.userMessage, 'user', 'fetch', parseResult.conversationId);

    // Start DOM observer to capture assistant response (if not already started by XHR)
    responseDOMObserver.start(parseResult.conversationId);

    // Context injection
    const formattedContext = await requestContext(parseResult.userMessage);
    let finalInit = init || {};
    if (formattedContext && bodyStr) {
      const modified = reEncodeFReq(bodyStr, formattedContext, parseResult);
      if (modified) {
        _kytDebug() && console.log('💉 KYT Gemini: Context injected into fetch request');
        finalInit = { ...finalInit, body: modified };
      }
    }

    const fetchResponse = await originalFetch.call(this, input, finalInit);
    try {
      const responseClone = fetchResponse.clone();
      const responseBody = await responseClone.text();
      _kytDebug() && console.log('📡 KYT Gemini: Fetch StreamGenerate response complete (' + responseBody.length + ' bytes)');
      const wireText = extractAssistantFromStreamGenerate(responseBody);
      if (wireText && wireText.length >= 20) {
        _kytDebug() && console.log('🔌 KYT Gemini: Wire extraction success via fetch (' + wireText.length + ' chars)');
        dispatchCapture(wireText, 'assistant', 'fetch-response', parseResult.conversationId);
        responseDOMObserver.stop();
      } else {
        _kytDebug() && console.log('🔌 KYT Gemini: Wire extraction failed via fetch, falling back to DOM observer');
        responseDOMObserver.notifyResponseComplete();
      }
    } catch (_) {
      responseDOMObserver.notifyResponseComplete();
    }
    return fetchResponse;
  };

  // ═══════════════════════════════════════════════════════════════════════
  // DIAGNOSTICS — Exposed for KYT_DEBUG
  // ═══════════════════════════════════════════════════════════════════════

  window.__kytGeminiStats = function () {
    return {
      deduplicator: deduplicator.getStats(),
      pendingContextRequests: pendingContextRequests.size,
      capturedParams: {
        bl: capturedParams.bl,
        blCapturedAt: capturedParams.blCapturedAt ? new Date(capturedParams.blCapturedAt).toISOString() : null,
        at: capturedParams.at ? `${capturedParams.at.substring(0, 8)}...` : null,
        atCapturedAt: capturedParams.atCapturedAt ? new Date(capturedParams.atCapturedAt).toISOString() : null,
        conversationListRpcId: capturedParams.conversationListRpcId,
        conversationDetailRpcId: capturedParams.conversationDetailRpcId,
        knownRpcIds: Object.fromEntries(capturedParams.rpcIds),
      },
    };
  };

  _kytDebug() && console.log('✅ KYT Gemini: inject.js loaded (live capture + history-load interception)');
})();
