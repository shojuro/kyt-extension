/**
 * KYT Memory Extension - Page Context Injected Script (Day 3: Context Injection - CSP FIXED)
 *
 * This script runs in the PAGE CONTEXT (not content script context)
 * allowing it to wrap fetch at the same level as other page scripts
 *
 * Day 3 Enhancement: RAG (Retrieval-Augmented Generation)
 * - Intercepts outgoing ChatGPT API requests
 * - Requests context from background script (via content script bridge)
 * - Background script calls OpenAI + Supabase (no CSP restrictions)
 * - Injects received context into user prompt (invisible to UI)
 * - Enables ChatGPT to reference past conversations and CLI captures
 *
 * CSP Fix Architecture:
 * 1. User types message → fetch() intercepted
 * 2. Extract user message from request body
 * 3. Send CONTEXT_REQUEST event to content script
 * 4. Content script forwards to background script
 * 5. Background generates embedding + searches Supabase (no CSP!)
 * 6. Background returns formatted context
 * 7. Content script sends CONTEXT_RESPONSE event back
 * 8. Inject formatted context into request body
 * 9. Continue to ChatGPT with context-augmented prompt
 * 10. Capture original message for future context (Day 1 functionality)
 */

(async function() {
  'use strict';

  console.log('🚀 KYT Injected Script (Day 3 - RAG - CSP FIXED): Initializing in page context...');

  // Track interception and injection health
  let lastInterceptionTime = Date.now();
  let totalInterceptions = 0;
  let totalErrors = 0;
  let contextInjectionsAttempted = 0;
  let contextInjectionsSucceeded = 0;
  let contextInjectionsFailed = 0;

  // Configuration defaults
  const DEFAULT_CONFIG = {
    enabled: true,
    threshold: 0.5,
    maxContextItems: 3,
    minDistance: 0.0,
    debugMode: false
  };

  /**
   * Get context from background script via content script bridge (CSP FIX)
   * @param {string} userMessage - User's message text
   * @param {Object} config - Context injection configuration
   * @returns {Promise<Object>} Context data with formatted string
   */
  async function getContextViaBackground(userMessage, config) {
    return new Promise((resolve) => {
      const requestId = `context_request_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

      // Listen for response
      const handler = (event) => {
        if (event.detail.requestId === requestId) {
          window.removeEventListener('KYT_CONTEXT_RESPONSE', handler);
          resolve(event.detail);
        }
      };

      window.addEventListener('KYT_CONTEXT_RESPONSE', handler);

      // Send request to content script
      window.dispatchEvent(new CustomEvent('KYT_CONTEXT_REQUEST', {
        detail: {
          requestId: requestId,
          userMessage: userMessage,
          config: config
        }
      }));

      // Timeout after 3 seconds (fallback to no context)
      setTimeout(() => {
        window.removeEventListener('KYT_CONTEXT_RESPONSE', handler);
        resolve({
          success: false,
          formattedContext: null,
          items: [],
          error: 'Timeout waiting for context response'
        });
      }, 3000);
    });
  }

  /**
   * Inject context into request body (CSP FIXED VERSION)
   */
  async function injectContext(userMessage, requestBody) {
    const startTime = performance.now();
    contextInjectionsAttempted++;

    try {
      // Get context from background script (CSP safe!)
      const contextData = await getContextViaBackground(userMessage, DEFAULT_CONFIG);

      if (!contextData.success || !contextData.formattedContext) {
        if (DEFAULT_CONFIG.debugMode) {
          console.log('⚠️ No context available:', contextData.error || 'No relevant memories found');
        }
        return requestBody; // Return unmodified
      }

      console.log('✅ KYT Context: Received from background script');
      console.log(`   ${contextData.items.length} context items, ${contextData.formattedContext.length} chars`);

      // Inject into request body
      const modifiedBody = { ...requestBody };

      if (modifiedBody.messages && Array.isArray(modifiedBody.messages)) {
        const lastIdx = modifiedBody.messages.length - 1;
        const lastMsg = modifiedBody.messages[lastIdx];

        if (lastMsg.content?.parts && Array.isArray(lastMsg.content.parts)) {
          const originalContent = lastMsg.content.parts[0];
          modifiedBody.messages[lastIdx] = {
            ...lastMsg,
            content: {
              ...lastMsg.content,
              parts: [contextData.formattedContext + originalContent]
            }
          };
        } else if (typeof lastMsg.content === 'string') {
          modifiedBody.messages[lastIdx] = {
            ...lastMsg,
            content: contextData.formattedContext + lastMsg.content
          };
        }
      }

      const elapsedTime = performance.now() - startTime;
      contextInjectionsSucceeded++;

      console.log(`✅ KYT Context: Injected (${elapsedTime.toFixed(0)}ms total)`);

      // Store for debugging
      window.KYT_LAST_CONTEXT = {
        query: userMessage,
        items: contextData.items,
        formatted: contextData.formattedContext,
        elapsedMs: elapsedTime
      };

      return modifiedBody;

    } catch (error) {
      contextInjectionsFailed++;
      console.warn('⚠️ KYT Context: Injection failed, using original message');
      console.warn('   Error:', error.message);
      return requestBody; // Graceful degradation
    }
  }

  /**
   * Extract user message from ChatGPT API request body
   */
  function extractUserMessage(bodyString) {
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
        messageId: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
      };
    } catch (error) {
      console.error('❌ KYT Extraction Error:', error.message);
      return null;
    }
  }

  /**
   * Override fetch in page context (Day 3 version with CSP-fixed context injection)
   */
  const originalFetch = window.fetch;

  window.fetch = async function(...args) {
    let [url, options] = args;

    // Check if this is a ChatGPT conversation API call
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
        console.log('📝 KYT: Message extracted:', messageData.content.substring(0, 50) + '...');

        // Day 3: Inject context BEFORE sending to ChatGPT (CSP FIXED!)
        try {
          const requestBody = JSON.parse(options.body);
          const modifiedBody = await injectContext(messageData.content, requestBody);

          // Update options with modified body
          options = {
            ...options,
            body: JSON.stringify(modifiedBody)
          };

          args[1] = options; // Update args for fetch call
        } catch (error) {
          console.warn('⚠️ Failed to parse/modify request body:', error);
        }

        // Day 1: Send ORIGINAL message to storage (for future context)
        window.dispatchEvent(new CustomEvent('KYT_MESSAGE_CAPTURED', {
          detail: messageData
        }));
      } else {
        console.warn('⚠️ KYT: Failed to extract message');
        totalErrors++;
      }
    }

    // Continue with original (or modified) fetch
    return originalFetch.apply(this, args);
  };

  // Expose health check (enhanced with Day 3 metrics)
  window.KYT_HEALTH_CHECK = function() {
    return {
      context: 'PAGE_CONTEXT',
      version: 'Day 3 (RAG - CSP FIXED)',
      totalInterceptions: totalInterceptions,
      totalErrors: totalErrors,
      contextInjectionsAttempted: contextInjectionsAttempted,
      contextInjectionsSucceeded: contextInjectionsSucceeded,
      contextInjectionsFailed: contextInjectionsFailed,
      successRate: contextInjectionsAttempted > 0
        ? `${((contextInjectionsSucceeded / contextInjectionsAttempted) * 100).toFixed(1)}%`
        : 'N/A',
      lastInterceptionTime: lastInterceptionTime,
      timeSinceLastIntercept: Date.now() - lastInterceptionTime
    };
  };

  // Expose debug function
  window.KYT_LAST_CONTEXT = null;
  window.KYT_DEBUG = true;

  console.log('✅ KYT (Day 3 - CSP FIXED): Fetch override with context injection installed');
  console.log('   Architecture: Page Context → Content Script → Background Script (no CSP!)');
  console.log('   Debug: window.KYT_HEALTH_CHECK() for stats');
  console.log('   Debug: window.KYT_LAST_CONTEXT for last injection details');
})();
