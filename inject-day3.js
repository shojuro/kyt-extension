/**
 * KYT Memory Extension - Page Context Injected Script (Day 3: Context Injection)
 *
 * This script runs in the PAGE CONTEXT (not content script context)
 * allowing it to wrap fetch at the same level as other page scripts
 *
 * Day 3 Enhancement: RAG (Retrieval-Augmented Generation)
 * - Intercepts outgoing ChatGPT API requests
 * - Searches Supabase for relevant context using semantic similarity
 * - Injects context into user prompt (invisible to UI)
 * - Enables ChatGPT to reference past conversations and CLI captures
 *
 * Architecture:
 * 1. User types message → fetch() intercepted
 * 2. Extract user message from request body
 * 3. Generate embedding for message (OpenAI)
 * 4. Search Supabase for relevant context (match_messages RPC)
 * 5. Inject formatted context into request body
 * 6. Continue to ChatGPT with context-augmented prompt
 * 7. Capture original message for future context (Day 1 functionality)
 */

(async function() {
  'use strict';

  console.log('🚀 KYT Injected Script (Day 3 - RAG): Initializing in page context...');

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
   * Get configuration from chrome.storage (extension context)
   * Since we're in page context, we need to communicate with content script
   */
  let cachedApiConfig = null;
  let cachedContextConfig = null;

  async function getConfig() {
    // Use cached config if available
    if (cachedApiConfig && cachedContextConfig) {
      return { apiConfig: cachedApiConfig, contextConfig: cachedContextConfig };
    }

    // Request config from content script via custom event
    return new Promise((resolve) => {
      const requestId = `config_request_${Date.now()}`;

      // Listen for response
      const handler = (event) => {
        if (event.detail.requestId === requestId) {
          window.removeEventListener('KYT_CONFIG_RESPONSE', handler);

          cachedApiConfig = event.detail.apiConfig;
          cachedContextConfig = event.detail.contextConfig || DEFAULT_CONFIG;

          resolve({
            apiConfig: cachedApiConfig,
            contextConfig: cachedContextConfig
          });
        }
      };

      window.addEventListener('KYT_CONFIG_RESPONSE', handler);

      // Request config
      window.dispatchEvent(new CustomEvent('KYT_CONFIG_REQUEST', {
        detail: { requestId }
      }));

      // Timeout after 2 seconds
      setTimeout(() => {
        window.removeEventListener('KYT_CONFIG_RESPONSE', handler);
        resolve({
          apiConfig: null,
          contextConfig: DEFAULT_CONFIG
        });
      }, 2000);
    });
  }

  /**
   * Generate embedding for text using OpenAI
   */
  async function generateEmbedding(text, apiKey) {
    const response = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: 'text-embedding-3-small',
        input: text,
        encoding_format: 'float'
      })
    });

    if (!response.ok) {
      throw new Error(`OpenAI API error: ${response.status}`);
    }

    const data = await response.json();
    return data.data[0].embedding;
  }

  /**
   * Search Supabase for relevant context
   */
  async function searchRelevantContext(queryEmbedding, apiConfig, contextConfig) {
    const response = await fetch(
      `${apiConfig.supabaseUrl}/rest/v1/rpc/match_messages`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': apiConfig.supabaseKey,
          'Authorization': `Bearer ${apiConfig.supabaseKey}`
        },
        body: JSON.stringify({
          query_embedding: queryEmbedding,
          match_threshold: contextConfig.threshold,
          match_count: contextConfig.maxContextItems
        })
      }
    );

    if (!response.ok) {
      throw new Error(`Supabase search error: ${response.status}`);
    }

    const results = await response.json();
    return results.filter(r => r.distance >= contextConfig.minDistance);
  }

  /**
   * Format context for injection
   */
  function formatContext(contextItems, debugMode) {
    if (!contextItems || contextItems.length === 0) {
      return null;
    }

    let context = `[Memory Context - ${contextItems.length} relevant item${contextItems.length > 1 ? 's' : ''}]\n\n`;

    contextItems.forEach((item, index) => {
      const source = item.source === 'cli' ? '📝 Terminal' : '💬 Previous conversation';
      const timestamp = new Date(item.msg_timestamp || item.timestamp).toLocaleDateString();

      context += `${index + 1}. ${source} (${timestamp})\n`;
      context += `   "${item.content}"\n`;

      if (debugMode) {
        context += `   [Distance: ${item.distance.toFixed(3)}, Source: ${item.source}]\n`;
      }

      context += '\n';
    });

    context += '[End of Memory Context]\n\n';
    return context;
  }

  /**
   * Inject context into request body (RAG core logic)
   */
  async function injectContext(userMessage, requestBody) {
    const startTime = performance.now();
    contextInjectionsAttempted++;

    try {
      // Get configurations
      const { apiConfig, contextConfig } = await getConfig();

      if (!apiConfig) {
        if (contextConfig.debugMode) {
          console.log('⏸️ KYT Context: No API config available yet');
        }
        return requestBody;
      }

      if (!contextConfig.enabled) {
        if (contextConfig.debugMode) {
          console.log('⏸️ KYT Context: Disabled in config');
        }
        return requestBody;
      }

      if (contextConfig.debugMode) {
        console.log('🔍 KYT Context: Searching for relevant memories...');
        console.log('   Query:', userMessage.substring(0, 50) + '...');
      }

      // Generate embedding
      const queryEmbedding = await generateEmbedding(userMessage, apiConfig.openaiKey);

      // Search for context
      const contextItems = await searchRelevantContext(
        queryEmbedding,
        apiConfig,
        contextConfig
      );

      if (contextItems.length === 0) {
        if (contextConfig.debugMode) {
          console.log('⚠️ No relevant context found');
        }
        return requestBody;
      }

      // Format and inject context
      const formattedContext = formatContext(contextItems, contextConfig.debugMode);
      const modifiedBody = { ...requestBody };

      // Inject into last message
      if (modifiedBody.messages && Array.isArray(modifiedBody.messages)) {
        const lastIdx = modifiedBody.messages.length - 1;
        const lastMsg = modifiedBody.messages[lastIdx];

        if (lastMsg.content?.parts && Array.isArray(lastMsg.content.parts)) {
          const originalContent = lastMsg.content.parts[0];
          modifiedBody.messages[lastIdx] = {
            ...lastMsg,
            content: {
              ...lastMsg.content,
              parts: [formattedContext + originalContent]
            }
          };
        } else if (typeof lastMsg.content === 'string') {
          modifiedBody.messages[lastIdx] = {
            ...lastMsg,
            content: formattedContext + lastMsg.content
          };
        }
      }

      const elapsedTime = performance.now() - startTime;
      contextInjectionsSucceeded++;

      console.log(`✅ KYT Context: Injected (${elapsedTime.toFixed(0)}ms)`);
      console.log(`   ${contextItems.length} context items, ${formattedContext.length} chars`);

      // Store for debugging
      window.KYT_LAST_CONTEXT = {
        query: userMessage,
        items: contextItems,
        formatted: formattedContext,
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
   * Override fetch in page context (Day 3 version with context injection)
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

        // Day 3: Inject context BEFORE sending to ChatGPT
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
      version: 'Day 3 (RAG)',
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

  console.log('✅ KYT (Day 3): Fetch override with context injection installed');
  console.log('   Debug: window.KYT_HEALTH_CHECK() for stats');
  console.log('   Debug: window.KYT_LAST_CONTEXT for last injection details');
})();
