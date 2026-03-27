/**
 * KYT Memory Extension - ChatGPT Inject Script
 *
 * This script runs in the PAGE CONTEXT (not content script context)
 * allowing it to wrap fetch at the same level as other page scripts.
 *
 * Platform: ChatGPT
 */

(function () {
  'use strict';

  // PHASE 1 FIX #3: Duplicate injection guard
  if (window.KYT_CHATGPT_INJECTED) {
    console.log('⚠️ KYT ChatGPT already injected, skipping duplicate injection');
    return;
  }
  window.KYT_CHATGPT_INJECTED = true;

  console.log('🚀 KYT ChatGPT Inject: Initializing in page context...');

  // Helper to send logs to background
  function logToBackground(message, data = null) {
    window.dispatchEvent(new CustomEvent('KYT_DEBUG_LOG', {
      detail: { message, data }
    }));
  }

  logToBackground('Inject script initialized');

  /**
   * Extract clean text from ChatGPT message content parts.
   * Handles: plain strings, audio_transcription JSON strings/objects, mixed parts.
   * Skips: audio_asset_pointer, audio_video_asset_pointer, binary metadata.
   */
  function extractTextFromParts(parts) {
    if (!Array.isArray(parts) || parts.length === 0) return null;
    const texts = [];
    for (const part of parts) {
      if (typeof part === 'string') {
        // Check if it's a JSON-encoded audio transcription
        if (part.startsWith('{') && part.includes('content_type')) {
          try {
            const obj = JSON.parse(part);
            if (obj.content_type === 'audio_transcription' && obj.text) {
              texts.push(obj.text);
              continue;
            }
            // Skip non-text content types (audio_asset_pointer, etc.)
            if (obj.content_type && obj.content_type !== 'text') continue;
          } catch (_) {}
        }
        // Plain text string
        if (part.trim().length > 0) texts.push(part);
      } else if (part && typeof part === 'object') {
        // Object-form audio transcription
        if (part.content_type === 'audio_transcription' && part.text) {
          texts.push(part.text);
        } else if (part.content_type === 'text' && part.text) {
          texts.push(part.text);
        }
        // Skip audio_asset_pointer and other non-text objects
      }
    }
    return texts.length > 0 ? texts.join('\n\n') : null;
  }

  // CONFIGURATION: Fetch-based capture enabled for V3 compatibility
  // We use this to capture the conversation tree from POST /conversation response
  const ENABLE_FETCH_CAPTURE = true;

  // === DEDUPLICATION LAYER ===
  /**
   * Message Deduplication Layer
   * Prevents duplicate captures from multiple sources (WebSocket, fetch, DOM)
   * Uses content hashing and confidence-based priority
   */
  class MessageDeduplicator {
    constructor(options = {}) {
      this.recentMessages = new Map();
      this.dedupeWindow = options.dedupeWindow || 5000; // 5 seconds
      this.cleanupInterval = setInterval(() => this.cleanup(), 2000); // Run every 2s (faster than 5s dedupe window)
      this.stats = {
        totalAttempts: 0,
        captured: 0,
        duplicatesSkipped: 0,
        upgradeCaptures: 0
      };
    }

    shouldCapture(content, captureMethod) {
      this.stats.totalAttempts++;
      const normalizedContent = this.normalizeContent(content);
      const hash = this.hashContent(normalizedContent);
      const now = Date.now();
      const confidence = this.getConfidence(captureMethod);

      if (this.recentMessages.has(hash)) {
        const lastCapture = this.recentMessages.get(hash);
        const timeSinceCapture = now - lastCapture.timestamp;

        if (timeSinceCapture < this.dedupeWindow) {
          if (confidence > lastCapture.confidence) {
            console.log(`🔄 KYT Dedupe: Upgrading ${lastCapture.captureMethod} (${lastCapture.confidence}%) → ${captureMethod} (${confidence}%)`);
            this.recentMessages.set(hash, { timestamp: now, confidence, captureMethod });
            this.stats.upgradeCaptures++;
            return true;
          } else {
            console.log(`⏭️ KYT Dedupe: Skipping duplicate (${captureMethod} ${confidence}% <= ${lastCapture.captureMethod} ${lastCapture.confidence}%)`);
            this.stats.duplicatesSkipped++;
            return false;
          }
        }
      }

      this.recentMessages.set(hash, { timestamp: now, confidence, captureMethod });
      this.stats.captured++;
      return true;
    }

    getConfidence(method) {
      const map = { 'websocket': 95, 'fetch': 95, 'fetch_tree': 95, 'dom': 70 };
      return map[method] || 50;
    }

    normalizeContent(content) {
      return String(content).trim().replace(/\s+/g, ' ').toLowerCase();
    }

    hashContent(content) {
      let hash = 0;
      for (let i = 0; i < content.length; i++) {
        const char = content.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash;
      }
      return hash.toString(36);
    }

    cleanup() {
      const now = Date.now();
      const cutoff = now - this.dedupeWindow;
      let removed = 0;
      for (const [hash, entry] of this.recentMessages.entries()) {
        if (entry.timestamp < cutoff) {
          this.recentMessages.delete(hash);
          removed++;
        }
      }

      if (removed > 0) {
        console.log(`🧹 KYT Dedupe: Cleaned up ${removed} old entries`);
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

    destroy() {
      if (this.cleanupInterval) {
        clearInterval(this.cleanupInterval);
        this.cleanupInterval = null;
      }
      this.recentMessages.clear();
    }
  }

  // Create singleton deduplicator instance
  window.KYT_Deduplicator = new MessageDeduplicator();
  console.log('🔄 KYT ChatGPT: Deduplication layer initialized in page context');

  // Track interception health
  let lastInterceptionTime = Date.now();
  let totalInterceptions = 0;
  let totalErrors = 0;

  // Platform-specific detection and extraction
  const platform = {
    name: 'chatgpt',

    detectAPICall: function (url, options) {
      // DEBUG: Log all fetch URLs to identify changes
      // logToBackground('Fetch intercepted', { url: url.substring(0, 100), method: options?.method });

      const isChatGPTAPI = (
        typeof url === 'string' &&
        (
          url.includes('/backend-api/') || // General backend-api check
          url.includes('/backend-api/lat/r') || // Latency/Realtime endpoint
          (url.includes('/conversation') && (options?.method === 'POST' || options?.method === 'GET' || !options?.method)) // Broader fallback
        )
      );
      // Allow GET requests too (for conversation history fetch)
      const isPostRequest = options?.method === 'POST' || options?.body;
      const isGetRequest = options?.method === 'GET' || !options?.method;

      return isChatGPTAPI && (isPostRequest || isGetRequest);
    },
    extractConversationId: function (url) {
      // Extract from URL if possible (not always available in ChatGPT API calls)
      return 'unknown'; // ChatGPT usually puts it in the body
    },

    /**
     * Strip K.Y.T. Memory Injection Protocol blocks from content
     * Prevents recursive pollution where injection blocks get saved as memories
     * @param {string} content - Message content that may contain injection blocks
     * @returns {string} - Clean content without injection blocks
     */
    stripInjectionBlock: function (content) {
      // AGGRESSIVE PATTERN: Strip ANYTHING that looks like a K.Y.T. injection block
      // This catches blocks even if truncated, malformed, or missing end markers

      // Pattern 1: Any content starting with K.Y.T. header until end marker OR next user message
      const kytHeaderPattern = /={3,}[\s\S]*?K\.Y\.T\.[\s\S]*?(?:={3,}|$)/g;

      // Pattern 2: SESSION_CONTEXT, RETRIEVAL_CONTEXT, DATA_PROVENANCE blocks
      const contextBlockPattern = /\[(SESSION_CONTEXT|RETRIEVAL_CONTEXT|DATA_PROVENANCE|Retrieved Items)\][\s\S]*?(?=\n\n[^\[]|$)/g;

      // Pattern 3: Standalone context markers
      const standaloneMarkers = /\[(?:Memory Context|Query Optimized|End of (?:Memory|Knowledge Base) Context)\][^\n]*/g;

      // Pattern 4: Separator lines (80+ equals signs)
      const separatorPattern = /={80,}/g;

      // Pattern 5: Natural-language context blocks (appended to user message)
      const naturalLangPattern = /\(For context: I've talked about[\s\S]*?I'm sharing these so you have the full picture[^)]*\.\)/g;

      let cleaned = content;

      // Apply all patterns
      cleaned = cleaned.replace(kytHeaderPattern, '');
      cleaned = cleaned.replace(contextBlockPattern, '');
      cleaned = cleaned.replace(standaloneMarkers, '');
      cleaned = cleaned.replace(separatorPattern, '');
      cleaned = cleaned.replace(naturalLangPattern, '');

      // Clean up excessive whitespace/newlines left by removals
      cleaned = cleaned.replace(/\n{3,}/g, '\n\n').trim();

      return cleaned;
    },

    extractMessage: function (bodyString) {
      try {
        const body = JSON.parse(bodyString);

        if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
          throw new Error('Invalid message structure');
        }

        const lastMessage = body.messages[body.messages.length - 1];
        let content = null;
        let role = lastMessage?.author?.role || lastMessage?.role || 'user'; // Default to 'user' (DB constraint)

        if (lastMessage?.content?.parts && Array.isArray(lastMessage.content.parts)) {
          content = extractTextFromParts(lastMessage.content.parts);
          if (!content) content = lastMessage.content.parts[0]; // fallback to raw
        } else if (typeof lastMessage?.content === 'string') {
          content = lastMessage.content;
        }

        if (!content || typeof content !== 'string') {
          throw new Error('No valid content found');
        }

        // CRITICAL: Strip injection blocks BEFORE saving
        const cleanedContent = this.stripInjectionBlock(content);

        return {
          content: cleanedContent.trim(),
          role: role,
          conversationId: body.conversation_id || 'unknown',
          model: body.model || 'unknown',
          timestamp: Date.now(),
          messageId: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          platform: 'chatgpt'
        };
      } catch (error) {
        console.error('❌ KYT ChatGPT: Extraction error:', error.message);
        return null;
      }
    }
  };

  /**
   * PHASE 1 FIX #1: Persistent event listener pattern
   * Map to track pending context requests - prevents garbage collection
   */
  const pendingContextRequests = new Map();

  /**
   * Check if a context error is recoverable (extension just reloaded, new content.js being injected)
   */
  function isRecoverableContextError(errorMsg) {
    return typeof errorMsg === 'string' && (
      errorMsg.includes('Extension context invalidated') ||
      errorMsg.includes('Service worker disconnected') ||
      errorMsg.includes('Service worker cooling down') ||
      errorMsg.includes('Service worker did not respond')
    );
  }

  /**
   * Persistent listener for context responses
   * Lives at module level - never garbage collected
   */
  window.addEventListener('KYT_CONTEXT_RESPONSE', (event) => {
    const { requestId } = event.detail;
    const pending = pendingContextRequests.get(requestId);

    if (pending) {
      // Retry once on recoverable errors — gives re-injection time to complete
      if (!event.detail.success && !pending.retried && isRecoverableContextError(event.detail.error)) {
        pending.retried = true;
        console.log('🔄 KYT ChatGPT: Context failed (recoverable), retrying in 3s...');
        setTimeout(() => {
          if (!pendingContextRequests.has(requestId)) return; // Already timed out
          window.dispatchEvent(new CustomEvent('KYT_CONTEXT_REQUEST', {
            detail: {
              requestId: requestId,
              userMessage: pending.userMessage,
              config: pending.config
            }
          }));
        }, 3000);
        return; // Don't resolve yet — wait for retry response
      }

      clearTimeout(pending.timeout);
      pendingContextRequests.delete(requestId);

      if (event.detail.success && event.detail.formattedContext) {
        console.log('✅ KYT ChatGPT: Context received, injecting...');
        console.log('📝 Context items:', event.detail.items?.length || 0);
        console.log('📄 Context preview:', event.detail.formattedContext?.substring(0, 200) + '...');

        // Append context to user's own message (not a separate system message).
        // ChatGPT's backend validates the messages array schema strictly and
        // silently strips injected system messages that lack valid id/create_time.
        // Embedding context in the user's message guarantees it reaches the model.
        const lastMessage = pending.body.messages[pending.body.messages.length - 1];
        if (lastMessage?.content?.parts && Array.isArray(lastMessage.content.parts)) {
          const originalText = typeof lastMessage.content.parts[0] === 'string'
            ? lastMessage.content.parts[0]
            : '';
          lastMessage.content.parts[0] = originalText + '\n\n' + event.detail.formattedContext;
          console.log('🔧 Context appended to user message (' + event.detail.formattedContext.length + ' chars)');
        } else {
          console.warn('⚠️ KYT ChatGPT: Could not append context — unexpected message structure');
        }

        pending.resolve(JSON.stringify(pending.body));
      } else {
        console.log('ℹ️ KYT ChatGPT: No context found or error');
        console.log('   Response success:', event.detail.success);
        console.log('   Has formattedContext:', !!event.detail.formattedContext);
        console.log('   Error:', event.detail.error);
        pending.resolve(pending.originalBody);
      }
    }
  });

  /**
   * Request context from background and inject into message
   */
  async function getAndInjectContext(bodyString) {
    try {
      // Safety check: ensure body is a string
      if (typeof bodyString !== 'string') {
        return bodyString;
      }
      const body = JSON.parse(bodyString);

      // Extract user message
      if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
        return bodyString; // No modification
      }

      const lastMessage = body.messages[body.messages.length - 1];
      let userContent = null;

      if (lastMessage?.content?.parts && Array.isArray(lastMessage.content.parts)) {
        userContent = extractTextFromParts(lastMessage.content.parts);
        if (!userContent) userContent = lastMessage.content.parts[0]; // fallback
      } else if (typeof lastMessage?.content === 'string') {
        userContent = lastMessage.content;
      }

      if (!userContent || typeof userContent !== 'string') {
        return bodyString; // No modification
      }

      console.log('🔍 KYT ChatGPT: Requesting context for:', userContent.substring(0, 50) + '...');

      // Generate unique request ID
      const requestId = `ctx_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

      return new Promise((resolve) => {
        // 30s MAIN world timeout — leaves 5s margin after 25s background timeout
        const timeout = setTimeout(() => {
          pendingContextRequests.delete(requestId);
          console.error('⏱️ KYT ChatGPT: Context timeout after 30s', {
            requestId: requestId,
            userMessage: userContent.substring(0, 50),
            pendingRequests: pendingContextRequests.size
          });
          resolve(bodyString);
        }, 30000);

        // Config for context request
        const contextConfig = {
          threshold: 0.5, // pgvector distance: lower = stricter, 0.5 = balanced
          maxContextItems: 5, // Increased from 3 for more context
          debugMode: false
        };

        // Store request in Map - prevents garbage collection
        // userMessage + config stored for retry on recoverable errors
        pendingContextRequests.set(requestId, {
          resolve: resolve,
          timeout: timeout,
          body: body,
          originalBody: bodyString,
          userMessage: userContent,
          config: contextConfig
        });

        // Dispatch context request
        console.log('📤 KYT ChatGPT: Dispatching context request:', requestId);
        window.dispatchEvent(new CustomEvent('KYT_CONTEXT_REQUEST', {
          detail: {
            requestId: requestId,
            userMessage: userContent,
            config: contextConfig
          }
        }));
      });
    } catch (error) {
      console.error('❌ KYT ChatGPT: Context injection error:', error);
      return bodyString; // Error - proceed with original
    }
  }

  /**
   * Override fetch in page context
   */
  // Idempotent: always wrap the TRUE original fetch, not an already-wrapped version.
  // This makes re-injection safe after extension reload.
  if (!window.__kytOriginalFetch) window.__kytOriginalFetch = window.fetch;
  const originalFetch = window.__kytOriginalFetch;

  window.fetch = async function (...args) {
    const [resource, config] = args;
    let url = resource;
    let options = config;

    // Handle Request object as first argument
    // CRITICAL FIX: Request.body is a ReadableStream, not a string!
    // We must clone the request and read its body as text before processing
    if (resource instanceof Request) {
      url = resource.url;

      // Clone the request to read its body (body can only be read once)
      let bodyText = null;
      try {
        if (resource.body) {
          const clonedRequest = resource.clone();
          bodyText = await clonedRequest.text();
        }
      } catch (e) {
        console.warn('⚠️ KYT ChatGPT: Failed to read Request body:', e);
      }

      // Merge options from Request object and config
      options = {
        method: resource.method,
        headers: resource.headers,
        body: bodyText,  // FIX: Use extracted text, not ReadableStream
        mode: resource.mode,
        credentials: resource.credentials,
        cache: resource.cache,
        redirect: resource.redirect,
        referrer: resource.referrer,
        referrerPolicy: resource.referrerPolicy,
        integrity: resource.integrity,
        keepalive: resource.keepalive,
        signal: resource.signal,
        ...config
      };

      // CRITICAL: Update args to use (url, options) instead of original Request
      // Otherwise originalFetch.apply(this, args) ignores our modifications
      args = [url, options];
    }

    // Ensure url is a string for checks
    const urlString = String(url);

    // DIAGNOSTIC: Log ALL backend-api calls with details (for debugging capture issues)
    if (urlString.includes('/backend-api/') || urlString.includes('chatgpt.com/api')) {
      console.log('🔍 KYT DIAG Fetch:', {
        url: urlString.substring(0, 150),
        method: options?.method || 'GET',
        hasBody: !!options?.body,
        bodyPreview: options?.body ? String(options.body).substring(0, 100) : null
      });
    }

    // DEBUG: Log all fetch URLs to identify changes
    if (urlString.includes('/backend-api/')) {
      logToBackground('Fetch intercepted', { url: urlString.substring(0, 100), method: options?.method || 'GET' });
    }

    // Check if this is a platform API call
    const isChatGPTAPI = platform.detectAPICall(urlString, options);

    // Check if this is a GET request to fetch conversation (mobile sync scenario)
    const isConversationFetch = isChatGPTAPI &&
      (!options?.body) &&
      urlString.includes('/backend-api/conversation/') &&
      !urlString.includes('/conversation/gen_title') &&
      !urlString.includes('/conversation/init');

    if (isConversationFetch) {
      // Handle GET requests that fetch full conversation JSON (mobile-synced messages)
      console.log('🔍 KYT ChatGPT: Intercepted conversation fetch (GET):', urlString.substring(0, 100));

      // Extract conversation ID from URL
      const match = urlString.match(/\/conversation\/([a-f0-9-]+)/);
      const conversationId = match ? match[1] : 'unknown';

      const response = await originalFetch.apply(this, args);

      if (response.ok && ENABLE_FETCH_CAPTURE) {
        const contentType = response.headers.get('content-type') || '';

        console.log('🔍 KYT DIAG Response (GET):', {
          url: urlString.substring(0, 100),
          status: response.status,
          contentType: contentType,
          conversationId: conversationId
        });

        if (contentType.includes('application/json')) {
          const clone = response.clone();
          clone.json().then(json => {
            if (json && json.mapping) {
              console.log('🎯 KYT ChatGPT: Captured conversation tree from GET (mobile sync)');
              processConversationTree(json);
            }
          }).catch(err => console.warn('⚠️ KYT ChatGPT: Error parsing GET response:', err));
        }
      }

      return response;
    }

    if (isChatGPTAPI && options?.body) {
      // DEBUG: Log ALL backend-api calls to find voice endpoint
      console.log('🔍 KYT ChatGPT: Intercepted API call:', url);

      // Check if this is a voice-related endpoint
      if (url.includes('/voice/') || url.includes('/speech/') || url.includes('/audio/')) {
        console.log('🎤 KYT ChatGPT: Potential voice endpoint found:', url);
      }

      console.log('🎯 KYT ChatGPT: Processing conversation API call');
      totalInterceptions++;
      lastInterceptionTime = Date.now();

      // FIX: Extract metadata BEFORE modifying options.body
      let conversationId = 'unknown';
      let modelName = 'gpt-unknown';
      if (options.body && typeof options.body === 'string') {
        try {
          const originalBody = JSON.parse(options.body);
          conversationId = originalBody.conversation_id || 'unknown';
          modelName = originalBody.model || 'gpt-unknown';
        } catch (e) {
          // Silent fail for non-JSON bodies
        }
      } else if (url.includes('/conversation/')) {
        // Extract conversation ID from URL for GET requests
        const match = url.match(/\/conversation\/([a-f0-9-]+)/);
        if (match) {
          conversationId = match[1];
          console.log('🆔 KYT ChatGPT: Extracted conversation ID from URL:', conversationId);
        }
      }

      // PHASE 1: Get context and inject BEFORE sending
      if (options.body && typeof options.body === 'string') {
        try {
          options.body = await getAndInjectContext(options.body);
          // Ensure args uses the modified options
          args = [url, options];
        } catch (error) {
          console.error('❌ KYT ChatGPT: Pre-send context injection failed:', error);
        }
      }

      // Continue with original fetch (with modified body if context was injected)
      const response = await originalFetch.apply(this, args);

      // PHASE 2: Capture response (Assistant + User Voice)
      if (response.ok && ENABLE_FETCH_CAPTURE) {
        const contentType = response.headers.get('content-type') || '';

        // DIAGNOSTIC: Log response details to identify content-type changes
        console.log('🔍 KYT DIAG Response:', {
          url: urlString.substring(0, 100),
          status: response.status,
          contentType: contentType
        });

        if (contentType.includes('application/json')) {
          // Handle full JSON response (common for initial load or non-streaming)
          const clone = response.clone();
          clone.json().then(json => {
            if (json && json.mapping) {
              console.log('🎯 KYT ChatGPT: Captured full conversation tree (JSON)');
              processConversationTree(json);
            }
          }).catch(err => console.warn('⚠️ KYT ChatGPT: Error parsing JSON response:', err));
        } else if (
          contentType.includes('text/event-stream') ||
          contentType.includes('text/plain') ||
          contentType.includes('application/octet-stream') ||
          contentType.includes('application/stream+json')
        ) {
          // Handle SSE stream (common for generation) - expanded content-type matching
          console.log('🌊 KYT ChatGPT: Capturing stream (type:', contentType, ')');
          captureResponseStream(response, {
            conversationId: conversationId,
            platform: 'chatgpt',
            model: modelName,
            timestamp: Date.now()
          }).catch(error => {
            console.error('❌ KYT ChatGPT: Failed to capture response stream:', error);
          });
        } else if (response.body) {
          // Fallback: If response has body but unknown content-type, try stream capture
          console.log('⚠️ KYT ChatGPT: Unknown content-type, attempting stream capture:', contentType);
          captureResponseStream(response, {
            conversationId: conversationId,
            platform: 'chatgpt',
            model: modelName,
            timestamp: Date.now()
          }).catch(() => {});
        }
      }

      return response;
    }

    // Non-API calls: just pass through
    return originalFetch.apply(this, args);
  };

  /**
   * Override WebSocket in page context for voice input capture
   * Voice messages use WebSocket (not fetch), so we need a separate interceptor
   * This captures voice transcripts at protocol level, immune to DOM changes
   */
  const OriginalWebSocket = window.WebSocket;

  window.WebSocket = function (...args) {
    const socket = new OriginalWebSocket(...args);

    // WebSocket capture is still disabled to avoid duplicates/noise
    // We rely on fetch capture of the conversation tree
    // if (!ENABLE_FETCH_CAPTURE) return socket; 

    const wsUrl = args[0];

    // Detect ChatGPT voice WebSocket
    // DEBUG: Log ALL WebSocket connections to find the right one
    console.log('🔌 KYT ChatGPT: WebSocket connection attempt:', wsUrl);

    if (typeof wsUrl === 'string' && (
      wsUrl.includes('ws.chatgpt.com') ||
      wsUrl.includes('chatgpt.com/ws') ||
      wsUrl.includes('/ws/user/') ||
      wsUrl.includes('wss://') // Catch all WSS for debugging
    )) {
      console.log('🎤 KYT ChatGPT: WebSocket intercepted (potential voice):', wsUrl);

      // Proxy the onmessage setter to capture events even if the app uses .onmessage = ...
      let originalOnMessage = null;
      Object.defineProperty(socket, 'onmessage', {
        get: () => originalOnMessage,
        set: (handler) => {
          originalOnMessage = handler;
          if (handler) {
            // Wrap the handler to intercept messages
            socket.addEventListener('message', async (event) => {
              // We don't need to call the handler here, the browser does that.
              // We just use this hook to ensure our listener is attached.
            });
          }
        }
      });

      // Intercept OUTGOING messages
      const originalSend = socket.send;
      socket.send = function (data) {
        try {
          // Log outgoing data for debugging voice
          if (typeof data === 'string') {
            if (data.length < 500) {
              console.log('📤 KYT OUTGOING MSG:', data);
            } else {
              console.log('📤 KYT OUTGOING MSG (truncated):', data.substring(0, 200) + '...');
            }
          } else {
            console.log('📤 KYT OUTGOING MSG (binary):', data instanceof Blob ? 'Blob' : 'ArrayBuffer', data.byteLength || data.size);
          }
        } catch (err) {
          console.warn('⚠️ KYT ChatGPT: Error logging outgoing message:', err);
        }
        return originalSend.apply(this, arguments);
      };

      // Intercept incoming messages using addEventListener (standard)
      socket.addEventListener('message', async (event) => {
        try {
          let dataStr = null;

          // Handle different data types (Text, Blob, ArrayBuffer)
          if (typeof event.data === 'string') {
            dataStr = event.data;
          } else if (event.data instanceof Blob) {
            dataStr = await event.data.text();
          } else if (event.data instanceof ArrayBuffer) {
            dataStr = new TextDecoder().decode(event.data);
          }

          if (!dataStr) return;

          // DEBUG: Log raw message sample to identify protocol
          // Use a unique prefix to make it easy to find
          if (dataStr.length < 500) {
            console.log('📨 KYT RAW MSG:', dataStr);
          } else {
            console.log('📨 KYT RAW MSG (truncated):', dataStr.substring(0, 200) + '...');
          }

          // WebSocket messages are typically JSON
          let data;
          try {
            data = JSON.parse(dataStr);
          } catch (e) {
            // Not JSON - might be binary or custom format
            return;
          }

          // DIAGNOSTIC: Log ALL WebSocket message structures (for debugging voice capture)
          const msgType = data.type || data.event || data.kind || Object.keys(data).join(',');
          console.log('🔍 KYT WS DIAG:', {
            type: msgType,
            hasText: !!data.text,
            hasTranscript: !!data.transcript,
            hasContent: !!data.content || !!data.message?.content,
            hasItem: !!data.item,
            hasDelta: !!data.delta,
            keys: Object.keys(data).slice(0, 10)
          });

          // Handle array root elements (ChatGPT often sends [payload])
          if (Array.isArray(data)) {
            // If it's an array, we'll process each item or just the first one if it matches our criteria
            // For now, let's assume the relevant payload is one of the items
            const relevantItem = data.find(item =>
              item && (item.type === 'message' || item.type === 'transcript' || item.text || item.transcript)
            );
            if (relevantItem) {
              data = relevantItem;
            } else if (data.length > 0) {
              // Fallback: just take the first item
              data = data[0];
            }
          }

          // Voice transcripts come in various formats, try to detect:
          // - data.type === 'transcript'
          // - data.text (transcript text)
          // - data.message.content (alternate format)
          // - data.payload.payload.text (nested conversation turn)
          let transcriptText = null;

          // DEBUG: Log full object structure for "message" types to find the transcript
          if (data.type === 'message' || data.type === 'transcript') {
            console.log('🔍 KYT WS DEBUG:', JSON.stringify(data).substring(0, 500));
          }

          if (data.type === 'transcript' && data.text) {
            transcriptText = data.text;
          } else if (data.text) {
            transcriptText = data.text;
          } else if (data.message?.content) {
            // Handle both string and object content (standard ChatGPT format)
            if (typeof data.message.content === 'string') {
              transcriptText = data.message.content;
            } else if (data.message.content.parts && Array.isArray(data.message.content.parts)) {
              transcriptText = data.message.content.parts[0];
            }
          } else if (data.item?.content) {
            // Handle "conversation_item_created" format
            if (typeof data.item.content === 'string') {
              transcriptText = data.item.content;
            } else if (data.item.content.parts && Array.isArray(data.item.content.parts)) {
              transcriptText = data.item.content.parts[0];
            }
          } else if (data.transcript) {
            transcriptText = data.transcript;
          } else if (data.payload?.text) {
            // Common pattern in some voice protocols
            transcriptText = data.payload.text;
          } else if (data.payload?.payload?.text) {
            // Deeply nested payload
            transcriptText = data.payload.payload.text;
          } else if (data.payload?.payload?.content?.parts) {
            // Conversation turn structure
            transcriptText = extractTextFromParts(data.payload.payload.content.parts) ||
                             data.payload.payload.content.parts[0];
          }

          // OpenAI Realtime API formats (new voice protocol)
          if (!transcriptText) {
            if (data.type === 'response.audio_transcript.delta' && data.delta) {
              transcriptText = data.delta;
            } else if (data.type === 'conversation.item.input_audio_transcription.completed' && data.transcript) {
              transcriptText = data.transcript;
            } else if (data.type === 'input_audio_buffer.speech_stopped' && data.transcript) {
              transcriptText = data.transcript;
            } else if (data.type === 'response.text.delta' && data.delta) {
              transcriptText = data.delta;
            } else if (data.response?.output?.[0]?.content?.[0]?.transcript) {
              transcriptText = data.response.output[0].content[0].transcript;
            } else if (data.type === 'conversation.item.created' && data.item?.content?.[0]?.transcript) {
              transcriptText = data.item.content[0].transcript;
            }
          }

          if (transcriptText && transcriptText.trim().length > 0) {
            console.log('🎤 KYT ChatGPT: Voice transcript captured:', transcriptText.substring(0, 50) + '...');

            // DEDUPLICATION CHECK: Skip duplicates (with error boundary)
            let shouldCapture = true; // Default: always capture (fail-open)
            try {
              if (window.KYT_Deduplicator) {
                shouldCapture = window.KYT_Deduplicator.shouldCapture(transcriptText, 'websocket');
              }
            } catch (dedupeError) {
              console.error('❌ KYT ChatGPT: Deduplication error, capturing anyway:', dedupeError);
              if (window.KYT_Deduplicator?._recordError) {
                window.KYT_Deduplicator._recordError(dedupeError);
              }
            }

            if (!shouldCapture) {
              console.log('⏭️ KYT ChatGPT: Duplicate voice message skipped by deduplicator');
              return; // Skip dispatch
            }

            // Dispatch captured voice message
            window.dispatchEvent(new CustomEvent('KYT_MESSAGE_CAPTURED', {
              detail: {
                content: transcriptText,
                role: 'user',
                source: 'chatgpt',
                captureMethod: 'websocket',
                timestamp: Date.now(),
                conversationId: data.conversation_id || 'unknown',
                platform: 'chatgpt'
              }
            }));

            totalInterceptions++;
            lastInterceptionTime = Date.now();
          }
        } catch (error) {
          // Silently ignore parse errors (WebSocket may send non-JSON data like pings)
          if (error.name !== 'SyntaxError') {
            console.warn('⚠️ KYT ChatGPT: WebSocket message parse error:', error);
          }
        }
      });

      // Log WebSocket connection lifecycle for debugging
      socket.addEventListener('open', () => {
        console.log('🎤 KYT ChatGPT: WebSocket opened');
      });

      socket.addEventListener('close', () => {
        console.log('🎤 KYT ChatGPT: WebSocket closed');
      });

      socket.addEventListener('error', (error) => {
        console.error('❌ KYT ChatGPT: WebSocket error:', error);
        totalErrors++;
      });
    }

    return socket;
  };

  /**
   * PHASE 1.5: Capture streaming response (Assistant + User Voice)
   * Reads SSE stream and extracts messages
   */
  async function captureResponseStream(response, metadata) {
    try {
      if (!response || !response.body) return;

      // STREAMING STATE: Signal that streaming is active (prevents DOM observer from capturing partials)
      window.dispatchEvent(new CustomEvent('KYT_STREAM_STATE', { detail: { streaming: true } }));

      const clonedResponse = response.clone();
      const reader = clonedResponse.body.getReader();
      const decoder = new TextDecoder();

      let assistantText = '';
      let assistantMessageId = null;
      let assistantCreateTime = null;
      let chunkCount = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        chunkCount++;
        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split('\n');

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.substring(6).trim();
          if (data === '[DONE]') continue;

          try {
            const json = JSON.parse(data);

            // 1. Check for User Voice Message (in stream)
            // Structure: v.message.author.role === 'user' && metadata.voice_mode_message
            // Or standard message structure in data
            let messageNode = json.message || json.v?.message;

            if (messageNode && messageNode.author?.role === 'user') {
              const isVoice = messageNode.metadata?.voice_mode_message || false;
              const content = messageNode.content?.parts?.[0];

              if (content && typeof content === 'string' && content.length > 0) {
                // Found a user message in the stream!
                console.log(`🎙️ KYT Stream: Found USER message (${isVoice ? 'Voice' : 'Text'})`);

                window.dispatchEvent(new CustomEvent('KYT_MESSAGE_CAPTURED', {
                  detail: {
                    content: content,
                    role: 'user',
                    conversationId: metadata.conversationId,
                    model: metadata.model,
                    timestamp: (messageNode.create_time && messageNode.create_time > 1577836800 && messageNode.create_time < 1893456000)
                      ? messageNode.create_time * 1000 : Date.now(),
                    isVoice: isVoice,
                    platform: 'chatgpt',
                    captureMethod: 'sse_stream'
                  }
                }));
              }
            }

            // 2. Accumulate Assistant Response (Delta)
            // ... existing accumulation logic ...
            let content = null;

            // Format 1: Standard SSE with choices array
            if (json.choices?.[0]?.delta?.content) {
              content = json.choices[0].delta.content;
            }
            // Format 6: Delta/patch format with array
            else if (Array.isArray(json.v)) {
              for (const patch of json.v) {
                if (patch.p === '/message/content/parts/0' && patch.o === 'append' && typeof patch.v === 'string') {
                  content = (content || '') + patch.v;
                }
              }
            }
            // Format 6b: Delta format with single patch
            else if (json.o && json.v !== undefined && typeof json.v === 'string') {
              content = json.v;
            }

            if (content) {
              assistantText += content;
            }

            // Capture create_time from any message node in the stream
            // Fix #5: Range-validate epoch seconds (2020-01-01 to 2030-01-01)
            const ct = json.message?.create_time || json.create_time;
            if (ct && typeof ct === 'number' && ct > 1577836800 && ct < 1893456000) {
              assistantCreateTime = ct;
            }

            if (!assistantMessageId) {
              assistantMessageId = json.id || json.message_id || json.conversation_id;
            }

          } catch (e) {
            // Ignore parse errors
          }
        }
      }

      // Dispatch Assistant Message
      if (assistantText.trim().length > 0) {
        const assistantMessage = {
          content: assistantText.trim(),
          role: 'assistant',
          conversationId: metadata.conversationId,
          model: metadata.model,
          timestamp: (assistantCreateTime && assistantCreateTime > 1577836800 && assistantCreateTime < 1893456000)
            ? assistantCreateTime * 1000 : Date.now(),
          messageId: assistantMessageId || `msg_assistant_${Date.now()}`,
          platform: metadata.platform
        };

        console.log('🤖 KYT ChatGPT: Assistant response captured (Stream)');
        window.dispatchEvent(new CustomEvent('KYT_MESSAGE_CAPTURED', {
          detail: assistantMessage
        }));
      }

      // STREAMING STATE: Signal that streaming is complete
      window.dispatchEvent(new CustomEvent('KYT_STREAM_STATE', { detail: { streaming: false } }));

    } catch (error) {
      console.error('❌ KYT ChatGPT: Error capturing stream:', error);
      // Ensure streaming state is cleared even on error
      window.dispatchEvent(new CustomEvent('KYT_STREAM_STATE', { detail: { streaming: false } }));
    }
  }

  /**
   * VOICE INPUT CAPTURE (PoC): DOM-Based Observer
   *
   * WHY NEEDED: Voice input uses WebSocket (wss://ws.chatgpt.com/ws/user/...)
   * instead of fetch, so the fetch wrapper above doesn't intercept it.
   *
   * APPROACH: Watch DOM mutations for new text nodes containing user/assistant messages.
   *
   * FRAGILITY WARNING: This is DOM-sensitive and may break if ChatGPT changes HTML structure.
   * This is a PoC - robust solutions to be brainstormed after validation.
   */

  // Configuration: DOM observer is OPT-IN (disabled by default)
  // Fetch interception handles 95% of message capture
  const KYT_CONFIG = {
    enableDOMObserver: false, // Disabled in favor of fetch interception
    enableVoiceCapture: true, // Enabled for WebSocket voice capture
    debugMode: true
  };

  // ChatGPT-specific message container selectors
  // These are the actual DOM elements that contain real conversation messages
  // Updated with more resilient patterns for UI changes
  const MESSAGE_SELECTORS = [
    // Primary selectors (high specificity)
    '[data-message-author-role="user"]',
    '[data-message-author-role="assistant"]',

    // Conversation turn selectors (multiple patterns)
    '[data-testid*="conversation-turn"]',
    '[data-testid^="turn-"]',

    // Article-based selectors (common ChatGPT pattern)
    'article[data-scroll-anchor]',
    'article[class*="group"]',

    // Fallback selectors (broader but still specific to messages)
    '.text-message',
    '[role="article"]',
    'div[class*="message"]',

    // Structural fallback (wider net, more likely to catch changes)
    'main article',
    'main .group'
  ];

  // Noise filter patterns - DOM elements to IGNORE
  const NOISE_PATTERNS = [
    // UI elements
    'button', 'input', 'textarea', 'select',
    'nav', 'header', 'footer', 'aside',

    // ChatGPT-specific UI noise
    '[class*="timestamp"]',
    '[class*="copy-button"]',
    '[class*="regenerate"]',
    '[class*="feedback"]',
    '[aria-label*="Copy"]',
    '[aria-label*="Edit"]',
    '[aria-label*="Regenerate"]',

    // Code elements (will be captured with context, not alone)
    'code', 'pre',

    // Empty or whitespace-only containers
    '.empty', '[data-empty="true"]'
  ];

  // Check if node should be ignored (noise filtering)
  function isNoiseElement(node) {
    if (!node || !node.tagName) return true;

    const tagName = node.tagName.toLowerCase();
    // FIX: Handle SVG className which is an object (SVGAnimatedString)
    const className = (typeof node.className === 'string') ? node.className : (node.className?.baseVal || '');
    const ariaLabel = node.getAttribute('aria-label') || '';

    // Check tag names
    if (NOISE_PATTERNS.slice(0, 4).includes(tagName)) {
      return true;
    }

    // Check class and aria-label patterns
    for (const pattern of NOISE_PATTERNS.slice(4)) {
      if (pattern.startsWith('[class*=')) {
        const classPattern = pattern.match(/\[class\*="(.+?)"\]/)?.[1];
        if (classPattern && className.includes(classPattern)) {
          return true;
        }
      } else if (pattern.startsWith('[aria-label*=')) {
        const ariaPattern = pattern.match(/\[aria-label\*="(.+?)"\]/)?.[1];
        if (ariaPattern && ariaLabel.includes(ariaPattern)) {
          return true;
        }
      }
    }

    return false;
  }

  // Check if a node is within a message container
  function isMessageContainer(node) {
    if (!node || !node.matches) return false;
    return MESSAGE_SELECTORS.some(selector => {
      try {
        return node.matches(selector) || node.closest(selector);
      } catch (e) {
        return false;
      }
    });
  }

  // Track seen nodes to avoid duplicate captures
  const seenNodes = new WeakSet();
  let domCaptureCount = 0;

  // Track recent captures for deduplication
  const recentCaptures = new Map(); // messageHash -> timestamp
  const DEDUP_WINDOW = 5000; // 5 seconds

  // Simple hash function for content deduplication
  function simpleHash(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash) + str.charCodeAt(i);
      hash = hash & hash; // Convert to 32-bit integer
    }
    return hash.toString(36);
  }

  // Check if content was recently captured
  function isDuplicate(content) {
    const hash = simpleHash(content.substring(0, 100));
    const now = Date.now();

    // Clean old entries
    for (const [h, timestamp] of recentCaptures) {
      if (now - timestamp > DEDUP_WINDOW) {
        recentCaptures.delete(h);
      }
    }

    if (recentCaptures.has(hash)) {
      return true;
    }

    recentCaptures.set(hash, now);
    return false;
  }

  // Detect CSS code
  function looksLikeCSS(text) {
    const cssIndicators = [
      /\{[^}]*:[^}]*;[^}]*\}/,  // Has CSS property syntax
      /\.[a-zA-Z][\w-]*\s*\{/,   // Class selector
      /@(media|keyframes|import|font-face)/i, // At-rules
      /!important/i,              // !important
      /:\s*var\(--[\w-]+\)/       // CSS variables
    ];
    return cssIndicators.some(pattern => pattern.test(text));
  }

  // Detect JavaScript code
  function looksLikeCode(text) {
    const codeIndicators = [
      /window\.|document\./,
      /function\s*\(/,
      /const\s+\w+\s*=/,
      /let\s+\w+\s*=/,
      /var\s+\w+\s*=/,
      /=>\s*\{/,  // Arrow functions
      /console\.(log|error|warn)/,
      /__oai_|__webpack_/,  // ChatGPT-specific JS
      /\[\[Prototype\]\]/,  // Console object inspection
      /Symbol\(Symbol\./,   // Symbol properties
      /ƒ\s+\w+\(\)/,       // Function representations (ƒ at(), ƒ map())
      /Array\(0\)/         // Array constructor in console
    ];
    return codeIndicators.some(pattern => pattern.test(text));
  }

  // Detect UI navigation/buttons
  function looksLikeUI(text) {
    const uiElements = [
      'Log in', 'Sign up', 'ChatGPT', 'Attach', 'Search', 'Study',
      'Create image', 'Voice', 'Terms', 'Privacy Policy', 'Temporary Chat',
      'This chat won', 'For safety purposes', 'messaging ChatGPT',
      'Where should we begin', 'Send a message', 'New chat'
    ];

    // Check if text is short and matches UI elements
    if (text.length < 300) {
      return uiElements.some(ui => text.includes(ui));
    }

    return false;
  }

  // DOM-agnostic text extraction with noise filtering
  function extractTextFromNode(node) {
    if (!node || seenNodes.has(node)) return null;

    // Only process element nodes
    if (node.nodeType !== Node.ELEMENT_NODE) return null;

    // NOISE FILTERING: Skip UI elements, buttons, timestamps, etc.
    if (isNoiseElement(node)) {
      return null;
    }

    // WHITELIST APPROACH: Only process nodes within message containers
    if (!isMessageContainer(node)) {
      return null;
    }

    // Filter out code blocks, style tags, script tags entirely
    if (node.closest('code, pre, style, script, noscript, [class*="code"], [class*="Code"]')) {
      return null;
    }

    let text = node.textContent?.trim();

    // Filter out empty, whitespace-only, or very short text
    if (!text || text.length < 50 || /^\s*$/.test(text)) return null;

    // CONTENT-TYPE VALIDATION: Detect CSS, JavaScript, UI chrome
    if (looksLikeCSS(text)) {
      console.log('⚠️ KYT ChatGPT DOM: Skipping CSS content');
      return null;
    }

    if (looksLikeCode(text)) {
      console.log('⚠️ KYT ChatGPT DOM: Skipping JavaScript content');
      return null;
    }

    if (looksLikeUI(text)) {
      console.log('⚠️ KYT ChatGPT DOM: Skipping UI element');
      return null;
    }

    // Enhanced noise filtering based on actual test captures
    const ignorePatterns = [
      /^(copy code|regenerate|stop generating|send|cancel|dictate)$/i,
      /^[\d\s:]+$/,  // timestamps
      /^[•\-\*]+$/,  // bullets
      /^(OriginalWebSocket|originalFetch|MutationObserver)/i,  // JS variable names
      /^(const|let|var|function|class|import|export)\s/i,  // JS keywords
      /^[\{\}\[\]\(\)]+$/,  // Just brackets/parens
      /^(true|false|null|undefined)$/i,  // JS literals
      /You said:Hello[\s\S]*ChatGPT said:/,  // Conversation history pattern
      /^\s*\.[\w-]+\s*\{/,  // CSS class selectors
      /^\s*#[\w-]+\s*\{/,   // CSS ID selectors
      /^[\s\w-]+:\s*[\w\s#(),.-]+;/,  // CSS properties
      /@media|@keyframes|@import/i,  // CSS at-rules
      /window\.|document\.|function\s*\(/,  // JavaScript
      /^(ChatGPT|Log in|Sign up|Attach|Search|Study|Create image|Voice)$/i,  // UI buttons
      /^(Temporary Chat|This chat won|For safety purposes)/i,  // UI text
      /Terms|Privacy Policy|messaging ChatGPT/i  // Footer text
    ];

    if (ignorePatterns.some(pattern => pattern.test(text))) {
      return null;
    }

    // Filter massive text blobs (likely full conversation history)
    if (text.length > 10000) {
      console.log(`⚠️ KYT ChatGPT DOM: Skipping oversized text (${text.length} chars) - likely conversation history`);
      return null;
    }

    // Clean up prefixes
    if (text.startsWith('You said:')) {
      text = text.replace('You said:', '').trim();
    } else if (text.startsWith('ChatGPT said:')) {
      text = text.replace('ChatGPT said:', '').trim();
    }

    seenNodes.add(node);
    return text;
  }

  // Attempt to determine message role from context
  function inferMessageRole(text, element) {
    // Check data-message-author-role (ChatGPT's actual attribute)
    const messageAuthorRole = element.getAttribute('data-message-author-role') ||
      element.closest('[data-message-author-role]')?.getAttribute('data-message-author-role');
    if (messageAuthorRole === 'user') return 'user';
    if (messageAuthorRole === 'assistant' || messageAuthorRole === 'system') return messageAuthorRole;

    // Check aria attributes (more stable than classes)
    const ariaLabel = element.getAttribute('aria-label') ||
      element.closest('[aria-label]')?.getAttribute('aria-label') || '';

    if (ariaLabel.toLowerCase().includes('user')) return 'user';
    if (ariaLabel.toLowerCase().includes('assistant') || ariaLabel.toLowerCase().includes('chatgpt')) return 'assistant';

    // Check data attributes (legacy)
    const dataAuthor = element.getAttribute('data-author') ||
      element.closest('[data-author]')?.getAttribute('data-author');
    if (dataAuthor) return dataAuthor === 'user' ? 'user' : 'assistant';

    // Fallback: content-based heuristics
    if (text.startsWith('You said:') || text.includes('🎤')) return 'user';
    if (text.startsWith('ChatGPT said:') || text.includes('🤖')) return 'assistant';

    // Default to 'assistant' — most DOM-captured messages without explicit role markers
    // are assistant responses (user messages are typically captured via SSE/fetch first)
    return 'assistant';
  }

  // Mutation observer for DOM-based capture
  const domObserver = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        try {
          const text = extractTextFromNode(node);
          if (!text) continue;

          const role = inferMessageRole(text, node);

          // Only capture substantial messages (not single words or UI elements)
          // INCREASED from 10 chars to 100 chars based on user testing
          // This ensures we capture real messages like "Testing, testing, one, two, three"
          // but filter out UI noise like "DictateDictate"
          if (text.length < 100) continue;

          // DEDUPLICATION: Check if we already captured this content recently
          if (isDuplicate(text)) {
            console.log('⚠️ KYT ChatGPT DOM: Skipping duplicate content');
            continue;
          }

          domCaptureCount++;

          // Extract original timestamp from <time datetime> element near this message
          let domTimestamp = Date.now();
          try {
            const turnContainer = node.closest('[data-testid*="conversation-turn"]')
              || node.closest('[class*="group"]');
            const timeEl = turnContainer?.querySelector('time[datetime]');
            if (timeEl) {
              const parsed = new Date(timeEl.getAttribute('datetime')).getTime();
              // Fix #6: Range-validate DOM timestamps (2022-11-30 to 2030-01-01)
              if (parsed > 1669766400000 && parsed < 1893456000000 && !isNaN(parsed)) domTimestamp = parsed;
            }
          } catch (_) { /* DOM structure changed — fallback to Date.now() */ }

          const message = {
            content: text,
            role: role,
            conversationId: 'dom_capture',  // Will be updated by content script if available
            model: 'chatgpt',
            timestamp: domTimestamp,
            messageId: `msg_dom_${(window.KYT_Deduplicator?.hashContent(window.KYT_Deduplicator?.normalizeContent(text)) || Date.now())}_${role}`,
            platform: 'chatgpt',
            captureMethod: 'dom',  // Track capture method for deduplication (vs 'websocket' or 'fetch')
            confidence: 70  // DOM observer = 70% confidence (protocol-level = 95%)
          };

          console.log(`🧠 KYT ChatGPT DOM: ${role.toUpperCase()} message captured (${text.length} chars)`);
          console.log(`📝 Preview: ${text.substring(0, 100)}...`);

          // DEDUPLICATION CHECK: Skip duplicates (DOM has lowest priority) (with error boundary)
          let shouldCapture = true; // Default: always capture (fail-open)
          try {
            if (window.KYT_Deduplicator) {
              shouldCapture = window.KYT_Deduplicator.shouldCapture(text, 'dom');
            }
          } catch (dedupeError) {
            console.error('❌ KYT ChatGPT DOM: Deduplication error, capturing anyway:', dedupeError);
            if (window.KYT_Deduplicator?._recordError) {
              window.KYT_Deduplicator._recordError(dedupeError);
            }
          }

          if (!shouldCapture) {
            console.log('⏭️ KYT ChatGPT DOM: Duplicate message skipped by deduplicator');
            return; // Skip dispatch
          }

          // Use same event mechanism as fetch interception
          window.dispatchEvent(new CustomEvent('KYT_MESSAGE_CAPTURED', {
            detail: message
          }));

        } catch (error) {
          console.warn('⚠️ KYT ChatGPT DOM: Capture error:', error.message);
        }
      }
    }
  });

  // Start observing with delay to avoid capturing initial page load/history
  // DELAY ADDED based on user testing: prevents capturing conversation history on page load
  function startDOMObserver() {
    const startObserving = () => {
      // Wait 3 seconds after page load to avoid capturing conversation history
      setTimeout(() => {
        domObserver.observe(document.body, {
          childList: true,
          subtree: true
        });
        console.log('👁️ KYT ChatGPT: DOM observer initialized for voice capture (delayed start to avoid history)');
      }, 3000);
    };

    if (document.body) {
      startObserving();
    } else {
      // Body not ready yet, wait for DOMContentLoaded
      document.addEventListener('DOMContentLoaded', startObserving);
    }
  }

  // OPT-IN: Only start DOM observer if explicitly enabled
  // Fetch interception handles 95% of message capture (typed messages)
  // DOM observer only needed for voice input (WebSocket-based)
  if (KYT_CONFIG.enableDOMObserver || KYT_CONFIG.enableVoiceCapture) {
    console.log('🔍 KYT ChatGPT DOM: Starting DOM observer (voice capture enabled)');
    startDOMObserver();
  } else {
    console.log('✅ KYT ChatGPT: Using fetch interception only (recommended)');
    console.log('💡 To enable voice capture, set KYT_CONFIG.enableVoiceCapture = true');
  }

  // Expose health check
  window.KYT_HEALTH_CHECK = function () {
    return {
      platform: 'chatgpt',
      context: 'PAGE_CONTEXT',
      totalInterceptions: totalInterceptions,
      totalErrors: totalErrors,
      lastInterceptionTime: lastInterceptionTime,
      timeSinceLastIntercept: Date.now() - lastInterceptionTime,
      errorRate: totalInterceptions > 0 ? `${((totalErrors / totalInterceptions) * 100).toFixed(1)}%` : 'N/A',
      domCaptureCount: domCaptureCount  // Add DOM capture stats
    };
  };

  // Phase 2: Expose interception stats for popup diagnostic UI
  window.getInterceptionStats = function () {
    return {
      platform: 'chatgpt',
      fetch: {
        active: totalInterceptions > 0,
        count: totalInterceptions
      },
      websocket: {
        active: true, // WebSocket override is always active
        count: 0 // TODO: Track WebSocket message count separately
      },
      domObserver: {
        active: KYT_CONFIG.enableDOMObserver || KYT_CONFIG.enableVoiceCapture,
        count: domCaptureCount
      },
      deduplication: window.KYT_Deduplicator ? window.KYT_Deduplicator.getStats() : null,
      totalInterceptions: totalInterceptions,
      totalErrors: totalErrors,
      lastInterceptionTime: lastInterceptionTime
    };
  };

  console.log('✅ KYT ChatGPT: Fetch override installed in PAGE CONTEXT');
  console.log(`ℹ️ KYT ChatGPT: DOM observer ${KYT_CONFIG.enableDOMObserver || KYT_CONFIG.enableVoiceCapture ? 'ENABLED' : 'DISABLED (fetch-only mode)'}`);
  /**
   * Process full conversation tree from JSON response
   * This is the robust method for Voice Capture (and text)
   */
  function processConversationTree(response) {
    if (!response || !response.mapping) return;

    try {
      const nodes = Object.values(response.mapping);

      // Sort nodes by create_time
      nodes.sort((a, b) => (a.message?.create_time || 0) - (b.message?.create_time || 0));

      for (const node of nodes) {
        if (!node.message) continue;

        const isUser = node.message.author.role === 'user';
        const isAssistant = node.message.author.role === 'assistant';

        if (!isUser && !isAssistant) continue;

        const contentParts = node.message.content?.parts || [];
        // Use extractTextFromParts (handles audio_transcription, skips audio_asset_pointer)
        const content = extractTextFromParts(contentParts) || '';

        if (!content) continue;

        const messageData = {
          content: content,
          role: node.message.author.role,
          conversationId: response.conversation_id,
          model: node.message.metadata?.model_slug || 'unknown',
          originalId: node.message.id,
          messageId: node.message.id || `msg_tree_${node.message.create_time || Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          isVoice: node.message.metadata?.voice_mode_message || false,
          timestamp: node.message.create_time ? node.message.create_time * 1000 : Date.now(),
          platform: 'chatgpt',
          captureMethod: 'fetch_tree'
        };

        // Deduplication
        let shouldCapture = true;
        if (window.KYT_Deduplicator) {
          shouldCapture = window.KYT_Deduplicator.shouldCapture(messageData.content, 'fetch_tree');
        }

        if (shouldCapture) {
          console.log(`🎙️ KYT Voice Capture (Inject): Found new ${messageData.isVoice ? 'VOICE' : 'TEXT'} message from ${messageData.role}`);
          window.dispatchEvent(new CustomEvent('KYT_MESSAGE_CAPTURED', {
            detail: messageData
          }));
        } else {
          console.log('⏭️ KYT Voice Capture: Duplicate skipped');
        }
      }
    } catch (error) {
      console.error('❌ KYT Voice Capture: Error processing tree:', error);
    }
  }

})();
