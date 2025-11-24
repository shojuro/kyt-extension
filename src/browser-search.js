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

// Initialize expander
const queryExpander = new QueryExpander();

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
        config.openaiKey
      );

      if (transformResult.success && transformResult.transformed) {
        searchQuery = transformResult.optimizedQuery;
        console.log(`🔄 Query transformed: "${query}" → "${searchQuery}"`);
      } else {
        console.log(`📊 Using original query (transformation ${transformResult.transformed ? 'succeeded' : 'failed'})`);
      }
    }

    // Generate query embedding (using transformed or original query)
    let queryEmbedding;
    try {
      queryEmbedding = await generateQueryEmbedding(searchQuery, config.openaiKey);
    } catch (embeddingError) {
      console.error('❌ Failed to generate query embedding:', embeddingError);
      throw new Error(`Embedding generation failed: ${embeddingError.message}. Check your OpenAI API key and network connection.`);
    }

    // Call Supabase RPC function
    // Prepare server-side filters
    const filter = {};
    if (role) filter.role = role;
    if (source) filter.source = source;

    // Add user_id to filter
    if (config.userId) {
      filter.user_id = config.userId;
    }

    // Calculate min_timestamp if exclude_recent_seconds is provided
    // Note: exclude_recent_seconds is usually handled by caller (background.js) but we can support it here
    let minTimestamp = 0;
    if (options.minTimestamp) {
      minTimestamp = options.minTimestamp;
    }

    const rpcBody = {
      query_embedding: queryEmbedding,
      match_threshold: config.matchThreshold || 0.6, // Calibrated optimal threshold
      match_count: limit,
      filter: filter,
      min_timestamp: minTimestamp
    };

    let url = `${config.supabaseUrl}/rest/v1/rpc/match_messages_v2`;

    // Build query
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': config.supabaseKey,
        'Authorization': `Bearer ${config.supabaseKey}`
      },
      body: JSON.stringify(rpcBody)
    });

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
      `${config.supabaseUrl}/rest/v1/messages?message_id=eq.${messageId}&user_id=eq.${config.userId || '00000000-0000-0000-0000-000000000000'}&select=embedding,content`,
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
          }
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
    role = null,
    source = null,
    minTimestamp = 0
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
    if (minTimestamp > 0) {
      localMessages = localMessages.filter(m => (m.timestamp || m.capturedAt || 0) >= minTimestamp);
    }

      const rankedLists = [];



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
        rankedLists.push(bm25Results);
      }

      // Run semantic vector search (Supabase, slower but powerful)
      if (enableSemantic) {
        console.log(`   🧠 Running semantic vector search...`);
        const semanticResults = await searchMessages(query, {
          limit: limit * 2,
          threshold: semanticThreshold,
          role,
          source,
          skipTransformation: true, // Phase 1 fix: no transformation for hybrid
          minTimestamp
        });
        console.log(`   ✅ Semantic: ${semanticResults.length} results`);

        // Normalize semantic results to have message_id
        const normalizedSemanticResults = semanticResults.map(r => ({
          ...r,
          message_id: r.message_id || r.id
        }));

        rankedLists.push(normalizedSemanticResults);
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

      console.log(`   ✅ Hybrid search complete: ${mergedResults.length} final results`);
      console.log(`   📊 Top result score: ${mergedResults[0]?.weighted_score.toFixed(4) || 'N/A'}\n`);

      return mergedResults;

    } catch (error) {
      console.error('❌ Hybrid search failed:', error);

      // Fallback to semantic-only search
      console.warn('⚠️  Falling back to semantic-only search');
      return await searchMessages(query, {
        limit,
        threshold: semanticThreshold,
        role,
        source,
        minTimestamp
      });
    }
  }
