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
        let role = lastMessage?.author?.role || lastMessage?.role || 'unknown';

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

        // Send to content script via custom event
        window.dispatchEvent(new CustomEvent('KYT_MESSAGE_CAPTURED', {
          detail: messageData
        }));
      } else {
        console.warn('⚠️ KYT ChatGPT: Failed to extract message');
        totalErrors++;
      }
    }

    // Continue with original fetch (with modified body if context was injected)
    const response = await originalFetch.apply(this, args);

    // PHASE 1.5: Capture assistant response
    if (platform.detectAPICall(url, options) && response.ok) {
      // Clone response to avoid consuming the original stream
      const clonedResponse = response.clone();

      // Extract conversation ID for linking
      const requestBody = options.body ? JSON.parse(options.body) : {};
      const conversationId = requestBody.conversation_id || 'unknown';

      // Capture response asynchronously (don't block UI)
      captureAssistantResponse(clonedResponse, {
        conversationId: conversationId,
        platform: 'chatgpt',
        model: requestBody.model || 'gpt-unknown',
        timestamp: Date.now()
      }).catch(error => {
        console.error('❌ KYT ChatGPT: Failed to capture assistant response:', error);
      });
    }

    return response;
  };

  /**
   * PHASE 1.5: Capture streaming assistant response
   * Reads SSE stream and extracts assistant message
   */
  async function captureAssistantResponse(response, metadata) {
    try {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let fullText = '';
      let messageId = null;

      while (true) {
        const {done, value} = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, {stream: true});
        const lines = chunk.split('\n');

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;

          const data = line.substring(6).trim();
          if (data === '[DONE]' || data === '') continue;

          try {
            const json = JSON.parse(data);

            // Extract text from ChatGPT SSE format
            // Format: {"id":"chatcmpl-...","choices":[{"delta":{"content":"text"}}]}
            const content = json.choices?.[0]?.delta?.content;
            if (content) {
              fullText += content;
            }

            // Capture message ID from first chunk
            if (!messageId && json.id) {
              messageId = json.id;
            }
          } catch (parseError) {
            // Skip malformed JSON chunks
            continue;
          }
        }
      }

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
      }
    } catch (error) {
      console.error('❌ KYT ChatGPT: Error capturing assistant response:', error);
      throw error;
    }
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
      errorRate: totalInterceptions > 0 ? `${((totalErrors / totalInterceptions) * 100).toFixed(1)}%` : 'N/A'
    };
  };

  console.log('✅ KYT ChatGPT: Fetch override installed in PAGE CONTEXT');
})();
