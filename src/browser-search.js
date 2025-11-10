/**
 * KYT Day 2: Browser-Compatible Search Module
 *
 * Performs vector similarity search on stored messages
 * Uses fetch() and chrome.storage APIs (works in extension context)
 */

/**
 * Get API configuration from chrome.storage
 * @returns {Promise<Object>} Configuration object
 */
async function getConfig() {
  const result = await chrome.storage.local.get(['api_config']);
  if (!result.api_config) {
    throw new Error('API configuration not found. Please set up API keys first.');
  }
  return result.api_config;
}

/**
 * Generate embedding for search query
 * @param {string} query - Search query text
 * @param {string} apiKey - OpenAI API key
 * @returns {Promise<number[]>} 1536-dimensional embedding vector
 */
async function generateQueryEmbedding(query, apiKey) {
  const response = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: 'text-embedding-3-small',
      input: query,
      encoding_format: 'float'
    })
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(`OpenAI API error: ${error.error?.message || response.statusText}`);
  }

  const data = await response.json();
  return data.data[0].embedding;
}

/**
 * Search messages by semantic similarity
 * @param {string} query - Natural language search query
 * @param {Object} options - Search options
 * @param {number} options.limit - Max results to return (default: 5)
 * @param {number} options.threshold - Min similarity score 0-1 (default: 0.5)
 * @param {string} options.role - Filter by role: 'user' or 'assistant'
 * @param {string} options.source - Filter by source: 'chatgpt' or 'cli'
 * @returns {Promise<Object[]>} Array of matching messages with similarity scores
 */
export async function searchMessages(query, options = {}) {
  const {
    limit = 5,
    threshold = 0.5,
    role = null,
    source = null
  } = options;

  console.log(`🔍 Searching for: "${query}" (limit: ${limit}, threshold: ${threshold})`);

  try {
    // Get config
    const config = await getConfig();

    // Generate query embedding
    const queryEmbedding = await generateQueryEmbedding(query, config.openaiKey);

    // Call Supabase RPC function
    const params = new URLSearchParams({
      query_embedding: JSON.stringify(queryEmbedding),
      match_threshold: threshold.toString(),
      match_count: limit.toString()
    });

    let url = `${config.supabaseUrl}/rest/v1/rpc/match_messages`;

    // Build query
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': config.supabaseKey,
        'Authorization': `Bearer ${config.supabaseKey}`
      },
      body: JSON.stringify({
        query_embedding: queryEmbedding,
        match_threshold: threshold,
        match_count: limit
      })
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(`Supabase search error: ${error.message || response.statusText}`);
    }

    let results = await response.json();

    // Apply additional filters
    if (role) {
      results = results.filter(r => r.role === role);
    }

    if (source) {
      results = results.filter(r => r.source === source);
    }

    console.log(`✅ Found ${results.length} results`);
    return results;

  } catch (error) {
    console.error('❌ Search failed:', error);
    return [];
  }
}

/**
 * Find messages similar to a given message
 * @param {string} messageId - ID of the reference message
 * @param {number} limit - Max results to return
 * @returns {Promise<Object[]>} Similar messages with similarity scores
 */
export async function findSimilarMessages(messageId, limit = 5) {
  try {
    const config = await getConfig();

    // Get the reference message with its embedding
    const response = await fetch(
      `${config.supabaseUrl}/rest/v1/messages?message_id=eq.${messageId}&select=embedding,content`,
      {
        headers: {
          'apikey': config.supabaseKey,
          'Authorization': `Bearer ${config.supabaseKey}`
        }
      }
    );

    if (!response.ok) {
      throw new Error('Failed to fetch reference message');
    }

    const data = await response.json();
    if (!data || data.length === 0) {
      throw new Error('Message not found');
    }

    const refMessage = data[0];

    // Search using the reference message's embedding
    const searchResponse = await fetch(
      `${config.supabaseUrl}/rest/v1/rpc/match_messages`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': config.supabaseKey,
          'Authorization': `Bearer ${config.supabaseKey}`
        },
        body: JSON.stringify({
          query_embedding: refMessage.embedding,
          match_threshold: 0.5,
          match_count: limit + 1 // +1 because reference will match itself
        })
      }
    );

    if (!searchResponse.ok) {
      throw new Error('Search failed');
    }

    let results = await searchResponse.json();

    // Filter out the reference message itself
    results = results.filter(m => m.message_id !== messageId).slice(0, limit);

    console.log(`✅ Found ${results.length} similar messages`);
    return results;

  } catch (error) {
    console.error('❌ Failed to find similar messages:', error);
    return [];
  }
}
