/**
 * KYT Memory Extension - Claude Inject Script
 *
 * This script runs in the PAGE CONTEXT (not content script context)
 * allowing it to wrap fetch at the same level as other page scripts.
 *
 * Platform: Claude
 */

(function() {
  'use strict';

  console.log('🚀 KYT Claude Inject: Initializing in page context...');

  // Track interception health
  let lastInterceptionTime = Date.now();
  let totalInterceptions = 0;
  let totalErrors = 0;

  // Platform-specific detection and extraction
  const platform = {
    name: 'claude',

    detectAPICall: function(url, options) {
      const isClaudeAPI = (
        typeof url === 'string' &&
        url.includes('claude.ai/api/') &&
        url.includes('/chat_conversations/') &&
        url.includes('/completion')
      );
      const isPostRequest = options?.method === 'POST' || options?.body;
      return isClaudeAPI && isPostRequest;
    },

    extractConversationId: function(url) {
      // Extract from URL: /api/organizations/{org_id}/chat_conversations/{conv_id}/completion
      const match = url.match(/\/chat_conversations\/([^\/]+)\//);
      return match ? match[1] : 'unknown';
    },

    extractMessage: function(bodyString, url) {
      try {
        const body = JSON.parse(bodyString);

        if (!body.prompt || typeof body.prompt !== 'string') {
          throw new Error('No prompt found in request body');
        }

        // Extract conversation ID from URL (more reliable than body)
        const conversationId = this.extractConversationId(url);

        return {
          content: body.prompt.trim(),
          role: 'user',
          conversationId: conversationId,
          model: body.model || 'claude-3-opus',
          timestamp: Date.now(),
          messageId: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          platform: 'claude'
        };
      } catch (error) {
        console.error('❌ KYT Claude: Extraction error:', error.message);
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
      console.log('🎯 KYT Claude: Intercepted API call');
      totalInterceptions++;
      lastInterceptionTime = Date.now();

      // Extract message data (pass URL for conversation ID extraction)
      const messageData = platform.extractMessage(options.body, url);

      if (messageData) {
        console.log('✅ KYT Claude: Message extracted:', messageData.content.substring(0, 50) + '...');

        // Send to content script via custom event
        window.dispatchEvent(new CustomEvent('KYT_MESSAGE_CAPTURED', {
          detail: messageData
        }));
      } else {
        console.warn('⚠️ KYT Claude: Failed to extract message');
        totalErrors++;
      }
    }

    // Continue with original fetch
    return originalFetch.apply(this, args);
  };

  // Expose health check
  window.KYT_HEALTH_CHECK = function() {
    return {
      platform: 'claude',
      context: 'PAGE_CONTEXT',
      totalInterceptions: totalInterceptions,
      totalErrors: totalErrors,
      lastInterceptionTime: lastInterceptionTime,
      timeSinceLastIntercept: Date.now() - lastInterceptionTime,
      errorRate: totalInterceptions > 0 ? `${((totalErrors / totalInterceptions) * 100).toFixed(1)}%` : 'N/A'
    };
  };

  console.log('✅ KYT Claude: Fetch override installed in PAGE CONTEXT');
})();
