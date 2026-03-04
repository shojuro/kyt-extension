/**
 * KYT Day 2: Browser-Compatible Search Module
 *
 * Performs vector similarity search on stored messages
 * Uses fetch() and chrome.storage APIs (works in extension context)
 *
 * Phase 7: Query Transformation Integration
 * - Transforms vague queries into optimized search terms
 * - Improves search precision via LLM-powered rewriting
 * - Graceful fallback to original query if transformation fails
 */

import { transformQuery, extractRecentTopics } from './query-transformer.js';
import { searchBM25, getAdaptiveWeights, countQueryWords } from './bm25-search.js';
import { QueryExpander } from './query-expansion.js';
import {
  isEmbeddingCircuitOpen,
  recordEmbeddingSuccess,
  recordEmbeddingFailure,
  jinaCB
} from './embedding-circuit-breaker.js';
import { fetchWithTimeout } from './utils/fetch.js';
import { generateHyDEDocument, hydeCB } from './hyde-search-generator.js';
import { getActiveProfileId } from './profile-manager.js';

// Defensive flags: set after first error indicating profile_id migrations aren't applied.
// Once set, all subsequent calls skip profile_id params for this SW lifecycle.
const _profileCompat = {
  rpcUnavailable: false,   // p_profile_id param missing from RPCs
  restUnavailable: false,  // profile_id column missing from tables
};

// Matryoshka truncation: Qwen3-Embedding-8B at 1024d for HNSW indexing
const EMBEDDING_DIMS = 1024;
function truncateAndNormalize(embedding, dims) {
  const truncated = embedding.slice(0, dims);
  const norm = Math.sqrt(truncated.reduce((sum, val) => sum + val * val, 0));
  if (norm === 0) return truncated;
  return truncated.map(val => val / norm);
}

// Initialize expander
const queryExpander = new QueryExpander();

// API timeout settings (prevent Chrome message channel timeout)
const API_TIMEOUT_MS = 8000; // 8 seconds max for HuggingFace calls
const API_RETRY_DELAY_MS = 500; // 500ms between retries
const API_MAX_RETRIES = 2; // Max retries for transient failures

// Jina reranker settings — capped at 5s to stay within 10s injection budget
const JINA_TIMEOUT_MS = 5000;  // 5s timeout (was 15s, exceeded injection deadline)
const MAX_RERANK_DOCS = 25;    // Send all merged results to Jina (was 10 — missed relevant items at rank 11+)
const MAX_JINA_ATTEMPTS = 2;   // One retry on timeout for cold-start recovery

/**
 * Get API configuration from chrome.storage
 * @returns {Promise<Object>} Configuration object
 */
async function getConfig() {
  const result = await chrome.storage.local.get(['api_config', 'user_id', 'auth_session']);
  if (!result.api_config) {
    throw new Error('API configuration not found. Please set up API keys first.');
  }
  const config = result.api_config;
  // Resolve userId: prefer auth session > stored user_id > config userId
  // The sync path writes user_id to storage — search should use the same ID
  if (!config.userId) {
    const authUserId = result.auth_session?.user?.id;
    const storedUserId = result.user_id;
    config.userId = authUserId || storedUserId || null;
  }
  console.log(`🔑 Search config: userId=${config.userId || 'NULL'}, source=${result.auth_session?.user?.id ? 'auth' : result.user_id ? 'stored' : 'none'}`);
  return config;
}

/**
 * Generate embedding for search query using Qwen3-Embedding-8B via Scaleway API
 * Uses timeout and retry logic to prevent Chrome message channel timeout
 * @param {string} query - Search query text
 * @param {string} _apiKey - Unused (kept for backward compatibility)
 * @returns {Promise<number[]|null>} 1024-dimensional embedding vector (Matryoshka-truncated), or null on failure
 */
async function generateQueryEmbedding(query, _apiKey) {
  // Check shared circuit breaker FIRST — skip instantly if open
  const circuitStatus = await isEmbeddingCircuitOpen();
  if (circuitStatus.open) {
    console.warn(`⚠️ Embedding circuit breaker open, skipping search embedding: ${circuitStatus.reason}`);
    return null;
  }

  const config = await getConfig();
  const HF_API_KEY = config.huggingfaceKey;

  if (!HF_API_KEY) {
    console.warn('⚠️ HuggingFace API key not configured, skipping semantic search');
    return null; // Graceful degradation instead of throwing
  }

  let lastError = null;

  for (let attempt = 0; attempt <= API_MAX_RETRIES; attempt++) {
    try {
      if (attempt > 0) {
        console.log(`   🔄 Retry ${attempt}/${API_MAX_RETRIES} for embedding generation...`);
        await new Promise(resolve => setTimeout(resolve, API_RETRY_DELAY_MS));
      }

      // Use HuggingFace Router to Scaleway (accepts HF API key, OpenAI-compatible format)
      const response = await fetchWithTimeout(
        'https://router.huggingface.co/scaleway/v1/embeddings',
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${HF_API_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model: 'qwen3-embedding-8b',
            input: query  // Scaleway uses 'input' not 'inputs'
          })
        },
        API_TIMEOUT_MS
      );

      // Handle rate limiting (429)
      if (response.status === 429) {
        console.warn(`   ⏳ Rate limited (429), waiting before retry...`);
        await recordEmbeddingFailure(429, 'Rate limited');
        lastError = new Error('Rate limited, retry needed');
        await new Promise(resolve => setTimeout(resolve, 2000));
        continue; // Retry
      }

      // Handle model loading (503) - retry
      if (response.status === 503) {
        const errorData = await response.json().catch(() => ({}));
        const errorMsg = errorData.error || 'Model is loading';
        console.warn(`   ⏳ Model loading (503): ${errorMsg}`);
        await recordEmbeddingFailure(503, errorMsg);
        lastError = new Error('Model is loading, retry needed');
        continue; // Retry
      }

      if (!response.ok) {
        const errorText = await response.text();
        await recordEmbeddingFailure(response.status, errorText);
        throw new Error(`HF Router (Scaleway) API error: ${response.status} - ${errorText}`);
      }

      const responseData = await response.json();

      // OpenAI-compatible format: { data: [{ embedding: [...4096 floats...] }] }
      if (responseData.data && Array.isArray(responseData.data) && responseData.data[0]?.embedding) {
        await recordEmbeddingSuccess();
        return truncateAndNormalize(responseData.data[0].embedding, EMBEDDING_DIMS);
      }

      // Fallback: handle legacy format if present
      if (Array.isArray(responseData) && Array.isArray(responseData[0])) {
        await recordEmbeddingSuccess();
        return truncateAndNormalize(responseData[0], EMBEDDING_DIMS);
      }
      if (Array.isArray(responseData)) {
        await recordEmbeddingSuccess();
        return truncateAndNormalize(responseData, EMBEDDING_DIMS);
      }

      throw new Error('Unexpected embedding response format from Scaleway');

    } catch (error) {
      lastError = error;
      console.warn(`   ⚠️ Embedding attempt ${attempt + 1} failed: ${error.message}`);

      // Don't retry on timeout or non-transient errors
      if (error.message.includes('timed out') || error.message.includes('API error: 4')) {
        break;
      }
    }
  }

  console.error(`❌ Embedding generation failed after ${API_MAX_RETRIES + 1} attempts: ${lastError?.message}`);
  return null; // Graceful degradation - semantic search will be skipped
}

