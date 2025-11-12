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

      // Extract message data
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

    // Continue with original fetch
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
