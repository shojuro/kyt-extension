/**
 * KYT Memory Extension — Gemini Content Script (ISOLATED World)
 *
 * Purpose: Inject page-context script and relay messages to background.
 * Platform: Gemini (gemini.google.com)
 *
 * Architecture:
 *   inject.js (MAIN world, page context)
 *     → KYT_MESSAGE_CAPTURED CustomEvent
 *     → this script (ISOLATED world)
 *     → chrome.runtime → background.js (service worker)
 *
 * Follows the same pattern as platforms/chatgpt/content.js:
 *   - Script tag injection for MAIN world code
 *   - Dynamic import() for queue-manager.js
 *   - Port-based GET_CONTEXT (not sendMessage)
 *   - Generation guard for extension reload safety
 */

(function () {
  'use strict';

  // ═══════════════════════════════════════════════════════════════════════
  // GENERATION GUARD
  // ═══════════════════════════════════════════════════════════════════════

  const GENERATION = Date.now();
  window.__kytGeminiContentGeneration = GENERATION;

  function isCurrentGeneration() {
    return window.__kytGeminiContentGeneration === GENERATION;
  }

  console.log('🚀 KYT Gemini Content: Initializing (generation ' + GENERATION + ')...');

  // ═══════════════════════════════════════════════════════════════════════
  // MAIN WORLD SCRIPT INJECTION
  // ═══════════════════════════════════════════════════════════════════════

  const injectScript = document.createElement('script');
  injectScript.src = chrome.runtime.getURL('platforms/gemini/inject.js');
  injectScript.onload = function () {
    console.log('✅ KYT Gemini Content: inject.js loaded into page context');
    this.remove();
  };
  injectScript.onerror = function () {
    console.error('❌ KYT Gemini Content: Failed to load inject.js');
  };
  (document.head || document.documentElement).appendChild(injectScript);

  // ═══════════════════════════════════════════════════════════════════════
  // QUEUE MANAGER — Dynamic import (ISOLATED world supports import())
  // ═══════════════════════════════════════════════════════════════════════

  let queueManager = null;

  (async () => {
    try {
      const src = chrome.runtime.getURL('src/content/queue-manager.js');
      const module = await import(src);
      queueManager = module.queueManager;
      await queueManager.initialize(GENERATION);
      console.log('✅ KYT Gemini Content: Queue Manager initialized');
    } catch (e) {
      console.error('❌ KYT Gemini Content: Failed to load Queue Manager:', e.message);
    }
  })();

  // ═══════════════════════════════════════════════════════════════════════
  // MESSAGE CAPTURE — KYT_MESSAGE_CAPTURED → Queue Manager → background
  // ═══════════════════════════════════════════════════════════════════════

  window.addEventListener('KYT_MESSAGE_CAPTURED', async function (event) {
    if (!isCurrentGeneration()) return;

    const data = event.detail;
    if (!data || !data.content) return;

    const messageData = {
      content: data.content,
      role: data.role || 'user',
      platform: 'gemini',
      source: data.captureMethod || 'api',
      conversationId: data.conversationId || null,
      timestamp: data.timestamp || Date.now(),
      messageId: data.messageId || null,
      url: data.url || window.location.href,
    };

    // Check context validity BEFORE attempting any capture — after extension
    // reload, old content.js handlers fire with dead chrome.runtime context.
    if (!chrome.runtime?.id) {
      return; // silently drop — message will be re-captured after page refresh
    }

    if (queueManager) {
      await queueManager.capture(messageData);
    } else {
      // Queue Manager not ready — fallback to direct sendMessage
      if (!chrome.runtime?.id) {
        console.warn('⚠️ KYT Gemini Content: Extension context invalidated — message dropped');
        return;
      }
      chrome.runtime.sendMessage({
        type: 'SAVE_MESSAGE',
        data: messageData
      }).catch(function (error) {
        if (error.message && error.message.includes('Extension context invalidated')) {
          console.warn('⚠️ KYT Gemini Content: Extension reloaded — please refresh page');
        } else {
          console.error('❌ KYT Gemini Content: Failed to forward message:', error.message);
        }
      });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // CONVERSATION WINDOW SCRAPER
  // ═══════════════════════════════════════════════════════════════════════

  function scrapeConversationWindow(maxMessages = 5) {
    try {
      const messages = [];
      // Gemini renders messages in message-content elements or model-response/user-query
      const turns = document.querySelectorAll('message-content, .conversation-turn, [data-content-type]');
      const recent = Array.from(turns).slice(-maxMessages * 2);
      for (const el of recent) {
        const isUser = el.closest('.user-query, [data-is-user]') !== null ||
                       el.getAttribute('data-content-type') === 'user';
        const text = el.textContent?.trim();
        if (text && text.length > 0 && text.length < 500) {
          messages.push({ role: isUser ? 'user' : 'assistant', content: text.substring(0, 200) });
        }
      }
      return messages.slice(-maxMessages);
    } catch (e) {
      return [];
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // CONTEXT INJECTION — Port-based GET_CONTEXT (same as ChatGPT)
  // ═══════════════════════════════════════════════════════════════════════

  let activeContextPort = null;
  let activeContextTimeout = null;

  window.addEventListener('KYT_CONTEXT_REQUEST', function (event) {
    if (!isCurrentGeneration()) return;

    const detail = event.detail;
    if (!detail || !detail.requestId || !detail.userMessage) return;

    const requestId = detail.requestId;

    // Check extension context validity
    if (!chrome.runtime?.id) {
      console.warn('⚠️ KYT Gemini Content: Extension context invalidated — cannot get context');
      dispatchContextResponse(requestId, {
        success: false,
        formattedContext: null,
        items: [],
        error: 'Extension context invalidated'
      });
      return;
    }

    // Cancel any pending context request — only latest message matters
    if (activeContextPort) {
      try {
        clearTimeout(activeContextTimeout);
        activeContextPort.disconnect();
      } catch (_) {}
      activeContextPort = null;
      activeContextTimeout = null;
    }

    // Port-based context request — avoids "message channel closed" errors
    try {
      const port = chrome.runtime.connect({ name: 'kyt-context' });
      activeContextPort = port;
      let responded = false;

      const timeoutId = setTimeout(function () {
        if (responded) return;
        responded = true;
        activeContextPort = null;
        activeContextTimeout = null;
        try { port.disconnect(); } catch (_) {}
        console.warn('⚠️ KYT Gemini Content: Context request timed out (26s)');
        dispatchContextResponse(requestId, {
          success: false,
          formattedContext: null,
          items: [],
          error: 'Context request timed out'
        });
      }, 26000);
      activeContextTimeout = timeoutId;

      port.onMessage.addListener(function (response) {
        if (responded) return;
        responded = true;
        activeContextPort = null;
        activeContextTimeout = null;
        clearTimeout(timeoutId);
        try { port.disconnect(); } catch (_) {}

        dispatchContextResponse(requestId, {
          success: response.success,
          formattedContext: response.formattedContext,
          items: response.items,
          elapsedMs: response.elapsedMs,
          error: response.error
        });
        console.log('✅ KYT Gemini Content: Context response received (' +
          (response.items?.length || 0) + ' items, ' + (response.elapsedMs || '?') + 'ms)');
      });

      port.onDisconnect.addListener(function () {
        if (responded) return;
        responded = true;
        activeContextPort = null;
        activeContextTimeout = null;
        clearTimeout(timeoutId);
        const err = chrome.runtime.lastError?.message || 'Port disconnected';
        console.warn('⚠️ KYT Gemini Content: Context port disconnected:', err);
        dispatchContextResponse(requestId, {
          success: false,
          formattedContext: null,
          items: [],
          error: err
        });
      });

      const conversationWindow = scrapeConversationWindow();
      port.postMessage({
        requestId: requestId,
        userMessage: detail.userMessage,
        config: detail.config || {},
        conversationWindow: conversationWindow
      });

    } catch (error) {
      if (error.message && error.message.includes('Extension context invalidated')) {
        console.warn('⚠️ KYT Gemini Content: Extension reloaded — please refresh page');
      } else {
        console.error('❌ KYT Gemini Content: Failed to open context port:', error.message);
      }
      dispatchContextResponse(requestId, {
        success: false,
        formattedContext: null,
        items: [],
        error: error.message
      });
    }
  });

  function dispatchContextResponse(requestId, result) {
    window.dispatchEvent(new CustomEvent('KYT_CONTEXT_RESPONSE', {
      detail: { requestId: requestId, ...result }
    }));
  }

  // ═══════════════════════════════════════════════════════════════════════
  // STATS REQUEST HANDLER — Background can query page-context stats
  // ═══════════════════════════════════════════════════════════════════════

  chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    if (message.type === 'GET_PAGE_STATS') {
      if (typeof window.__kytGeminiStats === 'function') {
        try {
          sendResponse({ success: true, stats: window.__kytGeminiStats() });
        } catch (e) {
          sendResponse({ success: false, error: e.message });
        }
      } else {
        sendResponse({ success: false, error: 'Stats not available' });
      }
      return true;
    }
  });

  console.log('✅ KYT Gemini Content: Listening for messages from page context');
})();