/**
 * Pre-warm the HuggingFace embedding model by sending a lightweight request.
 * Eliminates cold-start penalty (~5-8s) on first real query.
 * Safe to call repeatedly — returns silently if circuit breaker is open or keys missing.
 * @returns {Promise<boolean>} true if warm-up succeeded, false otherwise
 */
export async function prewarmEmbeddingModel() {
  try {
    const circuitStatus = await isEmbeddingCircuitOpen();
    if (circuitStatus.open) return false;

    const config = await getConfig();
    if (!config.huggingfaceKey) return false;

    const response = await fetchWithTimeout(
      'https://router.huggingface.co/scaleway/v1/embeddings',
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${config.huggingfaceKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'qwen3-embedding-8b',
          input: 'warmup'
        })
      },
      API_TIMEOUT_MS
    );

    if (response.ok) {
      await recordEmbeddingSuccess();
      console.log('🔥 Embedding model pre-warmed successfully');
      return true;
    }

    return false;
  } catch {
    // Silently fail — pre-warm is best-effort
    return false;
  }
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
    source = null,
    skipTransformation = false // Option to bypass transformation for testing
  } = options;

  console.log(`🔍 Searching for: "${query}" (limit: ${limit}, threshold: ${threshold})`);

  try {
    // Get config
    const config = await getConfig();

    // PHASE 7: Query Transformation
    // Check environment flag (DISABLE_QUERY_TRANSFORMATION) or skipTransformation option
    const shouldSkipTransformation = skipTransformation || config.disableQueryTransformation;

    let searchQuery = query;
    if (!shouldSkipTransformation) {
      // Get recent messages for context
      const storageResult = await chrome.storage.local.get(['captured_messages']);
      const recentMessages = storageResult.captured_messages || [];
      const recentTopics = extractRecentTopics(recentMessages);

      // Transform query
      const transformResult = await transformQuery(
        query,
        {
          recentTopics: recentTopics,
          searchContext: 'chat_history'
        },
        null
      );

      if (transformResult.success && transformResult.transformed) {
        searchQuery = transformResult.optimizedQuery;
        console.log(`🔄 Query transformed: "${query}" → "${searchQuery}"`);
      } else {
        console.log(`📊 Using original query (transformation ${transformResult.transformed ? 'succeeded' : 'failed'})`);
      }
    }

    // Generate query embedding (using transformed or original query)
    const queryEmbedding = await generateQueryEmbedding(searchQuery, null);

    // Handle graceful degradation - if embedding fails, return empty results
    if (!queryEmbedding) {
      console.warn('⚠️ Semantic search skipped - embedding generation failed');
      return [];
    }

    // Call Supabase RPC function
    // Prepare server-side filters
    const filter = {};
    if (role) filter.role = role;
    if (source) filter.source = source;

    // Add user_id to filter — skip Supabase semantic search if no userId available
    if (!config.userId) {
      console.warn('⚠️ Semantic search skipped: no userId available (fresh install?)');
      return [];
    }
    filter.user_id = config.userId;

    // Calculate min_timestamp if exclude_recent_seconds is provided
    // Note: exclude_recent_seconds is usually handled by caller (background.js) but we can support it here
    let minTimestamp = 0;
    if (options.minTimestamp) {
      minTimestamp = options.minTimestamp;
    }

    // Resolve profile for multi-profile isolation
    const searchProfileId = _profileCompat.rpcUnavailable ? null : await getActiveProfileId();

    const rpcBody = {
      query_embedding: queryEmbedding,
      match_threshold: config.matchThreshold || 0.6, // Calibrated optimal threshold
      match_count: limit,
      filter: filter,
      min_timestamp: minTimestamp,
    };
    if (searchProfileId) {
      rpcBody.p_profile_id = searchProfileId;
    }

    let url = `${config.supabaseUrl}/rest/v1/rpc/match_messages_v2`;

    // Build query — with AbortController timeout to prevent Supabase's 30s
    // statement_timeout from blocking the entire pipeline
    const SEMANTIC_FETCH_TIMEOUT_MS = 10000;
    const controller = new AbortController();
    const fetchTimer = setTimeout(() => controller.abort(), SEMANTIC_FETCH_TIMEOUT_MS);

    let response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': config.supabaseKey,
          'Authorization': `Bearer ${config.supabaseKey}`
        },
        body: JSON.stringify(rpcBody),
        signal: controller.signal
      });
    } catch (fetchErr) {
      clearTimeout(fetchTimer);
      if (fetchErr.name === 'AbortError') {
        console.warn(`⚠️ Semantic search aborted (${SEMANTIC_FETCH_TIMEOUT_MS / 1000}s timeout)`);
        return [];
      }
      throw fetchErr;
    }
    clearTimeout(fetchTimer);

    // Retry without p_profile_id if RPC signature mismatch (migration not applied)
    if (!response.ok && rpcBody.p_profile_id) {
      const error = await response.json();
      if (error.message?.includes('p_profile_id') || error.message?.includes('function') || response.status === 404) {
        console.warn('⚠️ match_messages_v2 missing p_profile_id param — retrying without (migration pending)');
        _profileCompat.rpcUnavailable = true;
        delete rpcBody.p_profile_id;

        const retryController = new AbortController();
        const retryTimer = setTimeout(() => retryController.abort(), SEMANTIC_FETCH_TIMEOUT_MS);
        try {
          response = await fetch(url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'apikey': config.supabaseKey,
              'Authorization': `Bearer ${config.supabaseKey}`
            },
            body: JSON.stringify(rpcBody),
            signal: retryController.signal
          });
        } catch (retryErr) {
          clearTimeout(retryTimer);
          if (retryErr.name === 'AbortError') {
            console.warn(`⚠️ Semantic search retry aborted (${SEMANTIC_FETCH_TIMEOUT_MS / 1000}s timeout)`);
            return [];
          }
          throw retryErr;
        }
        clearTimeout(retryTimer);
      } else {
        throw new Error(`Supabase search error: ${error.message || response.statusText}`);
      }
    }

    if (!response.ok) {
      const error = await response.json();
      throw new Error(`Supabase search error: ${error.message || response.statusText}`);
    }

    let results = await response.json();

    // Client-side filtering removed as it is now handled server-side for better precision/recall balance
    // (Supabase returns top N *matching* results, not top N then filtered)

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
      `${config.supabaseUrl}/rest/v1/messages?message_id=eq.${messageId}&user_id=eq.${config.userId}&select=embedding,content`,
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

    // Resolve profile for multi-profile isolation
    const similarProfileId = await getActiveProfileId();

    // Search using the reference message's embedding
    const searchResponse = await fetch(
      `${config.supabaseUrl}/rest/v1/rpc/match_messages_v2`,
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
          match_count: limit + 1, // +1 because reference will match itself
          filter: {
            user_id: config.userId // Filter by User ID
          },
          p_profile_id: similarProfileId || null
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

/**
 * Supabase text search fallback
 * Used when local BM25 returns 0 results (cross-platform memories only exist in Supabase)
 * Uses Supabase's ilike filter on content column with keyword splitting
 *
 * @param {string} query - Search query text
 * @param {Object} options - Search options
 * @param {number} options.limit - Max results (default: 10)
 * @param {string} options.role - Filter by role
 * @param {string} options.source - Filter by source
 * @param {number} options.maxTimestamp - Maximum timestamp filter (exclude messages newer than this)
 * @returns {Promise<Object[]>} Results with bm25_score field for RRF compatibility
 */
async function searchSupabaseText(query, options = {}) {
  const { limit = 10, role = null, source = null, maxTimestamp = 0 } = options;

  try {
    const config = await getConfig();

    // Extract keywords: split on whitespace, filter short/stop words
    const stopWords = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'were', 'in', 'on', 'at', 'to', 'for', 'of', 'and', 'or', 'but', 'with', 'about', 'me', 'my', 'i', 'you', 'he', 'she', 'it', 'we', 'they', 'do', 'does', 'did', 'have', 'has', 'had', 'be', 'been', 'being', 'what', 'which', 'who', 'when', 'where', 'how', 'that', 'this', 'tell']);
    const keywords = query
      .toLowerCase()
      .replace(/[^\w\s-]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length >= 2 && !stopWords.has(w));

    if (keywords.length === 0) {
      console.log('   🔤 Supabase text search: no viable keywords from query');
      return [];
    }

    console.log(`   🔤 Supabase text search: keywords=[${keywords.join(', ')}]`);

    // Build filter params
    let filterParams = `select=message_id,content,role,source,timestamp,conversation_id&limit=${limit}&order=timestamp.desc`;

    // User ID filter — skip Supabase text search if no userId
    if (!config.userId) {
      console.warn('⚠️ Supabase text search skipped: no userId available');
      return [];
    }
    filterParams += `&user_id=eq.${config.userId}`;
    // Profile isolation filter — omit if column doesn't exist yet (migration pending)
    let textSearchProfileFilter = '';
    if (!_profileCompat.restUnavailable) {
      const searchProfileId = await getActiveProfileId();
      if (searchProfileId) {
        textSearchProfileFilter = `&profile_id=eq.${searchProfileId}`;
      }
    }
    filterParams += textSearchProfileFilter;
    // P1 fix: exclude questions from text search results
    filterParams += '&or=(is_question.eq.false,is_question.is.null)';
    // P3 fix: exclude deflection responses from text search results
    filterParams += '&or=(deflection.lt.0.70,deflection.is.null)';
    // Exclude rows marked as test/pollution data
    filterParams += '&or=(exclude_from_search.eq.false,exclude_from_search.is.null)';
    if (role) {
      filterParams += `&role=eq.${role}`;
    }
    if (source) {
      filterParams += `&source=eq.${source}`;
    }

    // Search for each keyword via ilike, deduplicate results
    const resultMap = new Map(); // message_id → result with hit count

    for (const keyword of keywords) {
      try {
        let url = `${config.supabaseUrl}/rest/v1/messages?${filterParams}&content=ilike.*${encodeURIComponent(keyword)}*`;
        let response = await fetchWithTimeout(url, {
          headers: {
            'apikey': config.supabaseKey,
            'Authorization': `Bearer ${config.supabaseKey}`
          }
        }, 8000);

        // Retry without profile_id if column doesn't exist (migration pending)
        if (!response.ok && response.status === 400 && textSearchProfileFilter) {
          const errBody = await response.text();
          if (errBody.includes('profile_id')) {
            console.warn('⚠️ messages table missing profile_id column — retrying without (migration pending)');
            _profileCompat.restUnavailable = true;
            // Rebuild URL without profile_id filter
            const fallbackParams = filterParams.replace(textSearchProfileFilter, '');
            url = `${config.supabaseUrl}/rest/v1/messages?${fallbackParams}&content=ilike.*${encodeURIComponent(keyword)}*`;
            // Also strip from filterParams for remaining keywords
            filterParams = fallbackParams;
            textSearchProfileFilter = '';
            response = await fetchWithTimeout(url, {
              headers: {
                'apikey': config.supabaseKey,
                'Authorization': `Bearer ${config.supabaseKey}`
              }
            }, 8000);
          }
        }

        if (!response.ok) {
          console.warn(`   ⚠️ Supabase text search for "${keyword}" failed: ${response.status}`);
          continue;
        }

        const data = await response.json();

        if (data.length === 0) {
          console.log(`   🔤 No matches for "${keyword}" (userId: ${config.userId})`);
        }

        for (const row of data) {
          const id = row.message_id;
          if (resultMap.has(id)) {
            // Increment hit count for keyword coverage scoring
            resultMap.get(id).hitCount += 1;
          } else {
            // Apply timestamp filter client-side: exclude messages NEWER than maxTimestamp
            const rowTimestamp = row.timestamp || 0;
            if (maxTimestamp > 0 && rowTimestamp > maxTimestamp) continue;

            resultMap.set(id, {
              ...row,
              hitCount: 1
            });
          }
        }
      } catch (keywordError) {
        console.warn(`   ⚠️ Supabase text search for "${keyword}" error: ${keywordError.message}`);
      }
    }

    // Convert to array, score by keyword coverage, sort
    const results = Array.from(resultMap.values())
      .map((item, _idx, arr) => ({
        ...item,
        // Score: keyword coverage ratio (how many keywords matched)
        bm25_score: item.hitCount / keywords.length,
        // Remove internal field
        hitCount: undefined
      }))
      .sort((a, b) => b.bm25_score - a.bm25_score)
      .slice(0, limit);

    console.log(`   ✅ Supabase text search: ${results.length} results from ${resultMap.size} unique matches`);
    return results;

  } catch (error) {
    console.error('   ❌ Supabase text search failed:', error.message);
    return [];
  }
}

