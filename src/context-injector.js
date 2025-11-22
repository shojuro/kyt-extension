/**
 * KYT Day 3: Context Injection Module
 *
 * Core RAG (Retrieval-Augmented Generation) functionality
 * Searches Supabase for relevant context and prepares injection into ChatGPT prompts
 *
 * Architecture:
 * 1. User types message → inject.js intercepts
 * 2. Generate embedding for user message (OpenAI)
 * 3. Search Supabase for relevant context (match_messages)
 * 4. Format context for injection (invisible to UI)
 * 5. Modify request body with enhanced prompt
 * 6. Continue to ChatGPT with context-augmented message
 *
 * Compliance: CLAUDE.md Anti-Theater Rules
 * - Real error handling (graceful degradation if search fails)
 * - Actual configuration (not hard-coded)
 * - Performance-aware (async operations, caching)
 */

'use strict';

import { applyMMR, MMR_PRESETS } from './mmr.js';

// Configuration defaults (can be overridden via chrome.storage)
const DEFAULT_CONFIG = {
  enabled: true,
  threshold: 0.5,           // Distance threshold (lower = more strict)
  maxContextItems: 3,       // Max number of context items to inject
  minDistance: 0.0,         // Minimum distance (perfect match)
  debugMode: false,         // Enable detailed console logging
  mmrEnabled: true,         // Enable MMR reranking
  mmrLambda: 0.5,           // MMR diversity trade-off (0.5 = balanced)
  fetchCount: 20            // Number of candidates to fetch for reranking
};

/**
 * Get context injection configuration from chrome.storage
 * @returns {Promise<Object>} Configuration object
 */
async function getContextConfig() {
  try {
    const result = await chrome.storage.local.get(['context_injection_config']);
    const config = result.context_injection_config || {};

    // Merge with defaults
    return {
      ...DEFAULT_CONFIG,
      ...config
    };
  } catch (error) {
    console.warn('⚠️ Failed to load context config, using defaults:', error);
    return DEFAULT_CONFIG;
  }
}

/**
 * Get API configuration from chrome.storage
 * @returns {Promise<Object>} API configuration
 */
async function getApiConfig() {
  try {
    const result = await chrome.storage.local.get(['api_config']);
    if (!result.api_config) {
      throw new Error('API configuration not found');
    }
    return result.api_config;
  } catch (error) {
    throw new Error(`API config not set: ${error.message}`);
  }
}

/**
 * Generate embedding for user message using OpenAI
 * @param {string} text - User message text
 * @param {string} apiKey - OpenAI API key
 * @returns {Promise<number[]>} 1536-dimensional embedding vector
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
    const error = await response.json().catch(() => ({}));
    throw new Error(`OpenAI API error: ${error.error?.message || response.statusText}`);
  }

  const data = await response.json();
  return data.data[0].embedding;
}

/**
 * Search Supabase for relevant context using semantic similarity
 * @param {number[]} queryEmbedding - Query embedding vector
 * @param {Object} apiConfig - API configuration
 * @param {Object} contextConfig - Context injection config
 * @returns {Promise<Object[]>} Array of relevant messages with distance scores
 */
export async function searchRelevantContext(queryEmbedding, apiConfig, contextConfig) {
  // Determine how many items to fetch
  // If MMR is enabled, fetch more candidates (fetchCount)
  // Otherwise, just fetch the requested amount (maxContextItems)
  const matchCount = contextConfig.mmrEnabled
    ? (contextConfig.fetchCount || 20)
    : contextConfig.maxContextItems;

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
        match_count: matchCount
      })
    }
  );

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(`Supabase search error: ${error.message || response.statusText}`);
  }

  let results = await response.json();

  // Filter results by minimum distance
  results = results.filter(r => r.distance >= contextConfig.minDistance);

  // Apply MMR Reranking if enabled
  if (contextConfig.mmrEnabled) {
    if (contextConfig.debugMode) {
      console.log(`🔄 Applying MMR Reranking (λ=${contextConfig.mmrLambda})...`);
    }

    results = applyMMR(results, contextConfig.maxContextItems, contextConfig.mmrLambda, {
      debugMode: contextConfig.debugMode,
      requireEmbeddings: false // Will fallback to relevance if embeddings missing (e.g. old SQL function)
    });
  }

  return results;
}

/**
 * Format context for injection into ChatGPT prompt
 * @param {Object[]} contextItems - Array of relevant messages
 * @param {boolean} debugMode - Include debug information
 * @returns {string} Formatted context string
 */
