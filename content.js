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
  // Day 3: Inject inject-day3.js with context injection (RAG) support
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('inject-day3.js');
  script.onload = function() {
    console.log('✅ KYT Content Script: inject-day3.js loaded into page context');
    this.remove();
  };
  script.onerror = function() {
    console.error('❌ KYT Content Script: Failed to load inject-day3.js');
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

  // === DAY 3: CONFIG REQUEST HANDLER ===
  // Listen for config requests from page context (inject-day3.js needs API keys)
  window.addEventListener('KYT_CONFIG_REQUEST', async function(event) {
    const requestId = event.detail.requestId;
    console.log('🔧 KYT Content Script: Config request from page context');

    try {
      // Get config from chrome.storage
      const result = await chrome.storage.local.get(['api_config', 'context_injection_config']);

      // Send response back to page context
      window.dispatchEvent(new CustomEvent('KYT_CONFIG_RESPONSE', {
        detail: {
          requestId: requestId,
          apiConfig: result.api_config || null,
          contextConfig: result.context_injection_config || {
            enabled: true,
            threshold: 0.5,
            maxContextItems: 3,
            minDistance: 0.0,
            debugMode: false
          }
        }
      }));

      console.log('✅ KYT Content Script: Config sent to page context');
    } catch (error) {
      console.error('❌ KYT Content Script: Failed to get config:', error);

      // Send error response
      window.dispatchEvent(new CustomEvent('KYT_CONFIG_RESPONSE', {
        detail: {
          requestId: requestId,
          apiConfig: null,
          contextConfig: null,
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