/**
 * Supabase text search on chat_turns table (keyword fallback for cross-platform recall).
 * Mirrors searchSupabaseText() but targets chat_turns — the primary retrieval table.
 * This ensures Gemini and other platform content with null embeddings can still be
 * found via keyword matching.
 *
 * @param {string} query - Search query text
 * @param {Object} options - Search options
 * @param {number} options.limit - Max results (default: 10)
 * @param {number} options.maxTimestamp - Exclude messages newer than this
 * @returns {Promise<Object[]>} Results with bm25_score field for RRF compatibility
 */
async function searchSupabaseChatTurnsText(query, options = {}) {
  const { limit = 10, maxTimestamp = 0 } = options;

  try {
    const config = await getConfig();

    // Extract keywords: split on whitespace, filter short/stop words
    const stopWords = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'were', 'in', 'on', 'at', 'to', 'for', 'of', 'and', 'or', 'but', 'with', 'about', 'me', 'my', 'i', 'you', 'he', 'she', 'it', 'we', 'they', 'do', 'does', 'did', 'have', 'has', 'had', 'be', 'been', 'being', 'what', 'which', 'who', 'when', 'where', 'how', 'that', 'this', 'tell']);
    const keywords = query
      .toLowerCase()
      .replace(/[^\w\s-]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length >= 2 && !stopWords.has(w));

    if (keywords.length === 0) {
      console.log('   🔤 chat_turns text search: no viable keywords from query');
      return [];
    }

    console.log(`   🔤 chat_turns text search: keywords=[${keywords.join(', ')}]`);

    // Build filter params
    let filterParams = `select=id,content,contextual_content,platform,start_timestamp,conversation_id,speakers&limit=${limit}&order=start_timestamp.desc`;

    // User ID filter
    if (!config.userId) {
      console.warn('⚠️ chat_turns text search skipped: no userId available');
      return [];
    }
    filterParams += `&user_id=eq.${config.userId}`;

    // Profile isolation filter
    let textSearchProfileFilter = '';
    if (!_profileCompat.restUnavailable) {
      const searchProfileId = await getActiveProfileId();
      if (searchProfileId) {
        textSearchProfileFilter = `&profile_id=eq.${searchProfileId}`;
      }
    }
    filterParams += textSearchProfileFilter;

    // Exclude questions and deflections
    filterParams += '&or=(is_question.eq.false,is_question.is.null)';
    filterParams += '&or=(deflection.lt.0.70,deflection.is.null)';
    filterParams += '&or=(exclude_from_search.eq.false,exclude_from_search.is.null)';

    // Search for each keyword via ilike, deduplicate results
    const resultMap = new Map();

    for (const keyword of keywords) {
      try {
        let url = `${config.supabaseUrl}/rest/v1/chat_turns?${filterParams}&content=ilike.*${encodeURIComponent(keyword)}*`;
        let response = await fetchWithTimeout(url, {
          headers: {
            'apikey': config.supabaseKey,
            'Authorization': `Bearer ${config.supabaseKey}`
          }
        }, 8000);

        // Retry without profile_id if column doesn't exist
        if (!response.ok && response.status === 400 && textSearchProfileFilter) {
          const errBody = await response.text();
          if (errBody.includes('profile_id')) {
            console.warn('⚠️ chat_turns missing profile_id column — retrying without (migration pending)');
            _profileCompat.restUnavailable = true;
            const fallbackParams = filterParams.replace(textSearchProfileFilter, '');
            url = `${config.supabaseUrl}/rest/v1/chat_turns?${fallbackParams}&content=ilike.*${encodeURIComponent(keyword)}*`;
            filterParams = fallbackParams;
            textSearchProfileFilter = '';
            response = await fetchWithTimeout(url, {
              headers: {
                'apikey': config.supabaseKey,
                'Authorization': `Bearer ${config.supabaseKey}`
              }
            }, 8000);
          }
        }

        if (!response.ok) {
          console.warn(`   ⚠️ chat_turns text search for "${keyword}" failed: ${response.status}`);
          continue;
        }

        const data = await response.json();

        for (const row of data) {
          const id = row.id;
          if (resultMap.has(id)) {
            resultMap.get(id).hitCount += 1;
          } else {
            // Apply timestamp filter client-side
            const rowTimestamp = row.start_timestamp || 0;
            if (maxTimestamp > 0 && rowTimestamp > maxTimestamp) continue;

            resultMap.set(id, {
              // Map to searchHybrid's expected shape
              message_id: row.id,
              id: row.id,
              content: row.content,
              conversation_id: row.conversation_id,
              source: row.platform,
              timestamp: row.start_timestamp,
              speakers: row.speakers,
              hitCount: 1
            });
          }
        }
      } catch (keywordError) {
        console.warn(`   ⚠️ chat_turns text search for "${keyword}" error: ${keywordError.message}`);
      }
    }

    // Score by keyword coverage, sort
    const results = Array.from(resultMap.values())
      .map(item => ({
        ...item,
        bm25_score: item.hitCount / keywords.length,
        hitCount: undefined
      }))
      .sort((a, b) => b.bm25_score - a.bm25_score)
      .slice(0, limit);

    console.log(`   ✅ chat_turns text search: ${results.length} results from ${resultMap.size} unique matches`);
    return results;

  } catch (error) {
    console.error('   ❌ chat_turns text search failed:', error.message);
    return [];
  }
}