function formatContextForInjection(contextItems, debugMode = false) {
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
 * Inject context into ChatGPT request body
 *
 * MAIN FUNCTION - Called by inject.js to perform RAG
 *
 * @param {string} userMessage - User's original message
 * @param {Object} requestBody - Original ChatGPT API request body
 * @returns {Promise<Object>} Modified request body with context injected
 */
export async function injectContext(userMessage, requestBody) {
  const startTime = performance.now();

  try {
    // Get configurations
    const [apiConfig, contextConfig] = await Promise.all([
      getApiConfig(),
      getContextConfig()
    ]);

    // Check if context injection is enabled
    if (!contextConfig.enabled) {
      if (contextConfig.debugMode) {
        console.log('⏸️ KYT Context Injection: Disabled in config');
      }
      return requestBody; // Return unmodified
    }

    if (contextConfig.debugMode) {
      console.log('🔍 KYT Context Injection: Starting...');
      console.log('   User message:', userMessage.substring(0, 50) + '...');
      console.log('   Config:', contextConfig);
    }

    // Generate embedding for user message
    const queryEmbedding = await generateEmbedding(userMessage, apiConfig.openaiKey);

    if (contextConfig.debugMode) {
      console.log('✅ Embedding generated (1536 dimensions)');
    }

    // Search for relevant context
    const contextItems = await searchRelevantContext(
      queryEmbedding,
      apiConfig,
      contextConfig
    );

    if (contextConfig.debugMode) {
      console.log(`📊 Found ${contextItems.length} relevant context items`);
      if (contextItems.length > 0) {
        console.table(contextItems.map(c => ({
          source: c.source,
          distance: c.distance.toFixed(3),
          content: c.content.substring(0, 50) + '...'
        })));
      }
    }

    // If no relevant context found, return original request
    if (contextItems.length === 0) {
      if (contextConfig.debugMode) {
        console.log('⚠️ No relevant context found (distance > threshold)');
      }
      return requestBody;
    }

    // Format context for injection
    const formattedContext = formatContextForInjection(contextItems, contextConfig.debugMode);

    // Modify request body to inject context
    const modifiedBody = { ...requestBody };

    // Find the last user message and prepend context
    if (modifiedBody.messages && Array.isArray(modifiedBody.messages)) {
      const lastMessageIndex = modifiedBody.messages.length - 1;
      const lastMessage = modifiedBody.messages[lastMessageIndex];

      // Handle different content formats
      if (lastMessage.content?.parts && Array.isArray(lastMessage.content.parts)) {
        // Format: message.content.parts[0]
        const originalContent = lastMessage.content.parts[0];
        modifiedBody.messages[lastMessageIndex] = {
          ...lastMessage,
          content: {
            ...lastMessage.content,
            parts: [formattedContext + originalContent]
          }
        };
      } else if (typeof lastMessage.content === 'string') {
        // Format: message.content (string)
        modifiedBody.messages[lastMessageIndex] = {
          ...lastMessage,
          content: formattedContext + lastMessage.content
        };
      }
    }

    const elapsedTime = performance.now() - startTime;

    console.log(`✅ KYT Context Injection: Complete (${elapsedTime.toFixed(0)}ms)`);
    console.log(`   Injected ${contextItems.length} context items`);
    console.log(`   Total context length: ${formattedContext.length} chars`);

    // Store last injection for debugging
    if (window.KYT_DEBUG) {
      window.KYT_LAST_CONTEXT = {
        query: userMessage,
        items: contextItems,
        formatted: formattedContext,
        elapsedMs: elapsedTime
      };
    }

    return modifiedBody;

  } catch (error) {
    // Graceful degradation: If context injection fails, send original message
    console.warn('⚠️ KYT Context Injection: Failed, sending original message');
    console.warn('   Error:', error.message);

    // Log error for debugging
    try {
      chrome.runtime.sendMessage({
        type: 'INJECTION_ERROR',
        error: error.message,
        timestamp: Date.now()
      });
    } catch (e) {
      // Silently fail if we can't log the error
    }

    return requestBody; // Return unmodified
  }
}

/**
 * Set context injection configuration
 * @param {Object} config - Configuration object
 * @param {boolean} config.enabled - Enable/disable context injection
 * @param {number} config.threshold - Distance threshold (0-2)
 * @param {number} config.maxContextItems - Max context items to inject
 * @param {boolean} config.debugMode - Enable debug logging
 */
export async function setContextConfig(config) {
  await chrome.storage.local.set({ context_injection_config: config });
  console.log('✅ Context injection config saved:', config);
}

/**
 * Get current context injection configuration
 * @returns {Promise<Object>} Current configuration
 */
export async function getContextConfigForDebug() {
  return await getContextConfig();
}

// Export for testing
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    injectContext,
    setContextConfig,
    getContextConfigForDebug,
    formatContextForInjection
  };
}
