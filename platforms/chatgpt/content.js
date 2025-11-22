/**
 * KYT Memory Extension - ChatGPT Content Script
 *
 * Purpose: Inject page context script and relay messages to background
 * Platform: ChatGPT
 *
 * Note: deduplication.js is loaded first (see manifest.json) and provides window.KYT_Deduplicator
 */

(function () {
  'use strict';

  console.log('🚀 KYT ChatGPT Content: Initializing...');

  // === PAGE CONTEXT INJECTION ===
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('platforms/chatgpt/inject.js');
  script.onload = function () {
    console.log('✅ KYT ChatGPT Content: inject.js loaded into page context');
    this.remove();
  };
  script.onerror = function () {
    console.error('❌ KYT ChatGPT Content: Failed to load inject.js');
  };
  (document.head || document.documentElement).appendChild(script);

  // Import queue manager (using dynamic import since this is a content script)
  // Note: Content scripts can import modules if listed in web_accessible_resources or if using a bundler.
  // Since we are using native ES modules in Chrome, we need to import from the src directory.
  // However, content scripts have access to chrome.runtime.getURL.

  // Wait, standard ES modules in content scripts are tricky without a bundler.
  // But manifest.json says "type": "module" for background, but content scripts are just scripts.
  // Unless we specified "type": "module" in manifest for content scripts?
  // Let's check manifest.json.

  // If not a module, we can't use 'import'.
  // We might need to use dynamic import() with chrome.runtime.getURL().

  // Actually, the user prompt implies a TypeScript/Module structure.
  // Given the current setup (vanilla JS), we might need to inject the queue manager code 
  // or load it as a module.

  // Let's assume we can use dynamic import for now, as Chrome supports it in content scripts 
  // if the file is web accessible.

  let queueManager = null;

  (async () => {
    try {
      const src = chrome.runtime.getURL('src/content/queue-manager.js');
      const module = await import(src);
      queueManager = module.queueManager;
      await queueManager.initialize();
      console.log('✅ KYT ChatGPT Content: Queue Manager initialized');
    } catch (e) {
      console.error('❌ KYT ChatGPT Content: Failed to load Queue Manager', e);
    }
  })();

  // === EVENT LISTENER FOR PAGE CONTEXT MESSAGES ===
  window.addEventListener('KYT_MESSAGE_CAPTURED', async function (event) {
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

    // Use Queue Manager if available, otherwise fallback to direct send
    if (queueManager) {
      console.log('📥 KYT ChatGPT Content: Enqueuing message via Queue Manager');
      await queueManager.capture(messageData);
    } else {
      console.warn('⚠️ KYT ChatGPT Content: Queue Manager not ready, falling back to direct send');
      // Forward to background script for storage (Legacy/Fallback)
      chrome.runtime.sendMessage({
        type: 'SAVE_MESSAGE',
        data: messageData
      }).then(() => {
        console.log('✅ KYT ChatGPT Content: Message forwarded to background (Direct)');
      }).catch(error => {
        if (error.message && error.message.includes('Extension context invalidated')) {
          console.warn('⚠️ KYT ChatGPT Content: Extension was reloaded - please refresh page');
        } else {
          console.error('❌ KYT ChatGPT Content: Failed to forward message:', error);
        }
      });
    }
  });

  // === CONTEXT REQUEST HANDLER ===
  // Page context cannot call OpenAI/Supabase directly (CSP blocks)
  // So we forward to background script which has no CSP restrictions
  window.addEventListener('KYT_CONTEXT_REQUEST', async function (event) {
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

  // === DEBUG LOGGING BRIDGE ===
  // Forward logs from page context (inject.js) to background script (Service Worker console)
  window.addEventListener('KYT_DEBUG_LOG', function (event) {
    const { message, data } = event.detail;
    chrome.runtime.sendMessage({
      type: 'DEBUG_LOG',
      message: message,
      data: data
    }).catch(() => {
      // Ignore errors if extension context is invalid (e.g. during reload)
    });
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