/**
 * Graph walk: traverse entity relationships to find conceptually related chat_turns.
 * Generates query embedding, then calls search_entities_by_embedding → graph_walk_from_entities RPCs.
 *
 * @param {string} query - Search query text
 * @param {Object} options - Search options
 * @param {number} options.limit - Max results (default: 10)
 * @param {number} options.maxTimestamp - Exclude messages newer than this
 * @returns {Promise<Object[]>} Results with relationship_strength for RRF
 */
// Concept synonym expansion for entity text search
// Maps vague referential terms → domain-specific equivalents
// Only applied when embedding entity search returns 0 results
const ENTITY_CONCEPT_SYNONYMS = new Map([
  // Memory modes
  ['level',    ['mode', 'tier']],
  ['levels',   ['modes', 'tiers']],
  ['tier',     ['mode', 'level']],
  ['tiers',    ['modes', 'levels']],
  // Sports
  ['nfl',      ['football', 'player', 'quarterback']],
  ['football', ['nfl', 'player']],
  ['player',   ['athlete']],
  ['players',  ['athletes']],
  // Health & fitness
  ['weight',   ['diet', 'fitness', 'kg']],
  ['diet',     ['weight', 'nutrition']],
  ['fitness',  ['exercise', 'workout']],
  // General domains
  ['goal',     ['target', 'objective']],
  ['goals',    ['targets', 'objectives']],
  ['book',     ['reading', 'author']],
  ['books',    ['reading', 'authors']],
]);

