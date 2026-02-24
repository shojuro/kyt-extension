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

  // Generation guard — prevents stale handlers after extension reload + re-injection.
  // Each re-injection sets a new generation; old handlers see mismatch and bail.
  const GENERATION = Date.now();
  window.__kytChatGPTContentGeneration = GENERATION;

  console.log('🚀 KYT ChatGPT Content: Initializing (generation ' + GENERATION + ')...');

  // === PAGE CONTEXT INJECTION ===
  // Inject API interception script (existing)
  const injectScript = document.createElement('script');
  injectScript.src = chrome.runtime.getURL('platforms/chatgpt/inject.js');
  injectScript.onload = function () {
    console.log('✅ KYT ChatGPT Content: inject.js loaded into page context');
    this.remove();
  };
  injectScript.onerror = function () {
    console.error('❌ KYT ChatGPT Content: Failed to load inject.js');
  };
  (document.head || document.documentElement).appendChild(injectScript);

  // Inject DOM observer script (new - mobile sync capture)
  const domObserverScript = document.createElement('script');
  domObserverScript.src = chrome.runtime.getURL('platforms/chatgpt/dom-observer.js');
  domObserverScript.onload = function () {
    console.log('✅ KYT ChatGPT Content: dom-observer.js loaded into page context');
    this.remove();

    // Sync debug mode (guard: chrome.storage may be undefined after extension reload)
    try {
      chrome.storage?.local?.get(['kytDebugMode'], (result) => {
        if (result?.kytDebugMode) {
          window.dispatchEvent(new CustomEvent('KYT_DOM_COMMAND', {
            detail: { command: 'enableDebug' }
          }));
        }
      });
    } catch (e) {
      // Extension context invalidated — debug mode sync skipped
    }
  };
  domObserverScript.onerror = function () {
    console.error('❌ KYT ChatGPT Content: Failed to load dom-observer.js');
  };
  (document.head || document.documentElement).appendChild(domObserverScript);

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
      await queueManager.initialize(GENERATION);
      console.log('✅ KYT ChatGPT Content: Queue Manager initialized');
    } catch (e) {
      console.error('❌ KYT ChatGPT Content: Failed to load Queue Manager', e);
    }
  })();

  // === EVENT LISTENER FOR PAGE CONTEXT MESSAGES ===
  // API-intercepted messages (existing)
  window.addEventListener('KYT_MESSAGE_CAPTURED', async function (event) {
    if (window.__kytChatGPTContentGeneration !== GENERATION) return; // Stale handler
    const messageData = event.detail;
    console.log('📨 KYT ChatGPT Content: Received message from page context (API)');
    console.log('   Content preview:', messageData.content.substring(0, 50) + '...');
    console.log('   Capture method:', messageData.captureMethod || 'fetch');

    // Always use Queue Manager - it handles context invalidation gracefully
    // Even if context is invalid, queue manager will persist to local storage
    if (queueManager) {
      console.log('📥 KYT ChatGPT Content: Enqueuing message via Queue Manager');
      await queueManager.capture(messageData);
    } else {
      // Queue Manager not ready - check context validity first
      if (!chrome.runtime?.id) {
        // Context invalidated and queue manager not ready — nothing we can do.
        // chrome.storage also fails when context is invalid.
        // Messages will be lost; user needs to refresh the page.
        console.warn('⚠️ KYT ChatGPT Content: Extension context invalidated — message dropped');
        return;
      }

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

  // DOM-observed messages (new - mobile sync)
  window.addEventListener('KYT_DOM_MESSAGE_CAPTURED', async function (event) {
    if (window.__kytChatGPTContentGeneration !== GENERATION) return; // Stale handler
    const messageData = event.detail;
    console.log('📱 KYT ChatGPT Content: Received message from DOM observer (Mobile Sync)');
    console.log('   Content preview:', messageData.content.substring(0, 50) + '...');
    console.log('   Source:', messageData.source);

    // Always use Queue Manager - it handles context invalidation gracefully
    if (queueManager) {
      console.log('📥 KYT ChatGPT Content: Enqueuing DOM message via Queue Manager');
      await queueManager.capture(messageData);
    } else {
      // Queue Manager not ready - check context validity first
      if (!chrome.runtime?.id) {
        console.warn('⚠️ KYT ChatGPT Content: Extension context invalidated — DOM message dropped');
        return;
      }

      console.warn('⚠️ KYT ChatGPT Content: Queue Manager not ready, falling back to direct send');
      chrome.runtime.sendMessage({
        type: 'SAVE_MESSAGE',
        data: messageData
      }).then(() => {
        console.log('✅ KYT ChatGPT Content: DOM message forwarded to background');
      }).catch(error => {
        console.error('❌ KYT ChatGPT Content: Failed to forward DOM message:', error);
      });
    }
  });

  // DOM observer status updates
  window.addEventListener('KYT_DOM_OBSERVER_STATUS', function (event) {
    if (window.__kytChatGPTContentGeneration !== GENERATION) return;
    const { status, restartAttempts } = event.detail;
    console.log(`🔍 KYT DOM Observer Status: ${status} (restarts: ${restartAttempts})`);

    // Forward to background for statistics
    if (chrome.runtime?.id) {
      chrome.runtime.sendMessage({
        type: 'DOM_OBSERVER_STATUS',
        status,
        restartAttempts
      }).catch(() => {
        // Ignore if extension context invalid
      });
    }
  });

  // === TEST API BRIDGE ===
  // Bridge chrome.storage.local API for test script running in page context
  window.addEventListener('KYT_TEST_STORAGE_GET', async function (event) {
    if (window.__kytChatGPTContentGeneration !== GENERATION) return;
    const { requestId, keys } = event.detail;

    try {
      chrome.storage.local.get(keys, (result) => {
        window.dispatchEvent(new CustomEvent('KYT_TEST_STORAGE_RESPONSE', {
          detail: {
            requestId,
            success: true,
            result
          }
        }));
      });
    } catch (error) {
      window.dispatchEvent(new CustomEvent('KYT_TEST_STORAGE_RESPONSE', {
        detail: {
          requestId,
          success: false,
          error: error.message
        }
      }));
    }
  });

  window.addEventListener('KYT_TEST_STORAGE_SET', async function (event) {
    if (window.__kytChatGPTContentGeneration !== GENERATION) return;
    const { requestId, items } = event.detail;

    try {
      chrome.storage.local.set(items, () => {
        window.dispatchEvent(new CustomEvent('KYT_TEST_STORAGE_RESPONSE', {
          detail: {
            requestId,
            success: true
          }
        }));
      });
    } catch (error) {
      window.dispatchEvent(new CustomEvent('KYT_TEST_STORAGE_RESPONSE', {
        detail: {
          requestId,
          success: false,
          error: error.message
        }
      }));
    }
  });

  // Bridge chrome.runtime.sendMessage for test script
  window.addEventListener('KYT_TEST_RUNTIME_MESSAGE', async function (event) {
    if (window.__kytChatGPTContentGeneration !== GENERATION) return;
    const { requestId, message } = event.detail;

    try {
      chrome.runtime.sendMessage(message, (response) => {
        window.dispatchEvent(new CustomEvent('KYT_TEST_RUNTIME_RESPONSE', {
          detail: {
            requestId,
            success: true,
            response
          }
        }));
      });
    } catch (error) {
      window.dispatchEvent(new CustomEvent('KYT_TEST_RUNTIME_RESPONSE', {
        detail: {
          requestId,
          success: false,
          error: error.message
        }
      }));
    }
  });

  // === CONTEXT REQUEST HANDLER ===
  // Page context cannot call OpenAI/Supabase directly (CSP blocks)
  // So we forward to background script which has no CSP restrictions
  window.addEventListener('KYT_CONTEXT_REQUEST', async function (event) {
    if (window.__kytChatGPTContentGeneration !== GENERATION) return; // Stale handler
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

    // Port-based GET_CONTEXT: avoids "message channel closed" error in
    // chrome://extensions when SW dies mid-request (e.g. on extension reload).
    try {
      const port = chrome.runtime.connect({ name: 'kyt-context' });
      let responded = false;

      const timeoutId = setTimeout(() => {
        if (responded) return;
        responded = true;
        try { port.disconnect(); } catch (_) {}
        console.warn('⚠️ KYT ChatGPT Content: Context request timed out (26s)');
        window.dispatchEvent(new CustomEvent('KYT_CONTEXT_RESPONSE', {
          detail: {
            requestId: requestId,
            success: false,
            formattedContext: null,
            items: [],
            error: 'Context request timed out'
          }
        }));
      }, 26000);

      port.onMessage.addListener((response) => {
        if (responded) return;
        responded = true;
        clearTimeout(timeoutId);
        try { port.disconnect(); } catch (_) {}

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
        console.log('✅ KYT ChatGPT Content: Context response sent to page context (port)');
      });

      port.onDisconnect.addListener(() => {
        if (responded) return;
        responded = true;
        clearTimeout(timeoutId);
        const err = chrome.runtime.lastError?.message || 'Port disconnected';
        console.warn('⚠️ KYT ChatGPT Content: Context port disconnected:', err);
        window.dispatchEvent(new CustomEvent('KYT_CONTEXT_RESPONSE', {
          detail: {
            requestId: requestId,
            success: false,
            formattedContext: null,
            items: [],
            error: err
          }
        }));
      });

      port.postMessage({ requestId, userMessage, config });
    } catch (error) {
      if (error.message && error.message.includes('Extension context invalidated')) {
        console.warn('⚠️ KYT ChatGPT Content: Extension was reloaded - please refresh page');
      } else {
        console.error('❌ KYT ChatGPT Content: Failed to open context port:', error);
      }

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
    if (window.__kytChatGPTContentGeneration !== GENERATION) return;
    const { message, data } = event.detail;

    // Check if extension context is valid
    if (!chrome.runtime?.id) return;

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
    } else if (message.type === 'SCAN_DOM') {
      console.log('🔍 KYT ChatGPT Content: Received SCAN_DOM command');
      window.dispatchEvent(new CustomEvent('KYT_DOM_COMMAND', {
        detail: { command: 'scan' }
      }));
      sendResponse({ success: true });
      return false;
    }
  });

  console.log('✅ KYT ChatGPT Content: Listening for messages from page context');
})();
