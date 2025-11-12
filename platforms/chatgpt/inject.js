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

      // Request context from content script
      const requestId = `ctx_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

      return new Promise((resolve) => {
        const timeout = setTimeout(() => {
          console.warn('⏱️ KYT ChatGPT: Context request timeout');
          resolve(bodyString); // Timeout - proceed without context
        }, 5000); // 5 seconds to match Claude (embedding + search time)

        const responseHandler = (event) => {
          if (event.detail.requestId === requestId) {
            clearTimeout(timeout);
            window.removeEventListener('KYT_CONTEXT_RESPONSE', responseHandler);

            if (event.detail.success && event.detail.formattedContext) {
              console.log('✅ KYT ChatGPT: Context received, injecting...');

              // Inject context as a system message
              const contextMessage = {
                author: { role: 'system' },
                content: { content_type: 'text', parts: [event.detail.formattedContext] },
                metadata: { kyt_context: true }
              };

              body.messages.splice(body.messages.length - 1, 0, contextMessage);
              resolve(JSON.stringify(body));
            } else {
              console.log('ℹ️ KYT ChatGPT: No context found or error');
              resolve(bodyString); // No context - proceed with original
            }
          }
        };

        window.addEventListener('KYT_CONTEXT_RESPONSE', responseHandler);

        // Dispatch context request
        window.dispatchEvent(new CustomEvent('KYT_CONTEXT_REQUEST', {
          detail: {
            requestId: requestId,
            userMessage: userContent,
            config: {
              threshold: 0.5,
              maxContextItems: 3,
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
    return originalFetch.apply(this, args);
  };

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
