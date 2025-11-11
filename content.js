/**
 * KYT Memory Extension - Content Script (Day 1 Validation)
 *
 * Purpose: Inject page context script to intercept ChatGPT API calls
 * Strategy: Run fetch override in PAGE CONTEXT to avoid extension conflicts
 *
 * Compliance: CLAUDE.md Anti-Theater Rules
 * - Real error handling (not console.log theater)
 * - Actual validation (can fail meaningfully)
 * - No hard-coded success patterns
 */

(function() {
  'use strict';

  console.log('🚀 KYT Content Script: Initializing...');

  // === PAGE CONTEXT INJECTION ===
  // Day 3: Inject inject-day3-fixed.js with context injection (RAG) support (CSP FIXED)
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('inject-day3-fixed.js');
  script.onload = function() {
    console.log('✅ KYT Content Script: inject-day3-fixed.js loaded into page context');
    this.remove();
  };
  script.onerror = function() {
    console.error('❌ KYT Content Script: Failed to load inject-day3-fixed.js');
  };
  (document.head || document.documentElement).appendChild(script);

  // === EVENT LISTENER FOR PAGE CONTEXT MESSAGES ===
  // Listen for messages from injected script via CustomEvent
  window.addEventListener('KYT_MESSAGE_CAPTURED', function(event) {
    const messageData = event.detail;
    console.log('📨 KYT Content Script: Received message from page context');
    console.log('   Content preview:', messageData.content.substring(0, 50) + '...');

    // Forward to background script for storage
    chrome.runtime.sendMessage({
      type: 'SAVE_MESSAGE',
      data: messageData
    }).then(() => {
      console.log('✅ KYT Content Script: Message forwarded to background for storage');
    }).catch(error => {
      console.error('❌ KYT Content Script: Failed to forward message to background:', error);
    });
  });

  // === DAY 3: CONTEXT REQUEST HANDLER (CSP FIX) ===
  // Listen for context requests from page context
  // Page context cannot call OpenAI/Supabase directly (CSP blocks)
  // So we forward to background script which has no CSP restrictions
  window.addEventListener('KYT_CONTEXT_REQUEST', async function(event) {
    const { requestId, userMessage, config } = event.detail;
    console.log('🔍 KYT Content Script: Context request from page context');

    try {
      // Forward to background script (no CSP restrictions there!)
      const response = await chrome.runtime.sendMessage({
        type: 'GET_CONTEXT',
        userMessage: userMessage,
        config: config
      });

      // Send response back to page context
      window.dispatchEvent(new CustomEvent('KYT_CONTEXT_RESPONSE', {
        detail: {
          requestId: requestId,
          success: response.success,
          formattedContext: response.formattedContext,
          items: response.items,
          elapsedMs: response.elapsedMs,
          error: response.error
        }
      }));

      console.log('✅ KYT Content Script: Context response sent to page context');
    } catch (error) {
      console.error('❌ KYT Content Script: Failed to get context:', error);

      // Send error response
      window.dispatchEvent(new CustomEvent('KYT_CONTEXT_RESPONSE', {
        detail: {
          requestId: requestId,
          success: false,
          formattedContext: null,
          items: [],
          error: error.message
        }
      }));
    }
  });

  console.log('✅ KYT Content Script: Listening for messages from page context');

  // === HEALTH CHECK PROXY ===
  // Expose health check that calls into page context
  window.KYT_HEALTH_CHECK = function() {
    if (typeof window.KYT_HEALTH_CHECK === 'undefined') {
      return {
        error: 'Page context script not loaded yet',
        contentScriptActive: true
      };
    }
    return window.KYT_HEALTH_CHECK();
  };

})();