async function searchGraphWalk(query, options = {}) {
  const { limit = 10, maxTimestamp = 0 } = options;

  if (!query) return [];

  // Generate embedding for entity search
  const queryEmbedding = await generateQueryEmbedding(query, null);
  if (!queryEmbedding) return [];

  try {
    const config = await getConfig();
    if (!config.userId) {
      console.warn('⚠️ Graph walk skipped: no userId available');
      return [];
    }
    const userId = config.userId;
    const graphProfileId = _profileCompat.rpcUnavailable ? null : await getActiveProfileId();

    // Step 1: Find entities matching the query embedding
    const entityRpcBody = {
      query_embedding: queryEmbedding,
      match_threshold: 0.8,
      match_count: 5,
      p_user_id: userId,
    };
    if (graphProfileId) {
      entityRpcBody.p_profile_id = graphProfileId;
    }

    let entityResponse = await fetchWithTimeout(
      `${config.supabaseUrl}/rest/v1/rpc/search_entities_by_embedding`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': config.supabaseKey,
          'Authorization': `Bearer ${config.supabaseKey}`
        },
        body: JSON.stringify(entityRpcBody)
      },
      5000
    );

    // Retry without p_profile_id if RPC signature mismatch (migration pending)
    if (!entityResponse.ok && entityRpcBody.p_profile_id) {
      const status = entityResponse.status;
      if (status === 404 || status === 400) {
        console.warn('⚠️ search_entities_by_embedding missing p_profile_id — retrying without (migration pending)');
        _profileCompat.rpcUnavailable = true;
        delete entityRpcBody.p_profile_id;
        entityResponse = await fetchWithTimeout(
          `${config.supabaseUrl}/rest/v1/rpc/search_entities_by_embedding`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'apikey': config.supabaseKey,
              'Authorization': `Bearer ${config.supabaseKey}`
            },
            body: JSON.stringify(entityRpcBody)
          },
          5000
        );
      }
    }

    if (!entityResponse.ok) {
      console.warn(`   ⚠️ Entity search failed: ${entityResponse.status}`);
      return [];
    }

    let entities = await entityResponse.json();

    // Fallback: text-based entity search if embedding search returned 0
    if (!entities || entities.length === 0) {
      console.log(`   🔗 Entity embedding search: 0 results, trying text fallback...`);
      try {
        // Expand query with concept synonyms before text search
        let expandedQuery = query;
        const queryWords = query.toLowerCase().split(/\s+/);
        const expansions = [];
        for (const word of queryWords) {
          const synonyms = ENTITY_CONCEPT_SYNONYMS.get(word);
          if (synonyms) {
            expansions.push(...synonyms);
          }
        }
        if (expansions.length > 0) {
          expandedQuery = query + ' ' + expansions.join(' ');
          console.log(`   🔗 Entity concept expansion: "${query}" → "${expandedQuery}"`);
        }

        const textRpcBody = {
          p_query_text: expandedQuery,
          p_user_id: userId,
          p_match_count: 5,
        };
        if (!_profileCompat.rpcUnavailable && graphProfileId) {
          textRpcBody.p_profile_id = graphProfileId;
        }

        let textResponse = await fetchWithTimeout(
          `${config.supabaseUrl}/rest/v1/rpc/search_entities_by_text`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'apikey': config.supabaseKey,
              'Authorization': `Bearer ${config.supabaseKey}`
            },
            body: JSON.stringify(textRpcBody)
          },
          5000
        );

        // Retry without p_profile_id if signature mismatch
        if (!textResponse.ok && textRpcBody.p_profile_id && (textResponse.status === 404 || textResponse.status === 400)) {
          console.warn('⚠️ search_entities_by_text missing p_profile_id — retrying without');
          _profileCompat.rpcUnavailable = true;
          delete textRpcBody.p_profile_id;
          textResponse = await fetchWithTimeout(
            `${config.supabaseUrl}/rest/v1/rpc/search_entities_by_text`,
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'apikey': config.supabaseKey,
                'Authorization': `Bearer ${config.supabaseKey}`
              },
              body: JSON.stringify(textRpcBody)
            },
            5000
          );
        }

        if (textResponse.ok) {
          entities = await textResponse.json();
          if (entities && entities.length > 0) {
            console.log(`   🔗 Entity text fallback: found ${entities.length} entities`);
          }
        }
      } catch (textErr) {
        console.warn(`   ⚠️ Entity text search failed: ${textErr.message}`);
      }
    }

    if (!entities || entities.length === 0) {
      return [];
    }

    const entityIds = entities.map(e => e.id);
    console.log(`   🔗 Graph walk: found ${entityIds.length} matching entities`);

    // Step 2: Walk the graph from these entities
    const graphRpcBody = {
      p_entity_ids: entityIds,
      p_user_id: userId,
      p_max_results: limit,
      p_max_depth: 2,
      p_max_intermediate: 20,
    };
    if (!_profileCompat.rpcUnavailable && graphProfileId) {
      graphRpcBody.p_profile_id = graphProfileId;
    }

    let graphResponse = await fetchWithTimeout(
      `${config.supabaseUrl}/rest/v1/rpc/graph_walk_from_entities`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': config.supabaseKey,
          'Authorization': `Bearer ${config.supabaseKey}`
        },
        body: JSON.stringify(graphRpcBody)
      },
      5000
    );

    // Retry without p_profile_id if signature mismatch
    if (!graphResponse.ok && graphRpcBody.p_profile_id && (graphResponse.status === 404 || graphResponse.status === 400)) {
      console.warn('⚠️ graph_walk_from_entities missing p_profile_id — retrying without');
      _profileCompat.rpcUnavailable = true;
      delete graphRpcBody.p_profile_id;
      graphResponse = await fetchWithTimeout(
        `${config.supabaseUrl}/rest/v1/rpc/graph_walk_from_entities`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'apikey': config.supabaseKey,
            'Authorization': `Bearer ${config.supabaseKey}`
          },
          body: JSON.stringify(graphRpcBody)
        },
        5000
      );
    }

    if (!graphResponse.ok) {
      console.warn(`   ⚠️ Graph walk RPC failed: ${graphResponse.status}`);
      return [];
    }

    const graphData = await graphResponse.json();
    if (!graphData || graphData.length === 0) {
      return [];
    }

    // Apply maxTimestamp filter and map to searchHybrid format
    const results = graphData
      .filter(item => {
        if (maxTimestamp > 0) {
          return (item.start_timestamp || 0) <= maxTimestamp;
        }
        return true;
      })
      .map(item => ({
        message_id: item.chat_turn_id,
        id: item.chat_turn_id,
        content: item.content,
        conversation_id: item.conversation_id,
        source: item.platform,
        timestamp: item.start_timestamp,
        graph_score: item.relationship_strength,
        traversal_depth: item.traversal_depth,
        connected_entity: item.connected_entity_text
      }));

    console.log(`   ✅ Graph walk: ${results.length} results (from ${graphData.length} raw)`);
    return results;

  } catch (error) {
    console.warn(`   ⚠️ Graph walk failed: ${error.message}`);
    return [];
  }
}

/**
 * Phase 3: Reciprocal Rank Fusion (RRF) for merging ranked lists
 * 
 * Combines multiple ranked lists into a single ranking
 * RRF score = Σ 1 / (k + rank_i) for each list i
 * 
 * @param {Array} rankedLists - Array of ranked result arrays
 * @param {number} k - Constant for RRF (default: 60, per original paper)
 * @returns {Array} Merged and deduplicated results with RRF scores
 */
function mergeResultsRRF(rankedLists, k = 60) {
  const rrfScores = new Map(); // message_id → RRF score
  const messageData = new Map(); // message_id → full message object

  // Calculate RRF scores for each list
  rankedLists.forEach(list => {
    list.forEach((item, rank) => {
      const id = item.message_id || item.id;
      const currentScore = rrfScores.get(id) || 0;

      // RRF formula: 1 / (k + rank)
      // rank is 0-based, so we add 1
      const rrfContribution = 1 / (k + rank + 1);

      rrfScores.set(id, currentScore + rrfContribution);

      // Store full message data (first occurrence)
      if (!messageData.has(id)) {
        messageData.set(id, item);
      }
    });
  });

  // Convert to array and sort by RRF score
  const mergedResults = Array.from(rrfScores.entries())
    .map(([id, rrfScore]) => ({
      ...messageData.get(id),
      rrf_score: rrfScore
    }))
    .sort((a, b) => b.rrf_score - a.rrf_score);

  return mergedResults;
}

