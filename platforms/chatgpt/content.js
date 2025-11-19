/**
 * KYT Memory Extension - ChatGPT Content Script
 *
 * Purpose: Inject page context script and relay messages to background
 * Platform: ChatGPT
 *
 * Note: deduplication.js is loaded first (see manifest.json) and provides window.KYT_Deduplicator
 */

(function() {
  'use strict';

  console.log('🚀 KYT ChatGPT Content: Initializing...');

  // === PAGE CONTEXT INJECTION ===
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('platforms/chatgpt/inject.js');
  script.onload = function() {
    console.log('✅ KYT ChatGPT Content: inject.js loaded into page context');
    this.remove();
  };
  script.onerror = function() {
    console.error('❌ KYT ChatGPT Content: Failed to load inject.js');
  };
  (document.head || document.documentElement).appendChild(script);

  // === EVENT LISTENER FOR PAGE CONTEXT MESSAGES ===
  window.addEventListener('KYT_MESSAGE_CAPTURED', function(event) {
    const messageData = event.detail;
    console.log('📨 KYT ChatGPT Content: Received message from page context');
    console.log('   Content preview:', messageData.content.substring(0, 50) + '...');
    console.log('   Capture method:', messageData.captureMethod || 'fetch');

    // Check if extension context is still valid
    if (!chrome.runtime?.id) {
      console.warn('⚠️ KYT ChatGPT Content: Extension context invalidated - message not saved');
      console.warn('   Please reload the page to restore functionality');
      return;
    }

    // Note: Deduplication now happens in page context (inject.js) before dispatch
    // This ensures it works across all capture methods and is accessible from console

    // Forward to background script for storage
    chrome.runtime.sendMessage({
      type: 'SAVE_MESSAGE',
      data: messageData
    }).then(() => {
      console.log('✅ KYT ChatGPT Content: Message forwarded to background');
    }).catch(error => {
      if (error.message && error.message.includes('Extension context invalidated')) {
        console.warn('⚠️ KYT ChatGPT Content: Extension was reloaded - please refresh page');
      } else {
        console.error('❌ KYT ChatGPT Content: Failed to forward message:', error);
      }
    });
  });

  // === CONTEXT REQUEST HANDLER ===
  // Page context cannot call OpenAI/Supabase directly (CSP blocks)
  // So we forward to background script which has no CSP restrictions
  window.addEventListener('KYT_CONTEXT_REQUEST', async function(event) {
    const { requestId, userMessage, config } = event.detail;
    console.log('🔍 KYT ChatGPT Content: Context request from page context');

    // Check if extension context is still valid
    if (!chrome.runtime?.id) {
      console.warn('⚠️ KYT ChatGPT Content: Extension context invalidated - cannot get context');
      console.warn('   Please reload the page to restore functionality');

      // Send error response
      window.dispatchEvent(new CustomEvent('KYT_CONTEXT_RESPONSE', {
        detail: {
          requestId: requestId,
          success: false,
          formattedContext: null,
          items: [],
          error: 'Extension context invalidated - please reload page'
        }
      }));
      return;
    }

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

      console.log('✅ KYT ChatGPT Content: Context response sent to page context');
    } catch (error) {
      // Better error handling for context invalidation
      if (error.message && error.message.includes('Extension context invalidated')) {
        console.warn('⚠️ KYT ChatGPT Content: Extension was reloaded - please refresh page');
      } else {
        console.error('❌ KYT ChatGPT Content: Failed to get context:', error);
      }

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

  // === PHASE 2: STATS REQUEST HANDLER ===
  // Listen for stats requests from background script (via popup)
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'GET_PAGE_STATS') {
      console.log('📊 KYT ChatGPT Content: Stats request received');
      
      // Check if page context has stats function
      if (typeof window.getInterceptionStats === 'function') {
        try {
          const stats = window.getInterceptionStats();
          sendResponse({ success: true, stats });
        } catch (error) {
          console.error('❌ Stats retrieval error:', error);
          sendResponse({ success: false, error: error.message });
        }
      } else {
        // Stats function not available (page not loaded yet or inject failed)
        sendResponse({ 
          success: false, 
          error: 'Stats function not available (page may still be loading)' 
        });
      }
      
      return true; // Keep message channel open for async response
    }
  });

  console.log('✅ KYT ChatGPT Content: Listening for messages from page context');
})();
