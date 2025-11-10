/**
 * KYT Memory Extension - Content Script (Day 1 Validation)
 *
 * Purpose: Intercept ChatGPT API calls and extract user messages
 * Strategy: Override window.fetch BEFORE page scripts load
 *
 * Compliance: CLAUDE.md Anti-Theater Rules
 * - Real error handling (not console.log theater)
 * - Actual validation (can fail meaningfully)
 * - No hard-coded success patterns
 */

(function() {
  'use strict';

  console.log('🚀 KYT Content Script: Initializing...');

  // Track interception health
  let lastInterceptionTime = Date.now();
  let totalInterceptions = 0;
  let totalErrors = 0;

  /**
   * Extract user message from ChatGPT API request body
   * @param {string} bodyString - JSON string from fetch body
   * @returns {Object|null} Extracted message data or null if failed
   */
  function extractUserMessage(bodyString) {
    try {
      const body = JSON.parse(bodyString);

      // Validate structure
      if (!body.messages || !Array.isArray(body.messages)) {
        throw new Error('Request body missing messages array');
      }

      if (body.messages.length === 0) {
        throw new Error('Messages array is empty');
      }

      // Get last message (the user's new message)
      const lastMessage = body.messages[body.messages.length - 1];

      // Extract content based on ChatGPT's structure
      // Structure: message.content.parts[0] OR message.content (direct string)
      let content = null;
      let role = lastMessage?.author?.role || lastMessage?.role || 'unknown';

      if (lastMessage?.content?.parts && Array.isArray(lastMessage.content.parts)) {
        content = lastMessage.content.parts[0];
      } else if (typeof lastMessage?.content === 'string') {
        content = lastMessage.content;
      }

      // Validate extracted content
      if (!content || typeof content !== 'string') {
        throw new Error('Could not extract message content (expected string)');
      }

      if (content.trim().length === 0) {
        throw new Error('Extracted content is empty');
      }

      // Extract conversation metadata
      const conversationId = body.conversation_id || null;
      const parentMessageId = body.parent_message_id || null;
      const model = body.model || 'unknown';

      return {
        content: content.trim(),
        role: role,
        conversationId: conversationId,
        parentMessageId: parentMessageId,
        model: model,
        timestamp: Date.now(),
        messageCount: body.messages.length
      };

    } catch (error) {
      // Real error - not swallowed
      console.error('❌ KYT Extraction Failed:', error.message);

      // Send error to background for logging
      chrome.runtime.sendMessage({
        type: 'EXTRACTION_ERROR',
        error: error.message,
        timestamp: Date.now()
      }).catch(err => {
        console.error('❌ Failed to send error log:', err);
      });

      return null;
    }
  }

  /**
   * Override window.fetch to intercept ChatGPT API calls
   * Install override after a delay to ensure we're the last extension to wrap fetch
   */
  function installFetchOverride() {
    const originalFetch = window.fetch;

    window.fetch = async function(...args) {
    const [url, options] = args;

    // Debug: Log ALL fetch calls to diagnose issues
    if (typeof url === 'string' && url.includes('backend-api')) {
      console.log('🔍 KYT DEBUG: Fetch call detected', {
        url: url,
        hasBody: !!options?.body,
        method: options?.method
      });
    }

    // Check if this is a ChatGPT conversation API call
    // Updated to match new endpoint: /backend-api/f/conversation
    const isChatGPTAPI = (
      typeof url === 'string' &&
      (url.includes('/backend-api/conversation') || url.includes('/backend-api/f/conversation'))
    );

    if (isChatGPTAPI && options?.body) {
      console.log('🎯 KYT: Intercepted ChatGPT API call');
      totalInterceptions++;
      lastInterceptionTime = Date.now();

      // Extract message data
      const messageData = extractUserMessage(options.body);

      if (messageData) {
        console.log('📝 KYT: Captured message:', {
          content: messageData.content.substring(0, 50) + '...',
          role: messageData.role,
          conversationId: messageData.conversationId,
          messageCount: messageData.messageCount
        });

        // Send to background script for storage
        chrome.runtime.sendMessage({
          type: 'SAVE_MESSAGE',
          data: messageData
        }).then(() => {
          console.log('✅ KYT: Message sent to background for storage');
        }).catch(error => {
          console.error('❌ KYT: Failed to send message to background:', error);
          totalErrors++;
        });
      } else {
        console.warn('⚠️ KYT: Failed to extract message from request');
        totalErrors++;
      }

      // Log health status every 10 interceptions
      if (totalInterceptions % 10 === 0) {
        console.log(`📊 KYT Health: ${totalInterceptions} intercepts, ${totalErrors} errors`);
      }
    }

    // Continue with original fetch (don't break ChatGPT)
    return originalFetch.apply(this, args);
    };

    console.log('✅ KYT: Fetch override installed successfully');
  }

  // Install immediately
  installFetchOverride();

  // Re-install after page load to override any other extensions
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', installFetchOverride);
  }
  window.addEventListener('load', () => {
    setTimeout(installFetchOverride, 100); // Small delay after page load
  });

  // Health monitoring: Alert if no interceptions for 5 minutes
  setInterval(() => {
    const timeSinceLastIntercept = Date.now() - lastInterceptionTime;
    const fiveMinutes = 5 * 60 * 1000;

    if (timeSinceLastIntercept > fiveMinutes && totalInterceptions > 0) {
      console.warn('⚠️ KYT: No API interceptions for 5+ minutes. ChatGPT API might have changed.');

      chrome.runtime.sendMessage({
        type: 'HEALTH_WARNING',
        message: 'No interceptions for 5+ minutes',
        lastIntercept: lastInterceptionTime,
        totalInterceptions: totalInterceptions
      }).catch(err => {
        console.error('❌ Failed to send health warning:', err);
      });
    }
  }, 60000); // Check every minute

  // Expose health check function for debugging
  window.KYT_HEALTH_CHECK = function() {
    return {
      totalInterceptions: totalInterceptions,
      totalErrors: totalErrors,
      lastInterceptionTime: lastInterceptionTime,
      timeSinceLastIntercept: Date.now() - lastInterceptionTime,
      errorRate: totalInterceptions > 0 ? (totalErrors / totalInterceptions * 100).toFixed(2) + '%' : '0%'
    };
  };

  console.log('✅ KYT: Health monitoring active (check with window.KYT_HEALTH_CHECK())');

})();