/**
 * Phase 3: Hybrid Search with Adaptive Weighting
 * 
 * Combines BM25 keyword search with semantic vector search
 * Uses adaptive weighting based on query length:
 * - Short queries (<5 words): BM25 weight 0.7, Semantic weight 0.3
 * - Long queries (≥5 words): BM25 weight 0.4, Semantic weight 0.6
 * 
 * Results are merged using Reciprocal Rank Fusion (RRF)
 * 
 * @param {string} query - Natural language search query
 * @param {Object} options - Search options
 * @param {number} options.limit - Max results to return (default: 5)
 * @param {number} options.bm25Threshold - Min BM25 score (default: 0.1)
 * @param {number} options.semanticThreshold - Min semantic similarity (default: 0.5)
 * @param {boolean} options.enableBM25 - Enable BM25 search (default: true)
 * @param {boolean} options.enableSemantic - Enable semantic search (default: true)
 * @param {string} options.role - Filter by role
 * @param {string} options.source - Filter by source
 * @returns {Promise<Object[]>} Hybrid-ranked results
 */
export async function searchHybrid(query, options = {}) {
  const {
    limit = 5,
    bm25Threshold = 0.1,
    semanticThreshold = 0.5,
    enableBM25 = true,
    enableSemantic = true,
    enableHyDE = false,       // Off by default until tested
    enableGraph = false,      // Off by default until entities are populated
    role = null,
    source = null,
    maxTimestamp = 0
  } = options;

  console.log(`\n🔍 Phase 3 Hybrid Search: "${query}"`);

  // Determine adaptive weights based on query length
  const weights = getAdaptiveWeights(query);
  console.log(`   Strategy: ${weights.strategy}`);
  console.log(`   Query length: ${weights.queryLength} words`);
  console.log(`   Weights: BM25=${weights.bm25Weight}, Semantic=${weights.semanticWeight}`);

  try {
    // Get local messages for BM25 search
    const storageResult = await chrome.storage.local.get(['captured_messages']);
    let localMessages = storageResult.captured_messages || [];

    // Apply filters to local messages
    if (role) {
      localMessages = localMessages.filter(m => m.role === role);
    }
    if (source) {
      localMessages = localMessages.filter(m => m.source === source);
    }
    // maxTimestamp: keep only messages OLDER than the cutoff (exclude recent to prevent context pollution)
    if (maxTimestamp > 0) {
      localMessages = localMessages.filter(m => (m.timestamp || m.capturedAt || 0) <= maxTimestamp);
    }
    // P1 fix: exclude questions from local BM25 search
    // For messages captured before Phase 2 (no is_question field), apply runtime heuristic
    const INTERROGATIVE_RE = /^(what|who|where|when|why|how|which|is|are|was|were|do|does|did|can|could|would|will|shall|should|have|has|had|tell me|remind me|do you know|do you remember)\b/i;
    localMessages = localMessages.filter(m => {
      if (m.is_question) return false;
      // Runtime heuristic for old messages without is_question field
      if (m.role === 'user' && m.is_question === undefined) {
        const trimmed = (m.content || '').trim();
        if (trimmed.endsWith('?') || INTERROGATIVE_RE.test(trimmed)) return false;
      }
      return true;
    });

      const rankedLists = [];

      // Start HyDE generation → embedding → search as a single compound promise
      // that runs concurrently with all other searches (not sequentially after them).
      // Budget: 12s total for the entire HyDE chain (doc gen + embedding + Supabase RPC).
      const HYDE_CHAIN_TIMEOUT_MS = 12000;
      let hydeChainPromise = null;
      if (enableHyDE) {
        const cbStatus = await hydeCB.isOpen();
        if (!cbStatus.open) {
          console.log(`   🔮 Starting HyDE chain in parallel (gen → embed → search, ${HYDE_CHAIN_TIMEOUT_MS / 1000}s budget)...`);
          hydeChainPromise = Promise.race([
            (async () => {
              const hydeDoc = await generateHyDEDocument(query);
              if (!hydeDoc) return [];
              console.log(`   🔮 HyDE document ready, running semantic search with it...`);
              const hydeResults = await searchMessages(hydeDoc, {
                limit: limit * 2,
                threshold: semanticThreshold,
                skipTransformation: true,
                minTimestamp: 0
              });
              // Apply maxTimestamp filter client-side
              return hydeResults
                .filter(r => {
                  if (maxTimestamp > 0) {
                    return (r.msg_timestamp || r.timestamp || 0) <= maxTimestamp;
                  }
                  return true;
                })
                .map(r => ({ ...r, message_id: r.message_id || r.id }));
            })(),
            new Promise(resolve =>
              setTimeout(() => {
                console.warn(`   ⚠️ HyDE chain timed out (${HYDE_CHAIN_TIMEOUT_MS / 1000}s budget)`);
                resolve([]);
              }, HYDE_CHAIN_TIMEOUT_MS)
            )
          ]).catch(err => {
            console.warn(`   ⚠️ HyDE chain failed: ${err.message}`);
            return [];
          });
        } else {
          console.log(`   ⚡ HyDE circuit breaker open, skipping`);
        }
      }

      // Run BM25 keyword search (local, fast)
      if (enableBM25 && localMessages.length > 0) {
        console.log(`   🔤 Running BM25 keyword search...`);

        // PHASE 5: Query Expansion
        const expansion = queryExpander.expand(query);
        console.log(`   🔄 Query Expansion: ${expansion.variants.length} variants applied (${expansion.expansionsApplied.join(', ') || 'none'})`);
        if (expansion.variants.length > 1) {
          console.log(`      Variants: ${expansion.variants.join(' | ')}`);
        }

        const bm25ResultsMap = new Map(); // message_id -> result

        // Run BM25 on all variants
        for (const variant of expansion.variants) {
          const results = searchBM25(variant, localMessages, {
            limit: limit * 2, // Fetch more for better RRF
            threshold: bm25Threshold
          });

          // Merge results (keep highest score)
          for (const result of results) {
            const id = result.message_id || result.id;
            const existing = bm25ResultsMap.get(id);
            if (!existing || result.score > existing.score) {
              bm25ResultsMap.set(id, result);
            }
          }
        }

        const bm25Results = Array.from(bm25ResultsMap.values())
          .sort((a, b) => b.score - a.score)
          .slice(0, limit * 2);

        console.log(`   ✅ BM25: ${bm25Results.length} results (merged from ${expansion.variants.length} variants)`);
        if (bm25Results.length > 0) {
          rankedLists.push(bm25Results);
        }
      }

      // Run Supabase text search + semantic vector search in parallel
      // (independent remote calls — parallelizing saves ~2-3s vs sequential)
      if (enableBM25) console.log(`   🔤 Running Supabase text search (cross-platform recall)...`);
      if (enableSemantic) console.log(`   🧠 Running semantic vector search...`);

      let semanticAvailable = false;
      if (enableGraph) console.log(`   🔗 Running graph walk (entity traversal)...`);

      const [supabaseTextResults, semanticResults, graphWalkResults, chatTurnsTextResults, hydeResults] = await Promise.all([
        enableBM25
          ? searchSupabaseText(query, { limit: limit * 2, role, source, maxTimestamp })
              .catch(err => { console.warn('Supabase text search failed:', err.message); return []; })
          : Promise.resolve([]),
        enableSemantic
          ? searchMessages(query, {
              limit: limit * 2,
              threshold: semanticThreshold,
              role,
              source,
              skipTransformation: true, // Phase 1 fix: no transformation for hybrid
              minTimestamp: 0 // Disable server-side temporal filter; we filter client-side with maxTimestamp
            }).catch(err => { console.warn('Semantic search failed:', err.message); return []; })
          : Promise.resolve([]),
        enableGraph
          ? searchGraphWalk(query, { limit: limit * 2, maxTimestamp })
              .catch(err => { console.warn('Graph walk failed:', err.message); return []; })
          : Promise.resolve([]),
        // chat_turns text search: catches Gemini/other platform content with null embeddings
        enableBM25
          ? searchSupabaseChatTurnsText(query, { limit: limit * 2, maxTimestamp })
              .catch(err => { console.warn('chat_turns text search failed:', err.message); return []; })
          : Promise.resolve([]),
        // HyDE compound chain: doc gen → embedding → search (runs concurrently, 12s budget)
        hydeChainPromise || Promise.resolve([])
      ]);

      // Per-strategy diagnostic counts
      console.log(`📊 Search counts: BM25=${enableBM25 ? (rankedLists.length > 0 ? rankedLists[0].length : 0) : 'disabled'}, supabaseText=${supabaseTextResults.length}, chatTurnsText=${chatTurnsTextResults.length}, semantic=${semanticResults.length}, graph=${graphWalkResults?.length || 0}, hyde=${hydeResults?.length || 0}`);

      // Process Supabase text results (messages table)
      if (supabaseTextResults.length > 0) {
        console.log(`   ✅ Supabase text search: ${supabaseTextResults.length} results`);
        rankedLists.push(supabaseTextResults);
      }

      // Process chat_turns text results (catches null-embedding rows from Gemini etc.)
      if (chatTurnsTextResults.length > 0) {
        console.log(`   ✅ chat_turns text search: ${chatTurnsTextResults.length} results`);
        rankedLists.push(chatTurnsTextResults);
      }

      // Process semantic results
      console.log(`   ✅ Semantic: ${semanticResults.length} results`);
      if (semanticResults.length > 0) {
        semanticAvailable = true;
      }

      // Normalize semantic results to have message_id
      // Apply client-side maxTimestamp filter (exclude recent messages)
      const normalizedSemanticResults = semanticResults
        .filter(r => {
          if (maxTimestamp > 0) {
            const ts = r.msg_timestamp || r.timestamp || 0;
            return ts <= maxTimestamp;
          }
          return true;
        })
        .map(r => ({
          ...r,
          message_id: r.message_id || r.id
        }));

      if (normalizedSemanticResults.length > 0) {
        rankedLists.push(normalizedSemanticResults);
      }

      // Add HyDE results (already resolved from Promise.all)
      if (hydeResults && hydeResults.length > 0) {
        console.log(`   ✅ HyDE search: ${hydeResults.length} results`);
        rankedLists.push(hydeResults);
      }

      // Add graph walk results if available
      if (graphWalkResults && graphWalkResults.length > 0) {
        console.log(`   ✅ Graph walk: ${graphWalkResults.length} results`);
        rankedLists.push(graphWalkResults);
      }

      // Merge results using RRF
      if (rankedLists.length === 0) {
        console.log(`   ⚠️  No search methods enabled`);
        return [];
      }

      console.log(`   🔀 Merging ${rankedLists.length} ranked lists with RRF...`);
      let mergedResults = mergeResultsRRF(rankedLists);

      // Apply adaptive weighting to RRF scores
      // Boost scores based on which method contributed more
      mergedResults = mergedResults.map(item => {
        let weightedScore = item.rrf_score;

        // Boost if found by BM25 (keyword match)
        if (item.bm25_score !== undefined) {
          weightedScore *= (1 + weights.bm25Weight);
        }

        // Boost if found by semantic search
        if (item.distance !== undefined) {
          weightedScore *= (1 + weights.semanticWeight);
        }

        // Boost graph walk items (entity traversal / entity timeline guarantee).
        // These carry graph_score (legacy path) or entity_boost (edge path) but
        // lack bm25_score and distance, so they get 0% boost otherwise.
        // Guard: only boost if item doesn't already have distance (avoid double-boost).
        if ((item.entity_boost === true || item.graph_score !== undefined) && item.distance === undefined) {
          weightedScore *= (1 + weights.semanticWeight);
        }

        return {
          ...item,
          weighted_score: weightedScore,
          hybrid_strategy: weights.strategy
        };
      });

      // Re-sort by weighted score and limit
      mergedResults.sort((a, b) => b.weighted_score - a.weighted_score);

      // CRITICAL: Enforce minimum quality threshold on final results
      // Drop items that don't meet the semantic threshold (based on distance/similarity)
      // This prevents low-confidence garbage from polluting results
      mergedResults = mergedResults.filter(item => {
        // If item has distance (semantic search result), check threshold
        if (item.distance !== undefined) {
          const similarity = 1 - item.distance; // Convert distance to similarity
          if (similarity < semanticThreshold) {
            console.log(`   ⏭️  Dropped low-confidence item (similarity: ${similarity.toFixed(3)} < threshold: ${semanticThreshold})`);
            return false;
          }
        }
        return true;
      });

      mergedResults = mergedResults.slice(0, limit);

      // PHASE 8: Apply Jina cross-encoder reranker for final ranking
      // (Replaced broken BGE reranker - HuggingFace doesn't support serverless reranking)
      const rerankedResults = await rerankResults(query, mergedResults);

      console.log(`   ✅ Hybrid search complete: ${rerankedResults.length} final results (semanticAvailable: ${semanticAvailable})`);
      console.log(`   📊 Top result score: ${rerankedResults[0]?.rerank_score?.toFixed(4) || rerankedResults[0]?.weighted_score?.toFixed(4) || 'N/A'}\n`);

      // Attach metadata so callers can adapt (e.g., lower confidence threshold in BM25-only mode)
      const jinaReranked = rerankedResults.length > 0 && rerankedResults[0]?.jinaReranked === true;
      rerankedResults.metadata = { semanticAvailable, jinaReranked };

      return rerankedResults;

    } catch (error) {
      console.error('❌ Hybrid search failed:', error);

      // Fallback to semantic-only search (no temporal filter — RPC min_timestamp=0 disables it)
      console.warn('⚠️  Falling back to semantic-only search');
      return await searchMessages(query, {
        limit,
        threshold: semanticThreshold,
        role,
        source,
        minTimestamp: 0
      });
    }
  }

