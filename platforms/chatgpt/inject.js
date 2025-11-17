/**
 * KYT Memory Extension - ChatGPT Inject Script
 *
 * This script runs in the PAGE CONTEXT (not content script context)
 * allowing it to wrap fetch at the same level as other page scripts.
 *
 * Platform: ChatGPT
 */

(function() {
  'use strict';

  // PHASE 1 FIX #3: Duplicate injection guard
  if (window.KYT_CHATGPT_INJECTED) {
    console.log('⚠️ KYT ChatGPT already injected, skipping duplicate injection');
    return;
  }
  window.KYT_CHATGPT_INJECTED = true;

  console.log('🚀 KYT ChatGPT Inject: Initializing in page context...');

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
      const map = { 'websocket': 95, 'fetch': 95, 'dom': 70 };
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

    detectAPICall: function(url, options) {
      const isChatGPTAPI = (
        typeof url === 'string' &&
        (url.includes('/backend-api/conversation') || url.includes('/backend-api/f/conversation'))
      );
      const isPostRequest = options?.method === 'POST' || options?.body;
      return isChatGPTAPI && isPostRequest;
    },

    extractMessage: function(bodyString) {
      try {
        const body = JSON.parse(bodyString);

        if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
          throw new Error('Invalid message structure');
        }

        const lastMessage = body.messages[body.messages.length - 1];
        let content = null;
        let role = lastMessage?.author?.role || lastMessage?.role || 'user'; // Default to 'user' (DB constraint)

        if (lastMessage?.content?.parts && Array.isArray(lastMessage.content.parts)) {
          content = lastMessage.content.parts[0];
        } else if (typeof lastMessage?.content === 'string') {
          content = lastMessage.content;
        }

        if (!content || typeof content !== 'string') {
          throw new Error('No valid content found');
        }

        return {
          content: content.trim(),
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
   * Persistent listener for context responses
   * Lives at module level - never garbage collected
   */
  window.addEventListener('KYT_CONTEXT_RESPONSE', (event) => {
    const { requestId } = event.detail;
    const pending = pendingContextRequests.get(requestId);

    if (pending) {
      clearTimeout(pending.timeout);
      pendingContextRequests.delete(requestId);

      if (event.detail.success && event.detail.formattedContext) {
        console.log('✅ KYT ChatGPT: Context received, injecting...');
        console.log('📝 Context items:', event.detail.items?.length || 0);
        console.log('📄 Context preview:', event.detail.formattedContext?.substring(0, 200) + '...');

        // Inject context as a system message
        const contextMessage = {
          author: { role: 'system' },
          content: { content_type: 'text', parts: [event.detail.formattedContext] },
          metadata: { kyt_context: true }
        };

        pending.body.messages.splice(pending.body.messages.length - 1, 0, contextMessage);

        console.log('🔧 Modified request body (messages count):', pending.body.messages.length);
        console.log('🔧 System message injected at position:', pending.body.messages.length - 2);

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
      const body = JSON.parse(bodyString);

      // Extract user message
      if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
        return bodyString; // No modification
      }

      const lastMessage = body.messages[body.messages.length - 1];
      let userContent = null;

      if (lastMessage?.content?.parts && Array.isArray(lastMessage.content.parts)) {
        userContent = lastMessage.content.parts[0];
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
        // PHASE 1 FIX #5: Increase timeout to 10s with better error logging
        const timeout = setTimeout(() => {
          pendingContextRequests.delete(requestId);
          console.error('⏱️ KYT ChatGPT: Context timeout after 10s', {
            requestId: requestId,
            userMessage: userContent.substring(0, 50),
            pendingRequests: pendingContextRequests.size
          });
          resolve(bodyString);
        }, 10000); // Increased from 5000ms

        // Store request in Map - prevents garbage collection
        pendingContextRequests.set(requestId, {
          resolve: resolve,
          timeout: timeout,
          body: body,
          originalBody: bodyString
        });

        // Dispatch context request
        console.log('📤 KYT ChatGPT: Dispatching context request:', requestId);
        window.dispatchEvent(new CustomEvent('KYT_CONTEXT_REQUEST', {
          detail: {
            requestId: requestId,
            userMessage: userContent,
            config: {
              threshold: 0.5, // pgvector distance: lower = stricter, 0.5 = balanced
              maxContextItems: 5, // Increased from 3 for more context
              debugMode: false
            }
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
  const originalFetch = window.fetch;

  window.fetch = async function(...args) {
    const [url, options] = args;

    // Check if this is a platform API call
    if (platform.detectAPICall(url, options)) {
      console.log('🎯 KYT ChatGPT: Intercepted API call');
      totalInterceptions++;
      lastInterceptionTime = Date.now();

      // FIX: Extract metadata BEFORE modifying options.body
      let conversationId = 'unknown';
      let modelName = 'gpt-unknown';
      if (options.body) {
        try {
          const originalBody = JSON.parse(options.body);
          conversationId = originalBody.conversation_id || 'unknown';
          modelName = originalBody.model || 'gpt-unknown';
        } catch (e) {
          console.warn('⚠️ KYT ChatGPT: Could not parse request body for metadata');
        }
      }

      // PHASE 1: Get context and inject BEFORE sending
      if (options.body) {
        try {
          options.body = await getAndInjectContext(options.body);
        } catch (error) {
          console.error('❌ KYT ChatGPT: Pre-send context injection failed:', error);
        }
      }

      // PHASE 2: Extract message data for storage AFTER sending
      const messageData = platform.extractMessage(options.body);

      if (messageData) {
        console.log('✅ KYT ChatGPT: Message extracted:', messageData.content.substring(0, 50) + '...');

        // DEDUPLICATION CHECK: Skip duplicates from multiple capture sources
        if (window.KYT_Deduplicator && !window.KYT_Deduplicator.shouldCapture(messageData.content, 'fetch')) {
          console.log('⏭️ KYT ChatGPT: Duplicate message skipped by deduplicator');
          return await originalFetch.apply(this, args); // Return response without dispatching event
        }

        // Send to content script via custom event
        window.dispatchEvent(new CustomEvent('KYT_MESSAGE_CAPTURED', {
          detail: messageData
        }));
      } else {
        console.warn('⚠️ KYT ChatGPT: Failed to extract message');
        totalErrors++;
      }

      // Continue with original fetch (with modified body if context was injected)
      const response = await originalFetch.apply(this, args);

      // PHASE 1.5: Capture assistant response
      if (response.ok) {
        // Capture response asynchronously (don't block UI)
        captureAssistantResponse(response, {
          conversationId: conversationId,
          platform: 'chatgpt',
          model: modelName,
          timestamp: Date.now()
        }).catch(error => {
          console.error('❌ KYT ChatGPT: Failed to capture assistant response:', error);
        });
      }

      return response;
    }

    // Continue with original fetch (with modified body if context was injected)
    const response = await originalFetch.apply(this, args);

    return response;
  };

  /**
   * Override WebSocket in page context for voice input capture
   * Voice messages use WebSocket (not fetch), so we need a separate interceptor
   * This captures voice transcripts at protocol level, immune to DOM changes
   */
  const OriginalWebSocket = window.WebSocket;

  window.WebSocket = function(...args) {
    const socket = new OriginalWebSocket(...args);
    const wsUrl = args[0];

    // Detect ChatGPT voice WebSocket
    // Pattern: wss://chatgpt.com/ws/user/* or similar voice endpoints
    if (typeof wsUrl === 'string' && (
      wsUrl.includes('ws.chatgpt.com') ||
      wsUrl.includes('chatgpt.com/ws') ||
      wsUrl.includes('/ws/user/')
    )) {
      console.log('🎤 KYT ChatGPT: WebSocket intercepted (likely voice):', wsUrl);

      // Intercept incoming messages
      socket.addEventListener('message', (event) => {
        try {
          // WebSocket messages are typically JSON
          if (typeof event.data === 'string') {
            const data = JSON.parse(event.data);

            // Voice transcripts come in various formats, try to detect:
            // - data.type === 'transcript'
            // - data.text (transcript text)
            // - data.message.content (alternate format)
            let transcriptText = null;

            if (data.type === 'transcript' && data.text) {
              transcriptText = data.text;
            } else if (data.text) {
              transcriptText = data.text;
            } else if (data.message?.content) {
              transcriptText = data.message.content;
            } else if (data.transcript) {
              transcriptText = data.transcript;
            }

            if (transcriptText && transcriptText.trim().length > 0) {
              console.log('🎤 KYT ChatGPT: Voice transcript captured:', transcriptText.substring(0, 50) + '...');

              // DEDUPLICATION CHECK: Skip duplicates
              if (window.KYT_Deduplicator && !window.KYT_Deduplicator.shouldCapture(transcriptText, 'websocket')) {
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
   * PHASE 1.5: Capture streaming assistant response
   * Reads SSE stream and extracts assistant message
   */
  async function captureAssistantResponse(response, metadata) {
    try {
      // FIX: Defensive checks for response.body
      if (!response) {
        console.warn('⚠️ KYT ChatGPT: Response is null/undefined');
        return;
      }

      if (!response.body) {
        console.warn('⚠️ KYT ChatGPT: Response body is null/undefined');
        console.log('📊 Response object:', {
          ok: response.ok,
          status: response.status,
          statusText: response.statusText,
          headers: response.headers ? 'present' : 'missing',
          bodyUsed: response.bodyUsed
        });
        return;
      }

      // Clone response to avoid consuming original stream
      const clonedResponse = response.clone();

      if (!clonedResponse.body) {
        console.warn('⚠️ KYT ChatGPT: Cloned response body is null/undefined');
        return;
      }

      const reader = clonedResponse.body.getReader();
      const decoder = new TextDecoder();
      let fullText = '';
      let messageId = null;
      let chunkCount = 0;
      let debugMode = true; // Enable diagnostic logging

      while (true) {
        const {done, value} = await reader.read();
        if (done) break;

        chunkCount++;
        const chunk = decoder.decode(value, {stream: true});

        // DIAGNOSTIC: Log first 10 chunks to see actual format (including text chunks)
        if (chunkCount <= 10) {
          console.log(`🔍 KYT ChatGPT DEBUG: Chunk ${chunkCount} received`);
          console.log('   Chunk length:', chunk.length);
          console.log('   Chunk preview (first 500 chars):', chunk.substring(0, 500));
        }

        const lines = chunk.split('\n');

        for (const line of lines) {
          // Skip empty lines and event: lines
          if (line.trim().length === 0) continue;
          if (line.startsWith('event:')) continue;

          // DIAGNOSTIC: Log line format from first 10 chunks
          if (chunkCount <= 10 && line.trim().length > 0) {
            console.log(`🔍 DEBUG Chunk ${chunkCount} Line:`, line.substring(0, 200));
          }

          // ChatGPT format: "data: {json}" or "data: \"string\""
          if (!line.startsWith('data: ')) continue;

          const data = line.substring(6).trim();
          if (data === '[DONE]' || data === '' || data === '""') continue;

          try {
            const json = JSON.parse(data);

            // DIAGNOSTIC: Log parsed JSON structure from first 10 chunks
            if (typeof json === 'object' && json !== null && chunkCount <= 10) {
              console.log(`🔍 DEBUG Chunk ${chunkCount} Parsed JSON:`, JSON.stringify(json).substring(0, 300));
              console.log(`🔍 DEBUG Chunk ${chunkCount} JSON keys:`, Object.keys(json));
              console.log(`🔍 DEBUG Chunk ${chunkCount} JSON type:`, json.type || 'no type field');

              // Check multiple possible structures
              if (json.message) {
                console.log(`🔍 DEBUG Chunk ${chunkCount} has message field:`, JSON.stringify(json.message).substring(0, 150));
              }
              if (json.content) {
                console.log(`🔍 DEBUG Chunk ${chunkCount} has content field:`, JSON.stringify(json.content).substring(0, 150));
              }
              if (json.choices) {
                console.log(`🔍 DEBUG Chunk ${chunkCount} has choices[0]:`, JSON.stringify(json.choices[0]).substring(0, 150));
              }
              if (json.delta) {
                console.log(`🔍 DEBUG Chunk ${chunkCount} has delta field:`, JSON.stringify(json.delta).substring(0, 150));
              }
              if (json.text) {
                console.log(`🔍 DEBUG Chunk ${chunkCount} has text field:`, json.text.substring(0, 100));
              }
              // Check nested structure seen in user logs: {"p": "", "o": "add", "v": {"message": ...}}
              if (json.v !== undefined) {
                console.log(`🔍 DEBUG Chunk ${chunkCount} has v (value) field:`, typeof json.v === 'string' ? `"${json.v.substring(0, 100)}"` : JSON.stringify(json.v).substring(0, 300));
              }
              if (json.p !== undefined) {
                console.log(`🔍 DEBUG Chunk ${chunkCount} has p (path) field:`, json.p);
              }
              if (json.o) {
                console.log(`🔍 DEBUG Chunk ${chunkCount} has o (operation) field:`, json.o);
              }
            }

            // Try multiple possible ChatGPT response formats
            let content = null;

            // Format 1: Standard SSE with choices array (OpenAI API style)
            if (json.choices?.[0]?.delta?.content) {
              content = json.choices[0].delta.content;
            }
            // Format 2: Direct message content
            else if (json.message?.content?.parts?.[0]) {
              content = json.message.content.parts[0];
            }
            // Format 3: Direct content field
            else if (typeof json.content === 'string') {
              content = json.content;
            }
            // Format 4: Delta field directly
            else if (typeof json.delta === 'string') {
              content = json.delta;
            }
            // Format 5: Text field
            else if (typeof json.text === 'string') {
              content = json.text;
            }
            // Format 6: Delta/patch format with array (ChatGPT web API streaming)
            // Structure: {"v": [{"p": "/message/content/parts/0", "o": "append", "v": "text"}]}
            // This is used for streaming text updates after the initial message is created
            else if (Array.isArray(json.v) && json.v.length > 0) {
              // Extract text from all patches in the array
              for (const patch of json.v) {
                // Check if this patch updates the text content
                if (patch.p === '/message/content/parts/0' && patch.o === 'append' && typeof patch.v === 'string') {
                  content = (content || '') + patch.v;
                }
              }
            }
            // Format 6b: Delta format with single patch (alternative format)
            // Structure: {"p": "message.content.parts[0]", "o": "replace", "v": "text chunk"}
            else if (json.o && json.v !== undefined && typeof json.v === 'string' && json.v.length > 0) {
              // Delta format: v contains the text chunk directly as string
              content = json.v;
            }
            // Format 7: Nested v.message structure (ChatGPT initial message creation)
            // Structure: {"p": "", "o": "add", "v": {"message": {"content": {"parts": ["text"]}}}}
            else if (json.v?.message?.content?.parts?.[0] && json.v.message.content.parts[0].length > 0) {
              // Only capture if parts[0] has actual content (not empty string)
              content = json.v.message.content.parts[0];
            }
            // Format 8: Nested v.content directly
            else if (typeof json.v?.content === 'string' && json.v.content.length > 0) {
              content = json.v.content;
            }
            // Format 9: Nested v.text
            else if (typeof json.v?.text === 'string' && json.v.text.length > 0) {
              content = json.v.text;
            }

            if (content) {
              fullText += content;
              if (chunkCount <= 10) {
                console.log(`✅ DEBUG Chunk ${chunkCount}: Captured text:`, content.substring(0, 50));
              }
            }

            // Capture message ID from various possible locations
            if (!messageId) {
              messageId = json.id || json.message_id || json.conversation_id;
            }
          } catch (parseError) {
            // Skip non-JSON lines (like plain strings)
            if (chunkCount <= 3 && debugMode) {
              console.log('⚠️ DEBUG: Skipping non-JSON line:', data.substring(0, 100));
            }
            continue;
          }
        }
      }

      // DIAGNOSTIC: Log final statistics
      console.log('📊 KYT ChatGPT DEBUG: Stream reading complete');
      console.log('   Total chunks:', chunkCount);
      console.log('   Text length:', fullText.length);
      console.log('   Message ID:', messageId || 'none');

      // Only store if we captured meaningful text
      if (fullText.trim().length > 0) {
        const assistantMessage = {
          content: fullText.trim(),
          role: 'assistant',
          conversationId: metadata.conversationId,
          model: metadata.model,
          timestamp: Date.now(),
          messageId: messageId || `msg_assistant_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          platform: metadata.platform
        };

        console.log('🤖 KYT ChatGPT: Assistant response captured:', {
          conversationId: assistantMessage.conversationId,
          contentLength: assistantMessage.content.length,
          contentPreview: assistantMessage.content.substring(0, 100) + '...'
        });

        // Dispatch event to content script
        window.dispatchEvent(new CustomEvent('KYT_MESSAGE_CAPTURED', {
          detail: assistantMessage
        }));

        console.log('🤖 KYT ChatGPT: Assistant message event dispatched');
      } else {
        console.warn('⚠️ KYT ChatGPT: No text captured from assistant response');
      }
    } catch (error) {
      console.error('❌ KYT ChatGPT: Error capturing assistant response:', error);
      console.error('   Error details:', {
        name: error.name,
        message: error.message,
        stack: error.stack?.split('\n')[0]
      });
      // Don't throw - graceful degradation
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
    enableDOMObserver: false,  // Set to true for voice input capture
    enableVoiceCapture: false  // Alternative flag for voice-specific features
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
    const className = node.className || '';
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

    const text = node.textContent?.trim();

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

    seenNodes.add(node);
    return text;
  }

  // Attempt to determine message role from context
  function inferMessageRole(text, element) {
    // Check aria attributes (more stable than classes)
    const ariaLabel = element.getAttribute('aria-label') ||
                      element.closest('[aria-label]')?.getAttribute('aria-label') || '';

    if (ariaLabel.toLowerCase().includes('user')) return 'user';
    if (ariaLabel.toLowerCase().includes('assistant') || ariaLabel.toLowerCase().includes('chatgpt')) return 'assistant';

    // Check data attributes
    const dataAuthor = element.getAttribute('data-author') ||
                       element.closest('[data-author]')?.getAttribute('data-author');
    if (dataAuthor) return dataAuthor === 'user' ? 'user' : 'assistant';

    // Fallback: content-based heuristics
    if (text.startsWith('You said:') || text.includes('🎤')) return 'user';
    if (text.startsWith('ChatGPT said:') || text.includes('🤖')) return 'assistant';

    // Default to 'user' (DB constraint: user|assistant|system only)
    return 'user';
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

          const message = {
            content: text,
            role: role,
            conversationId: 'dom_capture',  // Will be updated by content script if available
            model: 'chatgpt',
            timestamp: Date.now(),
            messageId: `msg_dom_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            platform: 'chatgpt',
            captureMethod: 'dom',  // Track capture method for deduplication (vs 'websocket' or 'fetch')
            confidence: 70  // DOM observer = 70% confidence (protocol-level = 95%)
          };

          console.log(`🧠 KYT ChatGPT DOM: ${role.toUpperCase()} message captured (${text.length} chars)`);
          console.log(`📝 Preview: ${text.substring(0, 100)}...`);

          // DEDUPLICATION CHECK: Skip duplicates (DOM has lowest priority)
          if (window.KYT_Deduplicator && !window.KYT_Deduplicator.shouldCapture(text, 'dom')) {
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
  window.KYT_HEALTH_CHECK = function() {
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

  console.log('✅ KYT ChatGPT: Fetch override installed in PAGE CONTEXT');
  console.log(`ℹ️ KYT ChatGPT: DOM observer ${KYT_CONFIG.enableDOMObserver || KYT_CONFIG.enableVoiceCapture ? 'ENABLED' : 'DISABLED (fetch-only mode)'}`);
})();
