/**
 * KYT Memory Extension - Claude Content Script
 *
 * Purpose: Inject page context script and relay messages to background
 * Platform: Claude
 */

(function() {
  'use strict';

  console.log('🚀 KYT Claude Content: Initializing...');

  // === PAGE CONTEXT INJECTION ===
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('platforms/claude/inject.js');
  script.onload = function() {
    console.log('✅ KYT Claude Content: inject.js loaded into page context');
    this.remove();
  };
  script.onerror = function() {
    console.error('❌ KYT Claude Content: Failed to load inject.js');
  };
  (document.head || document.documentElement).appendChild(script);

  // === EVENT LISTENER FOR PAGE CONTEXT MESSAGES ===
  window.addEventListener('KYT_MESSAGE_CAPTURED', function(event) {
    const messageData = event.detail;
    console.log('📨 KYT Claude Content: Received message from page context');
    console.log('   Content preview:', messageData.content.substring(0, 50) + '...');

    // Forward to background script for storage
    chrome.runtime.sendMessage({
      type: 'SAVE_MESSAGE',
      data: messageData
    }).then(() => {
      console.log('✅ KYT Claude Content: Message forwarded to background');
    }).catch(error => {
      console.error('❌ KYT Claude Content: Failed to forward message:', error);
    });
  });

  // === CONVERSATION WINDOW SCRAPER ===
  function scrapeConversationWindow(maxMessages = 5) {
    try {
      const messages = [];
      // Claude renders messages in [data-is-streaming] parent containers
      const messageEls = document.querySelectorAll('[class*="Message"], .prose, [data-testid*="message"]');
      const recent = Array.from(messageEls).slice(-maxMessages * 2);
      for (const el of recent) {
        const isHuman = el.closest('[data-testid="human-message"], .human-message') !== null;
        const text = el.textContent?.trim();
        if (text && text.length > 0 && text.length < 500) {
          messages.push({ role: isHuman ? 'user' : 'assistant', content: text.substring(0, 200) });
        }
      }
      return messages.slice(-maxMessages);
    } catch (e) {
      return [];
    }
  }

  // === CONTEXT REQUEST HANDLER ===
  // Page context cannot call OpenAI/Supabase directly (CSP blocks)
  // So we forward to background script which has no CSP restrictions
  window.addEventListener('KYT_CONTEXT_REQUEST', async function(event) {
    const { requestId, userMessage, config } = event.detail;
    console.log('🔍 KYT Claude Content: Context request from page context');

    try {
      const conversationWindow = scrapeConversationWindow(5);
      // Forward to background script (no CSP restrictions there!)
      const response = await chrome.runtime.sendMessage({
        type: 'GET_CONTEXT',
        userMessage: userMessage,
        config: config,
        conversationWindow: conversationWindow
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

      console.log('✅ KYT Claude Content: Context response sent to page context');
    } catch (error) {
      console.error('❌ KYT Claude Content: Failed to get context:', error);

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

  // === PHASE 2: DIAGNOSTIC STATS HANDLER ===
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'GET_PAGE_STATS') {
      console.log('📊 KYT Claude Content: Stats request received');
      
      // Get stats from page context (inject.js)
      if (typeof window.getInterceptionStats === 'function') {
        try {
          const stats = window.getInterceptionStats();
          sendResponse({ success: true, stats });
        } catch (error) {
          console.error('❌ Stats retrieval error:', error);
          sendResponse({ success: false, error: error.message });
        }
      } else {
        sendResponse({ 
          success: false, 
          error: 'Stats function not available (page may still be loading)' 
        });
      }
      
      return true; // Keep message channel open
    }
  });

  console.log('✅ KYT Claude Content: Listening for messages from page context');
})();