/**
 * Rerank results using Jina Reranker API
 *
 * Features:
 * - Circuit breaker (jinaCB) — skips instantly when Jina is consistently slow/down
 * - Dedicated 15 s timeout (cross-encoders are slower than single-vector embeddings)
 * - Single retry on timeout (cold-start recovery)
 * - Batch capped at MAX_RERANK_DOCS (matches top_n)
 * - Latency diagnostics via performance.now()
 *
 * @param {string} query - User's search query
 * @param {Array} results - Results from RRF fusion
 * @returns {Promise<Array>} - Reranked results with cross_encoder_score
 */
async function rerankResults(query, results) {
  if (results.length === 0) return results;

  // Fallback helper — attaches a normalized cross_encoder_score so callers
  // (confidence filter in background.js) still have a usable field.
  // Min-max normalizes weighted_score to 0-1 range and marks as NOT Jina-reranked
  // so callers can use an appropriate confidence threshold.
  const fallback = () => {
    const scores = results.map(r => r.weighted_score || 0);
    const maxScore = Math.max(...scores, 0.001);
    return results.map(r => ({
      ...r,
      cross_encoder_score: (r.weighted_score || 0) / maxScore,
      jinaReranked: false
    }));
  };

  // ── Circuit breaker gate ──────────────────────────────────────────────
  const cbStatus = await jinaCB.isOpen();
  if (cbStatus.open) {
    console.warn(`   ⚡ Jina circuit breaker open, skipping reranking: ${cbStatus.reason}`);
    return fallback();
  }

  const config = await getConfig();
  const JINA_API_KEY = config.jinaKey;

  if (!JINA_API_KEY) {
    console.warn('   ⚠️  Jina API key not configured, skipping reranking');
    return fallback();
  }

  // Prepare documents (cap at MAX_RERANK_DOCS — no point sending more than top_n)
  // Prefer contextual_content (enriched with context summaries) — matches edge function behavior.
  // Falls back to raw content for items without contextual_content.
  const documents = results.slice(0, MAX_RERANK_DOCS).map(r => r.contextual_content || r.content || '');
  const topN = documents.length;

  // DEBUG: Log what we're sending to Jina (first 3 docs, truncated)
  console.log(`   📋 Jina input: query="${query.substring(0, 80)}..." docs=[`);
  documents.slice(0, 3).forEach((d, i) => {
    const preview = (d || '(empty)').substring(0, 120).replace(/\n/g, '\\n');
    console.log(`      [${i}] (${d.length} chars) "${preview}..."`);
  });

  // ── Retry loop (timeout-only retry for cold-start recovery) ───────────
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_JINA_ATTEMPTS; attempt++) {
    const t0 = performance.now();
    try {
      console.log(`   🎯 Jina Reranker attempt ${attempt}/${MAX_JINA_ATTEMPTS} (${topN} docs, ${JINA_TIMEOUT_MS}ms timeout)...`);

      const response = await fetchWithTimeout(
        'https://api.jina.ai/v1/rerank',
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${JINA_API_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model: 'jina-reranker-v2-base-multilingual',
            query: query,
            documents: documents,
            top_n: topN
          })
        },
        JINA_TIMEOUT_MS
      );

      const latencyMs = (performance.now() - t0).toFixed(0);

      // ── HTTP error handling (no retry for non-timeout errors) ─────────
      if (!response.ok) {
        const errorText = await response.text();
        console.error(`   ⚠️  Jina API error: ${response.status} - ${errorText} (${latencyMs}ms)`);
        await jinaCB.recordFailure(response.status, errorText);
        return fallback(); // Don't retry HTTP errors
      }

      // ── Success ───────────────────────────────────────────────────────
      const data = await response.json();

      const scoreMap = new Map();
      if (data.results && Array.isArray(data.results)) {
        for (const item of data.results) {
          scoreMap.set(item.index, item.relevance_score);
        }
        // DEBUG: Log raw Jina scores
        const topScores = data.results.slice(0, 5).map(r => `[${r.index}]=${r.relevance_score?.toFixed(4)}`);
        console.log(`   📊 Jina raw scores (top 5): ${topScores.join(', ')}`);
      }

      const reranked = results.map((result, idx) => {
        const jinaScore = scoreMap.get(idx);
        return {
          ...result,
          cross_encoder_score: jinaScore !== undefined ? jinaScore : null,
          rerank_score: jinaScore !== undefined ? jinaScore : null,
          jinaReranked: jinaScore !== undefined
        };
      });

      // Scale non-Jina items BELOW the Jina score range.
      // Items beyond MAX_RERANK_DOCS weren't sent to Jina — they must always
      // rank below Jina-scored items (Jina is the authority on relevance).
      // Previous bug: Math.max(jinaMin * 0.8, 0.10) floored at 0.10, which
      // pushed unscored items ABOVE Jina-scored items when all Jina scores < 0.10.
      const jinaScored = reranked.filter(r => r.jinaReranked);
      const unscored = reranked.filter(r => !r.jinaReranked);
      if (jinaScored.length > 0 && unscored.length > 0) {
        const jinaMin = Math.min(...jinaScored.map(r => r.cross_encoder_score));
        const wScores = unscored.map(r => r.weighted_score || 0);
        const wMax = Math.max(...wScores, 0.001);
        for (const r of unscored) {
          // Scale to 80% of Jina's minimum — always below Jina-scored items.
          // No floor: if Jina says everything is 0.04, unscored gets 0.032 max.
          const scaled = ((r.weighted_score || 0) / wMax) * (jinaMin * 0.8);
          r.cross_encoder_score = scaled;
          r.rerank_score = scaled;
        }
      } else if (unscored.length > 0) {
        // No Jina scores at all — preserve weighted_score as-is
        for (const r of unscored) {
          r.cross_encoder_score = r.weighted_score || 0;
          r.rerank_score = r.weighted_score || 0;
        }
      }

      reranked.sort((a, b) => b.cross_encoder_score - a.cross_encoder_score);

      const topScore = reranked[0]?.cross_encoder_score?.toFixed(3) || 'N/A';
      console.log(`   ✅ Jina reranked ${reranked.length} results in ${latencyMs}ms (top score: ${topScore})`);

      await jinaCB.recordSuccess();
      return reranked;

    } catch (error) {
      const latencyMs = (performance.now() - t0).toFixed(0);
      lastError = error;

      const isTimeout = error.message.includes('timed out');
      console.warn(`   ⚠️  Jina attempt ${attempt} failed in ${latencyMs}ms: ${error.message}`);

      if (isTimeout && attempt < MAX_JINA_ATTEMPTS) {
        // Retry once on timeout (cold-start recovery)
        console.log(`   🔄 Retrying Jina (cold-start recovery)...`);
        continue;
      }

      // Record failure: use status 0 for timeouts (no HTTP status available)
      await jinaCB.recordFailure(isTimeout ? 0 : 0, error.message);
      break;
    }
  }

  console.error(`   ⚠️  Jina reranking failed after ${MAX_JINA_ATTEMPTS} attempts: ${lastError?.message}`);
  return fallback();
}
