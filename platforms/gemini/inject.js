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
  // RESPONSE EXTRACTION — Length-prefixed frame parser
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Extract assistant response from Gemini's streaming response.
   *
   * Response format:
   *   )]}'\n                    <- anti-XSSI prefix
   *   <number>\n               <- byte-count length prefix
   *   <JSON frame>\n           <- exactly N chars of JSON
   *   <number>\n               <- next length prefix
   *   <JSON frame>\n           <- next frame ...
   *
   * Each frame is a JSON array. wrb.fr frames contain the response:
   *   [["wrb.fr", null, "<double-encoded-JSON>"]]
   * Position [0][2] is a JSON string that must be parsed again.
   */
  function extractAssistantResponse(responseText) {
    if (!responseText || typeof responseText !== 'string') return null;

    // Strip anti-XSSI prefix
    let cleaned = responseText;
    if (cleaned.startsWith(")]}'")) {
      const nlIdx = cleaned.indexOf('\n');
      if (nlIdx >= 0) cleaned = cleaned.substring(nlIdx + 1);
    }

    // Parse length-prefixed frames (NOT line-by-line split)
    const frames = parseLengthPrefixedFrames(cleaned);

    // Extract text from ALL wrb.fr frames and concatenate.
    // Gemini streaming splits the response across many frames, each with a small
    // text fragment. We must collect them all, not just pick the longest.
    const textParts = [];
    let longestSingle = '';
    for (const frame of frames) {
      const raw = extractTextFromFrame(frame);
      if (!raw || raw.length < 5) continue;

      // Strip injection blocks (response may echo injected context)
      const stripped = stripInjectionBlock(raw);
      const candidate = stripped && stripped.length >= 5 ? stripped : raw;

      if (isNaturalLanguage(candidate) || candidate.length >= 20) {
        textParts.push(candidate);
      }
      if (candidate.length > longestSingle.length && isNaturalLanguage(candidate)) {
        longestSingle = candidate;
      }
    }

    // If we collected multiple frame texts, concatenate them (streaming assembly)
    if (textParts.length > 1) {
      const combined = textParts.join(' ');
      // Strip injection from combined result too (block may span frames)
      const strippedCombined = stripInjectionBlock(combined);
      const result = strippedCombined && strippedCombined.length >= 20 ? strippedCombined : combined;
      if (result.length >= 20 && isNaturalLanguage(result)) {
        return result;
      }
    }

    // Fallback: single best frame (non-streaming or single-frame response)
    if (longestSingle.length >= 10) return longestSingle;
    return null;
  }

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
      // Skip whitespace/newlines between frames (0x0A=\n, 0x0D=\r)
      while (pos < sourceBytes.length && (sourceBytes[pos] === 0x0A || sourceBytes[pos] === 0x0D)) pos++;
      if (pos >= sourceBytes.length) break;

      // Read the length prefix digits (0x30='0' through 0x39='9')
      let numStr = '';
      while (pos < sourceBytes.length && sourceBytes[pos] >= 0x30 && sourceBytes[pos] <= 0x39) {
        numStr += String.fromCharCode(sourceBytes[pos++]);
      }
      if (!numStr) { pos++; continue; } // skip unexpected byte
      const len = parseInt(numStr, 10);
      if (isNaN(len) || len <= 0 || len > 500000) continue;

      // NOTE: Do NOT skip \n here — Google's length prefix INCLUDES
      // the \n before the frame content in its byte count.
      // We read len bytes (which starts with \n), then .trim() it off.

      // Read exactly len UTF-8 bytes, then decode to string
      if (pos + len > sourceBytes.length) break; // not enough data
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
   * Extract assistant text from a parsed wrb.fr frame.
   * wrb.fr entries have double-encoded JSON at position [2].
   */
  function extractTextFromFrame(frame) {
    if (!Array.isArray(frame) || !Array.isArray(frame[0])) return null;

    for (const entry of frame) {
      if (!Array.isArray(entry) || entry[0] !== 'wrb.fr') continue;

      // entry[2] is a double-encoded JSON string containing response data
      const innerStr = entry[2];
      if (typeof innerStr !== 'string') continue;

      let inner;
      try { inner = JSON.parse(innerStr); } catch (_) { continue; }
      if (!Array.isArray(inner)) continue;

      // Strategy 1: Collect and concatenate text fragments from leaf arrays
      // (Gemini stores response text as arrays of short string segments)
      const collected = collectTextFragments(inner);
      if (collected) return collected;

      // Strategy 2: Find a single long natural-language string
      const natural = findLongestNaturalText(inner);
      if (natural) return natural;

      // Strategy 3: Fallback to raw longest (may include metadata, filtered later by isNaturalLanguage)
      const raw = findLongestRawText(inner);
      if (raw) return raw;
    }
    return null;
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
    return true;
  }

  /**
   * Depth-first search for the longest non-trivial string in a nested structure.
   * Filters obvious metadata (pure numbers, conv IDs, JSON) but allows strings
   * that may contain injection blocks (those get stripped later).
   */
  function findLongestRawText(val) {
    if (typeof val === 'string') {
      if (val.length < 20) return '';
      const trimmed = val.trimStart();
      // Filter pure numeric (response IDs, timestamps)
      if (/^-?\d+$/.test(trimmed)) return '';
      // Filter conv/request IDs
      if (/^(c_|r_|rc_|af\.)[0-9a-f]{8,}/.test(trimmed)) return '';
      return val;
    }
    if (!Array.isArray(val)) return '';
    let longest = '';
    for (const item of val) {
      const found = findLongestRawText(item);
      if (found.length > longest.length) longest = found;
    }
    return longest;
  }

  /**
   * Depth-first search for the longest natural-language string in a nested structure.
   */
  function findLongestNaturalText(val) {
    if (typeof val === 'string') {
      return isNaturalLanguage(val) ? val : '';
    }
    if (!Array.isArray(val)) return '';
    let longest = '';
    for (const item of val) {
      const found = findLongestNaturalText(item);
      if (found.length > longest.length) longest = found;
    }
    return longest;
  }

  /**
   * Collect and concatenate text fragments from leaf arrays.
   * Gemini stores response text as arrays of SHORT string segments (often < 20 chars each).
   * This function finds arrays whose elements are all short strings (text paragraphs),
   * concatenates them, and returns the longest natural-language result.
   */
  function collectTextFragments(val, depth = 0) {
    if (depth > 15) return '';
    if (!Array.isArray(val)) return '';

    // Check if this array is a "text leaf" — all elements are strings
    const allStrings = val.length > 0 && val.every(item => typeof item === 'string');
    if (allStrings) {
      // Quality gate: at least half the fragments must look like words (contain spaces)
      // This filters out arrays of URLs, IDs, or single tokens that happen to concatenate
      const wordyFragments = val.filter(s => /\s/.test(s) || (s.length > 2 && /^[a-zA-Z]/.test(s) && !/^https?:\/\//.test(s)));
      if (wordyFragments.length < val.length * 0.5) return '';

      const joined = val.join('');
      // Reject if result contains infrastructure URLs (gstatic, googleapis = Google UI metadata)
      if (/https?:\/\/(www\.)?(gstatic|googleapis|google)\.\w+/.test(joined)) return '';
      if (joined.length >= 20 && isNaturalLanguage(joined)) {
        return joined;
      }
    }

    // Recurse into sub-arrays, collecting the longest concatenated result
    let longest = '';
    for (const item of val) {
      const found = collectTextFragments(item, depth + 1);
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
        const rt = this.responseText;
        const respType = this.responseType;
        const status = this.status;
        console.log('🔍 KYT Gemini: XHR load event — status=' + status +
                     ', responseType="' + respType + '"' +
                     ', responseText=' + (rt ? rt.length + ' chars' : 'NULL/EMPTY'));

        if (!rt) {
          // Try response (blob/arraybuffer) as fallback
          console.warn('⚠️ KYT Gemini: responseText empty, responseType=' + respType);
          if (this.response && respType === 'arraybuffer') {
            try {
              const decoded = new TextDecoder('utf-8').decode(this.response);
              console.log('🔍 KYT Gemini: Decoded arraybuffer response: ' + decoded.length + ' chars');
              const assistantText = extractAssistantResponse(decoded);
              if (assistantText) {
                console.log('📥 KYT Gemini: Assistant response captured via XHR arraybuffer (' + assistantText.length + ' chars)');
                dispatchCapture(assistantText, 'assistant', 'xhr', conversationId);
              }
            } catch (decErr) {
              console.warn('⚠️ KYT Gemini: arraybuffer decode failed:', decErr.message);
            }
          }
          return;
        }

        // Log first 300 chars for format inspection
        console.log('🔍 KYT Gemini: Response prefix: "' + rt.substring(0, 300).replace(/\n/g, '\\n') + '"');

        const assistantText = extractAssistantResponse(rt);
        if (assistantText) {
          console.log('📥 KYT Gemini: Assistant response captured via XHR (' + assistantText.length + ' chars)');
          console.log('📥 Preview: "' + assistantText.substring(0, 200) + '"');
          dispatchCapture(assistantText, 'assistant', 'xhr', conversationId);
        } else {
          console.warn('⚠️ KYT Gemini: No assistant text extracted from response');
          // Dump diagnostic info about frames
          let cleaned = rt;
          if (cleaned.startsWith(")]}'")) {
            const nlIdx = cleaned.indexOf('\n');
            if (nlIdx >= 0) cleaned = cleaned.substring(nlIdx + 1);
          }
          const frames = parseLengthPrefixedFrames(cleaned);
          console.log('🔍 KYT Gemini: Parsed ' + frames.length + ' frames from ' + rt.length + ' chars');
          for (let fi = 0; fi < Math.min(frames.length, 5); fi++) {
            const f = frames[fi];
            const isArr = Array.isArray(f);
            const hasWrbFr = isArr && Array.isArray(f[0]) && f.some(e => Array.isArray(e) && e[0] === 'wrb.fr');
            console.log('🔍   Frame[' + fi + ']: isArray=' + isArr +
                        ', length=' + (isArr ? f.length : 'N/A') +
                        ', hasWrbFr=' + hasWrbFr +
                        ', preview=' + JSON.stringify(f).substring(0, 200));
          }
          if (frames.length === 0) {
            // Show raw content for manual inspection
            console.log('🔍 KYT Gemini: Raw cleaned (first 500): "' + cleaned.substring(0, 500).replace(/\n/g, '\\n') + '"');
          }
        }
      } catch (e) {
        console.error('⚠️ KYT Gemini: Response capture error:', e.message, e.stack);
      }
    }, { once: true });

    // Also listen for readystatechange as diagnostic (streaming responses may have data before load)
    this.addEventListener('readystatechange', function () {
      if (this.readyState === 3) { // LOADING — partial data available
        try {
          const partial = this.responseText;
          if (partial && partial.length > 0) {
            console.log('🔍 KYT Gemini: XHR readyState=3 (LOADING), partial response: ' + partial.length + ' chars');
          }
        } catch (_) {} // responseText may throw if responseType !== ''
      }
    });

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
