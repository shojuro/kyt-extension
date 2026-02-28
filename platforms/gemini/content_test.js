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

  // Gemini uses Google's batchexecute RPC protocol.
  // f.req format: [[["rpcId", "JSON.stringify(args)", null, "generic"], ...moreRpcs]]
  //
  // Each RPC call is a 4-element array:
  //   [0] = RPC method ID (obfuscated, e.g. "GPRiHf", "L5adhe")
  //   [1] = JSON-encoded arguments string (must be parsed again)
  //   [2] = null
  //   [3] = "generic"
  //
  // The user message RPC has the typed text somewhere in its args array.
  // We find it by scanning all RPCs for the longest natural-text string.

  // Known system RPC IDs (never contain user messages)
  const SYSTEM_RPC_IDS = new Set([
    'GPRiHf',  // initialization
    'maGuAc',  // settings
    'qpEbW',   // feature checks
    'L5adhe',  // feature flags (tons of nulls)
    'ESY5D',   // activity status
    'aPya6c',  // initialization
    'DYBcR',   // language
    'o30O0e',  // person info
  ]);

  // Strings that look like system values, not user text
  const SYSTEM_VALUE_PATTERNS = [
    /^(generic|null|en|true|false|\d+)$/i,
    /^[a-zA-Z_]+_[a-zA-Z_]+$/, // snake_case system identifiers like "bard_activity_enabled"
    /^person\./,  // person.photo, person.name, etc.
    /^popup_/,
    /^current/,
    /^IMAGE_/,
    /^r_[0-9a-f]+$/,  // request/response IDs like "r_740338f66a6d4770"
    /^c_[0-9a-f]+$/,  // conversation IDs (we extract these separately)
    /^[0-9a-f]{16,}$/, // hex-only strings (likely IDs/tokens)
    /^![\w+/=]+$/,    // auth tokens starting with !
  ];

  function isSystemValue(str) {
    if (str.length < 5) return true;
    return SYSTEM_VALUE_PATTERNS.some(p => p.test(str));
  }

  /**
   * Deep-search an array/object for all strings.
   * Returns strings sorted by length (longest first).
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
   * Parse the f.req payload from batchexecute/StreamGenerate form data.
   *
   * Handles TWO distinct formats:
   *
   * 1. StreamGenerate format (carries user messages):
   *    f.req = [null, "[[\"hello\",0,null,...],[\"en\"],[...],\"auth_token\"]"]
   *    - outer[0] = null
   *    - outer[1] = JSON string → parse → payload[0][0] = user message
   *
   * 2. batchexecute RPC format (system/polling calls):
   *    f.req = [[["rpcId", "jsonArgs", null, "generic"], ...]]
   *    - outer[0] = array of RPC calls
   *    - Each RPC has JSON-encoded args at position [1]
   *
   * @param {string} fReq - Raw f.req value from URLSearchParams
   * @returns {{ userMessage: string, conversationId: string|null, format: string, ... }|null}
   */
  function parseFReq(fReq) {
    let outer;
    try {
      outer = JSON.parse(fReq);
    } catch (_) {
      console.warn('KYT Gemini: Failed to parse f.req');
      return null;
    }

    // Handle double encoding
    if (typeof outer === 'string') {
      try { outer = JSON.parse(outer); } catch (_) { return null; }
    }

    if (!Array.isArray(outer)) return null;

    // === FORMAT 1: StreamGenerate ===
    // [null, "json_payload_string"]
    // The real user message lives here!
    if (outer[0] === null && typeof outer[1] === 'string') {
      try {
        const payload = JSON.parse(outer[1]);
        if (Array.isArray(payload) && Array.isArray(payload[0])) {
          const userMessage = typeof payload[0][0] === 'string' ? payload[0][0] : null;
          if (userMessage && userMessage.trim().length > 0) {
            // Look for conversation ID in the payload
            let conversationId = null;
            const allStrings = findAllStrings(payload);
            for (const s of allStrings) {
              if (s !== userMessage && (s.startsWith('c_') || s.startsWith('r_'))) {
                conversationId = s;
                break;
              }
            }

            console.log('KYT Gemini [parseFReq]: Found user message in StreamGenerate format',
              '(' + userMessage.length + ' chars)');

            return {
              userMessage: userMessage.trim(),
              conversationId,
              format: 'streamgenerate',
              payloadIndex: 1,  // outer[1] contains the payload
              messagePosition: [0, 0], // payload[0][0] is the message
            };
          }
        }
      } catch (_) {
        // Not StreamGenerate format, fall through
      }
    }

    // === FORMAT 2: batchexecute RPC ===
    // [[["rpcId", "jsonArgs", null, "generic"], ...]]
    if (!Array.isArray(outer[0])) return null;

    const rpcs = outer[0];
    let bestCandidate = null;

    for (let i = 0; i < rpcs.length; i++) {
      const rpc = rpcs[i];
      if (!Array.isArray(rpc) || rpc.length < 2) continue;

      const rpcId = rpc[0];
      const argsJson = rpc[1];

      // Skip known system RPCs
      if (typeof rpcId === 'string' && SYSTEM_RPC_IDS.has(rpcId)) continue;

      // Parse the JSON-encoded arguments
      if (typeof argsJson !== 'string') continue;
      let args;
      try {
        args = JSON.parse(argsJson);
      } catch (_) {
        continue;
      }

      // Search for strings in the parsed args
      const strings = findAllStrings(args);

      // Find the longest string that looks like user text (not a system value)
      for (const str of strings) {
        if (isSystemValue(str)) continue;
        if (!bestCandidate || str.length > bestCandidate.userMessage.length) {
          let conversationId = null;
          for (const s of strings) {
            if (s !== str && (s.startsWith('c_') || /^[0-9a-f]{8,}$/.test(s))) {
              conversationId = s;
              break;
            }
          }
          bestCandidate = {
            userMessage: str,
            conversationId,
            format: 'batchexecute',
            rpcId,
            rpcArgs: args,
            rpcIndex: i,
          };
        }
        break;
      }
    }

    if (bestCandidate) {
      console.log('KYT Gemini [parseFReq]: Found user message in RPC "' + bestCandidate.rpcId + '"',
        '(' + bestCandidate.userMessage.length + ' chars)');
    }

    return bestCandidate;
  }

  /**
   * Re-encode modified message back into f.req format.
   * Handles both StreamGenerate and batchexecute formats.
   *
   * @param {string} originalBody - Original URL-encoded form data
   * @param {string} newMessage - The new message text (with injected context)
   * @param {object} parseResult - Result from parseFReq
   * @returns {string|null} Re-encoded body or null on failure
   */
  function reEncodeFReq(originalBody, newMessage, parseResult) {
    try {
      const params = new URLSearchParams(originalBody);
      const fReq = params.get('f.req');

      let outer;
      let isDoubleEncoded = false;

      try {
        outer = JSON.parse(fReq);
      } catch (_) {
        return null;
      }

      if (typeof outer === 'string') {
        isDoubleEncoded = true;
        outer = JSON.parse(outer);
      }

      if (parseResult.format === 'streamgenerate') {
        // StreamGenerate: outer = [null, "json_payload"]
        // payload[0][0] = user message
        let payload = JSON.parse(outer[1]);
        payload[0][0] = newMessage;
        outer[1] = JSON.stringify(payload);
      } else {
        // batchexecute: outer = [[["rpcId", "jsonArgs", null, "generic"]]]
        const rpcs = outer[0];
        const rpc = rpcs[parseResult.rpcIndex];
        let args = JSON.parse(rpc[1]);

        // Replace the user message string in the args (depth-first)
        function replaceInPlace(obj, target, replacement) {
          if (Array.isArray(obj)) {
            for (let i = 0; i < obj.length; i++) {
              if (obj[i] === target) { obj[i] = replacement; return true; }
              if (replaceInPlace(obj[i], target, replacement)) return true;
            }
          } else if (obj && typeof obj === 'object') {
            for (const key of Object.keys(obj)) {
              if (obj[key] === target) { obj[key] = replacement; return true; }
              if (replaceInPlace(obj[key], target, replacement)) return true;
            }
          }
          return false;
        }

        if (!replaceInPlace(args, parseResult.userMessage, newMessage)) {
          console.warn('KYT Gemini: Could not find user message to replace in RPC args');
          return null;
        }

        rpc[1] = JSON.stringify(args);
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
      const newMessage = `${event.detail.formattedContext}\n\n---\n\n${pending.userMessage}`;
      const reEncoded = reEncodeFReq(pending.originalBody, newMessage, pending.parseResult);
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
          parseResult: parsed,
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

  // === BODY COERCION ===

  /**
   * Coerce fetch body to string for inspection.
   * Gemini may send body as: string, URLSearchParams, FormData, Blob, ArrayBuffer, etc.
   * Returns null if body cannot be read synchronously as a string.
   */
  function bodyToString(body) {
    if (typeof body === 'string') return body;
    if (body instanceof URLSearchParams) return body.toString();
    if (body instanceof FormData) {
      // FormData → URLSearchParams (only works for text fields)
      const params = new URLSearchParams();
      for (const [key, value] of body.entries()) {
        if (typeof value === 'string') {
          params.set(key, value);
        }
      }
      return params.toString();
    }
    if (body instanceof ArrayBuffer || body instanceof Uint8Array) {
      try {
        const decoder = new TextDecoder('utf-8');
        return decoder.decode(body);
      } catch (_) { return null; }
    }
    // Blob / ReadableStream — can't read synchronously, return null
    return null;
  }

  /**
   * Async body coercion for types that require awaiting (Blob, ReadableStream).
   */
  async function bodyToStringAsync(body) {
    // First try sync
    const sync = bodyToString(body);
    if (sync !== null) return sync;

    if (body instanceof Blob) {
      try { return await body.text(); } catch (_) { return null; }
    }
    if (body instanceof ReadableStream) {
      try {
        const reader = body.getReader();
        const chunks = [];
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
        }
        const decoder = new TextDecoder('utf-8');
        return chunks.map(c => decoder.decode(c, { stream: true })).join('') + decoder.decode();
      } catch (_) { return null; }
    }
    return null;
  }

  // === FETCH OVERRIDE ===

  if (!window.__kytOriginalFetch) window.__kytOriginalFetch = window.fetch;
  const originalFetch = window.__kytOriginalFetch;

  // Track discovered endpoints for diagnostics
  const discoveredEndpoints = new Set();

  // === CONVERSATION HISTORY CAPTURE ===
  // Captures mobile-originated (or any pre-existing) conversations when loaded on web.
  // Gemini loads history via batchexecute RPCs that contain conversation data in responses.

  const HISTORY_CAPTURE_START = Date.now();
  const HISTORY_CAPTURE_INIT_MS = 5000;  // Skip captures during initial page load
  const _capturedConversationIds = new Set(); // Prevent re-capturing same conversation

  /**
   * Check if a POST request is a Gemini conversation-history load (NOT a message send).
   * These are batchexecute RPCs containing a conversation ID but no user message.
   *
   * @param {string} urlString - Request URL
   * @param {string} bodyString - Request body string
   * @returns {Object|false} Parsed info if history load, false otherwise
   */
  // Known RPCs that are system-only (polling, analytics, settings) — never carry conversation history
  const SYSTEM_ONLY_RPCS = new Set([
    'L5adhe', 'GPRiHf', 'bYBfhb', 'aKUX7e', 'LCWRX',  // Known system RPCs
    'jQ1olc', 'MkEWBc',  // Settings/config
    'ESY5D',   // Settings lookup (bard_activity_enabled etc.) — false positive
    'otAQ7b',  // Init
    'MaZiqc',  // UI config
    'aPya6c',  // Session/auth
    'cYRIkd',  // Locale
    'maGuAc',  // Feature flags
    'K4WWud',  // Feature flags
    'ozz5Z',   // Experiment config
    'CNgdBe',  // Locale/experiments
    'qpEbW',   // UI layout
    'o30O0e',  // User profile
    'ku4Jyf',  // Locale/experiments
    'DYBcR',   // Locale
  ]);

  function isGeminiHistoryLoad(urlString, bodyString) {
    if (!isGoogleDomain(urlString)) return false;
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

      // If this is a StreamGenerate with a user message, it's a message-send (not history)
      if (outer[0] === null && typeof outer[1] === 'string') {
        try {
          const payload = JSON.parse(outer[1]);
          if (Array.isArray(payload) && Array.isArray(payload[0]) &&
              typeof payload[0][0] === 'string' && payload[0][0].trim().length > 0) {
            return false; // This is a message-send, not history
          }
        } catch (_) {}
      }

      // batchexecute RPC format: [[["rpcId", "jsonArgs", null, "generic"], ...]]
      if (!Array.isArray(outer[0])) return false;

      const rpcs = outer[0];

      for (let i = 0; i < rpcs.length; i++) {
        if (!Array.isArray(rpcs[i])) continue;
        const rpcId = rpcs[i][0];
        const rpcArgs = rpcs[i][1];
        if (typeof rpcArgs !== 'string') continue;

        // Skip known system-only RPCs
        if (SYSTEM_ONLY_RPCS.has(rpcId)) continue;

        // Look for conversation-ID-like patterns in args:
        //   c_<hex> (confirmed Gemini format), or long hex-only strings (possible alternative format)
        const convIdMatch = rpcArgs.match(/"(c_[0-9a-f]{8,})"/) ||     // c_ + hex (confirmed format)
                            rpcArgs.match(/"([0-9a-f]{20,})"/) ;       // long hex IDs (fallback)

        if (convIdMatch) {
          // Additional check: args should be relatively short (conversation load, not a message payload)
          // Message-send RPCs have long args (user message text); history-load RPCs have short args (just IDs)
          const argsLen = rpcArgs.length;
          // If args are very long (>2000 chars), it's likely a message send, not a history load
          if (argsLen > 2000) continue;

          return {
            rpcId: rpcId,
            rpcIndex: i,
            conversationIdHint: convIdMatch[1] || null
          };
        }
      }

      // Also match requests to conversation-related endpoints
      if (urlString.includes('/conversation') || urlString.includes('GetConversation') ||
          urlString.includes('ListMessages') || urlString.includes('ChatHistory')) {
        return { rpcId: 'url-match', conversationIdHint: null };
      }

    } catch (_) {}
    return false;
  }

  /**
   * Extract all meaningful text strings from Gemini's nested response frames.
   * Returns an array of {text, role} objects for user and assistant messages.
   *
   * Gemini response format:
   *   Anti-XSSI prefix: )]}'\n
   *   Length-prefixed frames: number\n[json-array]\n
   *   Inside frames: deeply nested arrays with text at various positions
   *
   * @param {string} responseText - Raw response body
   * @returns {Array<{content: string, role: string}>} Extracted messages
   */
  function extractConversationMessages(responseText) {
    const messages = [];

    // Strip anti-XSSI prefix
    let cleaned = responseText;
    if (cleaned.startsWith(")]}'")) {
      cleaned = cleaned.substring(cleaned.indexOf('\n') + 1);
    }

    // Parse each length-prefixed frame
    const lines = cleaned.split('\n');
    const allStringsFound = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || /^\d+$/.test(trimmed)) continue;

      try {
        const parsed = JSON.parse(trimmed);
        // Collect all strings > 10 chars from this frame (possible message content)
        const strings = findAllStrings(parsed, 15);
        for (const s of strings) {
          if (s.length > 10) {
            allStringsFound.push(s);
          }
        }
      } catch (_) {}
    }

    // Filter out system strings (auth tokens, request IDs, URLs, JSON-like strings)
    const isSystemString = (s) => {
      if (s.startsWith('r_') || s.startsWith('!')) return true; // Request IDs, auth tokens
      if (/^[0-9a-f]{32,}$/i.test(s)) return true; // Hex strings
      if (s.startsWith('http://') || s.startsWith('https://')) return true; // URLs
      if (s.startsWith('{') || s.startsWith('[')) return true; // Nested JSON
      if (/^[A-Za-z0-9+/=]{40,}$/.test(s)) return true; // Base64-like
      if (s.split('\n').length < 2 && /^[a-zA-Z0-9_.-]+$/.test(s)) return true; // Identifiers
      return false;
    };

    const contentStrings = allStringsFound.filter(s => !isSystemString(s));

    // Deduplicate and sort by length (longest = most likely to be full messages)
    const seen = new Set();
    const unique = [];
    for (const s of contentStrings) {
      const normalized = s.trim();
      if (!seen.has(normalized)) {
        seen.add(normalized);
        unique.push(normalized);
      }
    }

    // Heuristic: alternate user/assistant based on order of appearance
    // The first substantial text is usually the first message in the conversation
    for (let i = 0; i < unique.length; i++) {
      messages.push({
        content: unique[i],
        role: i % 2 === 0 ? 'user' : 'assistant'
      });
    }

    return messages;
  }

  /**
   * Capture conversation history from a Gemini history-load response.
   * Extracts all messages and dispatches KYT_MESSAGE_CAPTURED events.
   *
   * @param {Response} response - Cloned fetch Response object
   * @param {Object} metadata - Request metadata
   * @param {string} metadata.conversationId - Conversation ID hint
   * @param {string} metadata.rpcId - The RPC that loaded this conversation
   */
  async function captureConversationHistory(response, metadata) {
    try {
      if (!response?.body) return;

      const text = await response.text();
      if (!text || text.length < 50) return;

      const messages = extractConversationMessages(text);

      if (messages.length === 0) {
        // Diagnostic: log what we got so we can tune the parser
        console.log('KYT Gemini [history]: No messages found in response from RPC:', metadata.rpcId, {
          responseLen: text.length,
          preview: text.substring(0, 500),
          hasAntiXssi: text.startsWith(")]}'"),
        });
        // Also log the parsed frames for debugging
        try {
          let cleaned = text;
          if (cleaned.startsWith(")]}'")) cleaned = cleaned.substring(cleaned.indexOf('\n') + 1);
          const frameLines = cleaned.split('\n').filter(l => l.trim() && !/^\d+$/.test(l.trim()));
          console.log('KYT Gemini [history]: Frames:', frameLines.length, 'parseable lines');
          for (let fi = 0; fi < Math.min(frameLines.length, 3); fi++) {
            try {
              const parsed = JSON.parse(frameLines[fi]);
              const strs = findAllStrings(parsed, 15);
              const longStrs = strs.filter(s => s.length > 10).slice(0, 5);
              console.log(`KYT Gemini [history]: Frame ${fi}:`, {
                topLevelLen: Array.isArray(parsed) ? parsed.length : 'not-array',
                allStrings: strs.length,
                longStrings: longStrs.map(s => s.substring(0, 120)),
              });
            } catch (_) {
              console.log(`KYT Gemini [history]: Frame ${fi}: unparseable (${frameLines[fi].substring(0, 100)})`);
            }
          }
        } catch (_) {}
        return;
      }

      const isInitPhase = (Date.now() - HISTORY_CAPTURE_START) < HISTORY_CAPTURE_INIT_MS;
      const conversationId = metadata.conversationId || 'history_' + Date.now();

      // Prevent re-capturing the same conversation
      if (_capturedConversationIds.has(conversationId)) {
        console.log('KYT Gemini [history]: Already captured conversation', conversationId);
        return;
      }
      _capturedConversationIds.add(conversationId);

      console.log(`KYT Gemini [history]: Found ${messages.length} messages in conversation ${conversationId} (init: ${isInitPhase})`);

      let captured = 0;
      for (const msg of messages) {
        const cleanContent = stripInjectionBlock(msg.content);
        if (!cleanContent || cleanContent.length < 2) continue;

        const messageData = {
          content: cleanContent,
          role: msg.role,
          conversationId: conversationId,
          model: 'gemini',
          timestamp: Date.now(),
          messageId: `msg_history_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          platform: 'gemini',
          source: isInitPhase ? 'initial-load' : 'history-load'
        };

        let shouldCapture = true;
        try {
          shouldCapture = window.KYT_Deduplicator.shouldCapture(messageData.content, 'history', messageData.messageId);
        } catch (_) { /* fail-open */ }

        if (shouldCapture) {
          window.dispatchEvent(new CustomEvent('KYT_MESSAGE_CAPTURED', {
            detail: messageData
          }));
          captured++;
        }
      }

      console.log(`KYT Gemini [history]: Captured ${captured}/${messages.length} messages from ${conversationId}`);

    } catch (error) {
      if (error.name === 'AbortError') return;
      console.error('KYT Gemini [history]: Error capturing conversation:', error);
    }
  }

  /**
   * Check if a body string looks like a Gemini message-send RPC.
   * Matches broadly: any body with an f.req param containing a parseable user message.
   */
  function isGeminiMessageRequest(urlString, bodyString) {
    if (!isGoogleDomain(urlString)) return false;
    if (!bodyString || typeof bodyString !== 'string') return false;

    // Fast check: does the body contain 'f.req=' (URL-encoded form with f.req param)?
    if (!bodyString.includes('f.req=') && !bodyString.includes('f.req%')) return false;

    // Verify f.req actually parses to something with a user message
    try {
      const params = new URLSearchParams(bodyString);
      const fReq = params.get('f.req');
      if (!fReq) return false;

      const parsed = parseFReq(fReq);
      if (parsed && parsed.userMessage && parsed.userMessage.length > 0) {
        return true;
      }
    } catch (_) {
      // Not a valid batchexecute payload
    }

    return false;
  }

  /**
   * Core message processing — shared between fetch and XHR interception.
   * Extracts user message, dispatches capture event, and optionally injects context.
   * @returns {string|null} Modified body string (with injected context), or null to use original.
   */
  async function processGeminiRequest(urlString, bodyString) {
    console.log('KYT Gemini: Intercepted message request:', urlString.substring(0, 120));

    try {
      const params = new URLSearchParams(bodyString);
      const fReq = params.get('f.req');

      const parsed = parseFReq(fReq);
      if (!parsed || !parsed.userMessage) {
        console.warn('KYT Gemini: Could not parse user message from f.req');
        return null;
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
        const injected = await getAndInjectContext(bodyString);
        return injected;
      } catch (error) {
        console.error('KYT Gemini: Context injection failed:', error);
        return null;
      }
    } catch (error) {
      console.error('KYT Gemini: Error processing request:', error);
      return null;
    }
  }

  // Google domains that Gemini might use for API calls
  const GOOGLE_API_DOMAINS = [
    'gemini.google.com',
    'alkalimakersuite-pa.clients6.google.com',
    'content-push.googleapis.com',
    'generativelanguage.googleapis.com',
    'clients6.google.com',
    '.google.com',
    '.googleapis.com',
    '.googleprod.com',
  ];

  function isGoogleDomain(urlString) {
    for (const domain of GOOGLE_API_DOMAINS) {
      if (urlString.includes(domain)) return true;
    }
    return false;
  }

  // Discovery mode: log ALL fetches for the first 60s to find the real API domain
  const DISCOVERY_START = Date.now();
  const DISCOVERY_DURATION_MS = 120000; // Extended to 2 min for history-load diagnosis

  window.fetch = async function(...args) {
    let [url, options] = args;
    let urlString = typeof url === 'string' ? url : (url?.url || String(url));
    // Resolve relative URLs to absolute (Gemini may use relative paths)
    try { urlString = new URL(urlString, window.location.origin).href; } catch (_) {}

    const isPost = options?.method === 'POST' || (options?.body && options?.method !== 'GET');

    // BROAD DISCOVERY: log ALL POST requests from the page for the first 60s
    // This is critical to find which domain Gemini actually sends API calls to
    const inDiscoveryPhase = (Date.now() - DISCOVERY_START) < DISCOVERY_DURATION_MS;
    if (isPost && inDiscoveryPhase) {
      try {
        const urlObj = new URL(urlString);
        const host = urlObj.hostname;
        const path = urlObj.pathname;
        const bodyType = options?.body?.constructor?.name || typeof options?.body;
        const cacheKey = host + path + ':' + bodyType;
        if (!discoveredEndpoints.has(cacheKey)) {
          discoveredEndpoints.add(cacheKey);
          const bodyStr = bodyToString(options?.body);
          const hasFReq = bodyStr ? (bodyStr.includes('f.req=') || bodyStr.includes('f.req%')) : 'unknown';
          console.log('KYT Gemini [fetch POST discovery]:', host + path, { bodyType, hasFReq, bodyLen: bodyStr?.length });
        }
      } catch (_) {}
    }

    // Skip non-Google requests for message processing
    if (!isGoogleDomain(urlString)) {
      return originalFetch.apply(this, args);
    }

    // Also log Google-domain POSTs after discovery period
    if (isPost && (Date.now() - DISCOVERY_START) >= DISCOVERY_DURATION_MS) {
      try {
        const urlObj = new URL(urlString);
        const host = urlObj.hostname;
        const path = urlObj.pathname;
        const bodyType = options?.body?.constructor?.name || typeof options?.body;
        const cacheKey = host + path + ':' + bodyType;
        if (!discoveredEndpoints.has(cacheKey)) {
          discoveredEndpoints.add(cacheKey);
          const bodyStr = bodyToString(options?.body);
          const hasFReq = bodyStr ? (bodyStr.includes('f.req=') || bodyStr.includes('f.req%')) : 'unknown';
          console.log('KYT Gemini [endpoint discovery]:', host + path, { bodyType, hasFReq, bodyLen: bodyStr?.length });
        }
      } catch (_) {}
    }

    // Coerce body to string (handles URLSearchParams, FormData, ArrayBuffer, etc.)
    let bodyString = bodyToString(options?.body);
    // Fall back to async for Blob/ReadableStream
    if (bodyString === null && options?.body) {
      bodyString = await bodyToStringAsync(options.body);
    }

    // Check if this is a Gemini message request (broad matching via f.req content)
    if (!isPost || !isGeminiMessageRequest(urlString, bodyString)) {
      // Not a message-send — but check if it's a conversation history load
      if (isPost && bodyString) {
        const historyInfo = isGeminiHistoryLoad(urlString, bodyString);
        if (historyInfo) {
          console.log('KYT Gemini [history]: Detected history-load RPC:', historyInfo.rpcId,
            historyInfo.conversationIdHint || '(no cid)');
          const response = await originalFetch.apply(this, args);
          if (response.ok) {
            captureConversationHistory(response.clone(), {
              conversationId: historyInfo.conversationIdHint || 'unknown',
              rpcId: historyInfo.rpcId
            }).catch(err => console.error('KYT Gemini [history]: Capture failed:', err));
          }
          return response;
        }

        // Discovery: log ALL Google-domain POST RPCs with f.req — request + response details
        // This runs for 2 minutes and does NOT dedup, so we see every RPC call
        if (inDiscoveryPhase && isGoogleDomain(urlString) && bodyString.includes('f.req')) {
          // Extract RPC details from request body
          let rpcLabel = 'unknown';
          let rpcArgPreview = '';
          try {
            const params = new URLSearchParams(bodyString);
            const fReq = params.get('f.req');
            if (fReq) {
              let p = JSON.parse(fReq);
              if (typeof p === 'string') p = JSON.parse(p);
              if (Array.isArray(p) && Array.isArray(p[0])) {
                const rpcs = Array.isArray(p[0][0]) ? p[0] : [p[0]];
                const labels = [];
                for (const rpc of rpcs) {
                  if (Array.isArray(rpc) && typeof rpc[0] === 'string') {
                    labels.push(rpc[0]);
                    if (typeof rpc[1] === 'string') {
                      rpcArgPreview += rpc[0] + ': ' + rpc[1].substring(0, 200) + '\n';
                    }
                  }
                }
                rpcLabel = labels.join(', ');
              }
            }
          } catch (_) {}

          console.log('KYT Gemini [RPC discovery REQUEST]:', {
            url: urlString.substring(0, 120),
            rpcIds: rpcLabel,
            bodyLen: bodyString.length,
            argPreview: rpcArgPreview.substring(0, 400)
          });

          const response = await originalFetch.apply(this, args);
          if (response.ok) {
            try {
              const clone = response.clone();
              const respText = await clone.text();

              // Parse frames and find longest text strings
              let longStrings = [];
              try {
                let cleaned = respText;
                if (cleaned.startsWith(")]}'")) cleaned = cleaned.substring(cleaned.indexOf('\n') + 1);
                for (const line of cleaned.split('\n')) {
                  const t = line.trim();
                  if (!t || /^\d+$/.test(t)) continue;
                  try {
                    const strs = findAllStrings(JSON.parse(t), 10);
                    for (const s of strs) {
                      if (s.length > 50) longStrings.push(s);
                    }
                  } catch (_) {}
                }
              } catch (_) {}
              longStrings = longStrings.slice(0, 5);

              console.log('KYT Gemini [RPC discovery RESPONSE]:', {
                rpcIds: rpcLabel,
                responseLen: respText.length,
                preview: respText.substring(0, 300),
                longStrings: longStrings.map(s => s.substring(0, 120)),
                hasConversationContent: longStrings.some(s => s.length > 100)
              });
            } catch (_) {}
          }
          return response;
        }
      }
      return originalFetch.apply(this, args);
    }

    // Process the message (capture + context injection)
    const injectedBody = await processGeminiRequest(urlString, bodyString);
    if (injectedBody) {
      // Replace the body with the context-injected version
      if (options) {
        options = { ...options, body: injectedBody };
        args = [url, options];
      }
    }

    // Make the actual request
    const response = await originalFetch.apply(this, args);

    // Best-effort response capture
    if (response.ok) {
      const finalBody = typeof options?.body === 'string' ? options.body : (bodyString || '');
      const fReqVal = new URLSearchParams(finalBody).get('f.req') || '';
      const parsed = parseFReq(fReqVal);
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

  // === XMLHttpRequest OVERRIDE ===
  // Gemini may use XHR instead of fetch for some or all API calls.

  if (!window.__kytOriginalXHROpen) window.__kytOriginalXHROpen = XMLHttpRequest.prototype.open;
  if (!window.__kytOriginalXHRSend) window.__kytOriginalXHRSend = XMLHttpRequest.prototype.send;
  const originalXHROpen = window.__kytOriginalXHROpen;
  const originalXHRSend = window.__kytOriginalXHRSend;

  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    this.__kytMethod = method;
    this.__kytUrl = typeof url === 'string' ? url : String(url);
    return originalXHROpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function(body) {
    const method = this.__kytMethod;
    // Resolve relative URLs (Gemini uses relative paths like /_/BardChatUi/...)
    let url = this.__kytUrl || '';
    try { url = new URL(url, window.location.origin).href; } catch (_) {}

    const isPost = method && method.toUpperCase() === 'POST';

    // BROAD DISCOVERY: log ALL XHR POST requests for the first 60s
    if (isPost && (Date.now() - DISCOVERY_START) < DISCOVERY_DURATION_MS) {
      try {
        const urlObj = new URL(url, window.location.origin);
        const host = urlObj.hostname;
        const path = urlObj.pathname;
        const bodyType = body?.constructor?.name || typeof body;
        const cacheKey = 'xhr:' + host + path + ':' + bodyType;
        if (!discoveredEndpoints.has(cacheKey)) {
          discoveredEndpoints.add(cacheKey);
          const bodyStr = bodyToString(body);
          const hasFReq = bodyStr ? (bodyStr.includes('f.req=') || bodyStr.includes('f.req%')) : 'unknown';
          console.log('KYT Gemini [XHR POST discovery]:', host + path, { bodyType, hasFReq, bodyLen: bodyStr?.length });
        }
      } catch (_) {}
    }

    // Skip non-Google domains for message processing
    if (!isGoogleDomain(url)) {
      return originalXHRSend.call(this, body);
    }

    if (isPost) {
      // Endpoint discovery for Google domains after discovery period
      try {
        const urlObj = new URL(url, window.location.origin);
        const host = urlObj.hostname;
        const path = urlObj.pathname;
        const bodyType = body?.constructor?.name || typeof body;
        const cacheKey = 'xhr:' + host + path + ':' + bodyType;
        if (!discoveredEndpoints.has(cacheKey)) {
          discoveredEndpoints.add(cacheKey);
          const bodyStr = bodyToString(body);
          const hasFReq = bodyStr ? (bodyStr.includes('f.req=') || bodyStr.includes('f.req%')) : 'unknown';
          console.log('KYT Gemini [XHR endpoint discovery]:', host + path, { bodyType, hasFReq, bodyLen: bodyStr?.length });
        }
      } catch (_) {}

      // Deep debug for batchexecute endpoint
      if (url.includes('batchexecute') || url.includes('BardChat') || url.includes('assistant.')) {
        const bodyStr2 = bodyToString(body);
        if (bodyStr2 && bodyStr2.includes('f.req')) {
          try {
            const debugParams = new URLSearchParams(bodyStr2);
            const fReqRaw = debugParams.get('f.req');
            // Log the raw f.req value to discover the real array structure
            console.log('KYT Gemini [f.req raw] (len=' + (fReqRaw?.length || 0) + '):', fReqRaw?.substring(0, 500));
            // Try parsing and log the structure
            if (fReqRaw) {
              let parsed = JSON.parse(fReqRaw);
              if (typeof parsed === 'string') parsed = JSON.parse(parsed);
              // Log the top-level shape
              if (Array.isArray(parsed)) {
                console.log('KYT Gemini [f.req structure]:', {
                  outerLen: parsed.length,
                  outer0Type: Array.isArray(parsed[0]) ? 'array[' + parsed[0].length + ']' : typeof parsed[0],
                  outer0_0Type: parsed[0] && Array.isArray(parsed[0][0]) ? 'array[' + parsed[0][0].length + ']' : typeof parsed[0]?.[0],
                  outer0_0_0: typeof parsed[0]?.[0]?.[0] === 'string' ? parsed[0][0][0].substring(0, 80) : typeof parsed[0]?.[0]?.[0],
                  outer0_0_1Preview: typeof parsed[0]?.[0]?.[1] === 'string' ? parsed[0][0][1].substring(0, 200) : typeof parsed[0]?.[0]?.[1],
                });
              }
            }
          } catch (e) {
            console.log('KYT Gemini [f.req parse error]:', e.message);
          }
        }
      }

      // Try to process as a Gemini message request
      const bodyString = bodyToString(body);
      if (bodyString && isGeminiMessageRequest(url, bodyString)) {
        // Capture the message synchronously (XHR.send is sync — can't await context injection)
        console.log('KYT Gemini [XHR]: Intercepted message request:', url.substring(0, 120));
        try {
          const params = new URLSearchParams(bodyString);
          const fReq = params.get('f.req');
          const parsed = parseFReq(fReq);

          if (parsed && parsed.userMessage) {
            const cleanContent = stripInjectionBlock(parsed.userMessage);
            const messageData = {
              content: cleanContent,
              role: 'user',
              conversationId: parsed.conversationId || 'unknown',
              model: 'gemini',
              timestamp: Date.now(),
              messageId: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
              platform: 'gemini'
            };

            let shouldCapture = true;
            try {
              shouldCapture = window.KYT_Deduplicator.shouldCapture(messageData.content, 'fetch', messageData.messageId);
            } catch (_) { /* fail-open */ }

            if (shouldCapture) {
              window.dispatchEvent(new CustomEvent('KYT_MESSAGE_CAPTURED', { detail: messageData }));
              console.log('KYT Gemini [XHR]: User message captured (' + messageData.content.length + ' chars)');
            }
          }
        } catch (error) {
          console.error('KYT Gemini [XHR]: Error processing request:', error);
        }
      } else if (bodyString) {
        // Not a message-send — check if it's a conversation history load
        const historyInfo = isGeminiHistoryLoad(url, bodyString);
        if (historyInfo) {
          console.log('KYT Gemini [XHR history]: Detected history-load RPC:', historyInfo.rpcId);
          // XHR is sync so we capture the response via load event
          const xhr = this;
          xhr.addEventListener('load', function() {
            try {
              if (xhr.status >= 200 && xhr.status < 300 && xhr.responseText) {
                captureConversationHistory(
                  { body: true, text: () => Promise.resolve(xhr.responseText) },
                  {
                    conversationId: historyInfo.conversationIdHint || 'unknown',
                    rpcId: historyInfo.rpcId
                  }
                ).catch(err => console.error('KYT Gemini [XHR history]: Capture failed:', err));
              }
            } catch (_) {}
          }, { once: true });
        }
      }
    }

    return originalXHRSend.call(this, body);
  };

  console.log('KYT Gemini: XHR wrapper installed');

  // === HEALTH CHECK API ===
  window.KYT_Gemini_Health = {
    getStats: function() {
      return {
        deduplication: window.KYT_Deduplicator.getStats(),
        contextInjection: {
          enabled: true,
          status: 'Context injection ENABLED'
        },
        historyCapture: {
          capturedConversations: Array.from(_capturedConversationIds),
          initPhaseActive: (Date.now() - HISTORY_CAPTURE_START) < HISTORY_CAPTURE_INIT_MS,
          discoveryPhaseActive: (Date.now() - DISCOVERY_START) < DISCOVERY_DURATION_MS,
          discoveredEndpoints: Array.from(discoveredEndpoints).slice(0, 30)
        },
        platform: 'gemini',
        timestamp: Date.now()
      };
    },
    resetStats: function() {
      window.KYT_Deduplicator.resetStats();
    },
    // Manual diagnostic: test if a response text contains extractable messages
    testExtract: function(responseText) {
      const messages = extractConversationMessages(responseText);
      console.log('KYT Gemini [manual extract]:', messages.length, 'messages found');
      messages.forEach((m, i) => console.log(`  [${i}] ${m.role}: ${m.content.substring(0, 100)}`));
      return messages;
    },
    // Manual diagnostic: reset captured conversation set (allows re-capture)
    resetHistoryCapture: function() {
      _capturedConversationIds.clear();
      console.log('KYT Gemini: History capture state reset');
    }
  };

  window.getInterceptionStats = function() {
    return window.KYT_Gemini_Health.getStats();
  };

  console.log('KYT Gemini: Fetch + XHR wrappers installed - ready to capture messages');

  // === NAVIGATOR.SENDBEACON OVERRIDE ===
  // Some Google apps use sendBeacon for analytics; unlikely for messages but check anyway.
  if (!window.__kytOriginalSendBeacon) window.__kytOriginalSendBeacon = navigator.sendBeacon?.bind(navigator);
  const originalSendBeacon = window.__kytOriginalSendBeacon;
  if (originalSendBeacon) {
    navigator.sendBeacon = function(url, data) {
      if (typeof url === 'string' && url.includes('gemini.google.com')) {
        const bodyStr = bodyToString(data);
        if (bodyStr && bodyStr.includes('f.req')) {
          console.log('KYT Gemini [sendBeacon]: Detected f.req in sendBeacon to', url.substring(0, 100));
        }
      }
      return originalSendBeacon(url, data);
    };
  }

  // === DIAGNOSTIC PROBE ===
  // Logs once after 3 seconds to confirm everything is wired up
  setTimeout(() => {
    const fetchOverridden = window.fetch !== originalFetch;
    const xhrOpenOverridden = XMLHttpRequest.prototype.open !== originalXHROpen;
    const xhrSendOverridden = XMLHttpRequest.prototype.send !== originalXHRSend;
    console.log('KYT Gemini [diagnostic]:', {
      fetchOverridden,
      xhrOpenOverridden,
      xhrSendOverridden,
      discoveredEndpoints: Array.from(discoveredEndpoints).slice(0, 20),
      endpointCount: discoveredEndpoints.size
    });
  }, 3000);
}
