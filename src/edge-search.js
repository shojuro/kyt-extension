/**
 * Search memories via search_memories edge function.
 *
 * For authenticated users, this replaces the client-side HuggingFace embedding,
 * Supabase RPC match_messages_v2, BM25, and Jina reranking calls in
 * browser-search.js.  The edge function runs the full pipeline server-side:
 *   HyDE -> dual embedding -> dual vector search -> RRF -> Jina rerank ->
 *   entity boost -> confidence filter -> top-K
 */

import { callEdgeFunction } from './api-client.js';

/**
 * Search memories via the search_memories edge function.
 *
 * @param {string} query - User's search query
 * @param {Object} [options]
 * @param {number} [options.topK=5] - Number of results to return
 * @param {boolean} [options.useHyde=true] - Enable HyDE query expansion
 * @param {number} [options.hydeWeight=0.6] - HyDE weight in RRF merge
 * @param {number} [options.timeoutMs=30000] - Request timeout
 * @returns {Promise<Array>} Array of search result objects
 */
export async function searchViaEdgeFunction(query, options = {}) {
  const {
    topK = 5,
    useHyde = true,
    hydeWeight = 0.6,
    timeoutMs = 30000,
    recentByPlatform = null,
    fast = false,
    confidenceThreshold = undefined,
    mmrLambda = undefined,
    recentTopics = undefined,
    conversationWindow = undefined,
  } = options;

  if (!query || query.trim().length === 0) {
    return [];
  }

  // Get userId from auth session
  const result = await chrome.storage.local.get(['auth_session']);
  const session = result.auth_session;
  const userId = session?.user?.id;

  if (!userId) {
    throw new Error('No authenticated user for edge search');
  }

  const body = {
    query,
    userId,
    profileId: userId,  // MVP: profile_id = user_id
    useHyde,
    hydeWeight,
    topK,
    fast,
  };
  if (recentByPlatform) body.recentByPlatform = recentByPlatform;
  if (confidenceThreshold != null) body.confidenceThreshold = confidenceThreshold;
  if (mmrLambda != null) body.mmrLambda = mmrLambda;
  if (recentTopics && recentTopics.length > 0) body.recentTopics = recentTopics;
  if (conversationWindow && conversationWindow.length > 0) body.conversationWindow = conversationWindow;

  const response = await callEdgeFunction(
    'search_memories',
    body,
    { timeoutMs },
  );

  if (!response.success) {
    throw new Error(response.error || 'Search edge function failed');
  }

  // The edge function returns results with content, similarity scores, etc.
  // Map to the format expected by getContextForInjection
  const mapped = (response.results || []).map((item) => ({
    id: item.id,
    message_id: item.message_id || item.id,
    content: item.content,
    platform: item.platform,
    source: item.source || item.platform,
    msg_timestamp: item.created_at || item.timestamp || item.start_timestamp,
    timestamp: item.created_at || item.timestamp || item.start_timestamp,
    // Scores — edge function provides cross_encoder_score from BGE reranker (server) or Jina (browser fallback)
    cross_encoder_score: item.cross_encoder_score ?? item.rerank_score ?? null,
    distance: item.distance ?? null,
    weighted_score: item.weighted_score ?? item.rrf_score ?? null,
    rrf_score: item.rrf_score ?? null,
    role: item.role || item.speakers?.[0] || 'unknown',
    jinaReranked: item.cross_encoder_score != null,
    // Graph walk metadata — entity boost, traversal depth, connected entity text
    entity_boost: item.entity_boost ?? false,
    traversal_depth: item.traversal_depth ?? null,
    connected_entity_text: item.connected_entity_text ?? null,
    // Server-side entity data — canonical names from GPT-4o-mini extraction
    // Used by client-side applyRecencyResolution instead of fragile regex
    entities: item.entities || [],
    // Preference query router match flag
    preference_match: item.preference_match ?? false,
    // Contextual retrieval: LLM-generated context prefix + raw content
    // Used by client-side BM25 for richer keyword matching
    contextual_content: item.contextual_content || null,
  }));

  // Attach metadata so callers can determine Jina availability
  mapped.metadata = {
    semanticAvailable: true,
    jinaReranked: mapped.some(r => r.jinaReranked),
  };

  return mapped;
}
