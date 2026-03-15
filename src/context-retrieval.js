/**
 * Context Retrieval Module
 * Extracted from background.js — the full getContextForInjection() pipeline.
 *
 * Owns: preference router, search dispatch, confidence filter, injection building.
 * Quality penalties, MMR, keyword boost, echo/meta/deflection filters are now
 * handled server-side (quality-penalties.ts + mmr.ts in the unified pipeline).
 *
 * IMPORTANT (MV3): All imports must be static. No dynamic import().
 */

import { searchHybrid } from './browser-search.js';
import { transformQuery, fetchRecentTopicsFromSupabase } from './query-transformer.js';
import { buildMemoryInjection, buildErrorInjection } from '../kyt-memory-injection-builder.js';
import { filterByConfidence } from './confidence-filter.js';
import { searchViaEdgeFunction } from './edge-search.js';
import { scoreTemporalReference, scoreSynthesisIntent } from './intent-classifier.js';
import { hydeCB } from './hyde-search-generator.js';
import { isEmbeddingCircuitOpen } from './embedding-circuit-breaker.js';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './supabase-config.js';
import { getApiConfig, getRoutingMode } from './auth-config.js';
import { AUTH_SESSION_KEY } from './auth/auth-service.js';
import { getActiveProfileId } from './profile-manager.js';
import { getActiveProject } from './project-manager.js';
import { getRecentTopics } from './recent-topic-cache.js';

/**
 * Extract which platform is mentioned in a query (null if none or cross-platform).
 * Normalizes claude-code to claude-code, all others to lowercase.
 * @param {string} message
 * @returns {string|null}
 */
export function extractPlatformMention(message) {
  const m = message.match(/\b(gemini|chatgpt|claude[- ]code|claude)\b/i);
  if (!m) return null;
  const raw = m[1].toLowerCase().replace(/\s+/g, '-');
  return raw; // 'gemini', 'chatgpt', 'claude-code', 'claude'
}

// ===== DEFENSIVE TIMEOUT HELPER =====
// Races a promise against a timeout. On timeout, resolves with undefined
// instead of rejecting — callers treat undefined as "stage skipped".
export function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise(resolve => setTimeout(() => {
      console.warn(`⏱️ ${label} exceeded ${ms}ms, skipping`);
      resolve(undefined);
    }, ms))
  ]);
}

// ===== INJECTION PREFIX STRIPPING =====
// Strip KYT injection blocks that get captured with user messages.
// The content script captures messages AFTER the injection block is prepended,
// so both messages and chat_turns tables get polluted with the full injection context.
export function stripInjectionPrefix(content) {
  if (!content) return { content, hadInjection: false };
  const separator = '\n---\n\n';
  const sepIdx = content.lastIndexOf(separator);
  if (sepIdx === -1) return { content, hadInjection: false };
  const prefix = content.substring(0, sepIdx);
  if (prefix.includes('K.Y.T.') || prefix.includes('[RETRIEVAL_CONTEXT]') ||
      prefix.includes('[SESSION_CONTEXT]') || prefix.includes('[DATA_PROVENANCE]')) {
    return { content: content.substring(sepIdx + separator.length).trim(), hadInjection: true };
  }
  return { content, hadInjection: false };
}

// ===== QUESTION DETECTION =====
// Heuristic: identifies user messages that are questions (P1 fix).
// Questions are tagged is_question=true and excluded from retrieval.
// Expanded: imperative request patterns (list/show/find/etc.) + short-content heuristic
// Keep in sync with save_chat_turn_batch/index.ts INTERROGATIVE_RE
export const INTERROGATIVE_RE = /^(what|who|where|when|why|how|which|is|are|was|were|do|does|did|can|could|would|will|shall|should|have|has|had|tell me|remind me|do you know|do you remember|list|name|give|show|find|get|provide|suggest|recommend|describe|explain|identify|compare|summarize|rank|top (?:\d+|one|two|three|four|five|six|seven|eight|nine|ten))\b/i;

export function detectIsQuestion(content, role) {
  if (role !== 'user') return false;
  const trimmed = (content || '').trim();
  if (trimmed.endsWith('?')) return true;
  if (INTERROGATIVE_RE.test(trimmed)) return true;
  // Short user prompts without assertions are likely requests/questions
  if (trimmed.length < 60 && !trimmed.includes('.') && !trimmed.includes('!')) return true;
  return false;
}

// ==========================================================================
// STEP 0: Client-side Preference Router
// Regex classifier that detects preference queries and short-circuits the
// vector pipeline. 0ms cost — runs before any embedding generation.
// Ported from supabase/functions/_shared/get_relevant_memories.ts
// ==========================================================================

/**
 * Detect if a query is asking about user preferences.
 * Returns the extracted category string (e.g. "car", "food") or null.
 *
 * Patterns:
 *   1. "what is/are/was my favorite/preferred/go-to X"
 *   2. "what X do/did I like/prefer/love/enjoy/use"
 *   3. "tell/remind me (about) my favorite/preferred X"
 *   4. "do/did I like/prefer/love/enjoy X" (value-based lookup)
 *   5. "which X is/was my favorite/preferred/go-to"
 *   6. "what kind of X do/did I like/prefer/enjoy"
 */
export function detectPreferenceQuery(query) {
  const q = query.toLowerCase().trim()
    .replace(/what's/g, 'what is');  // Normalize contraction: "what's my" → "what is my"

  const patterns = [
    // Pattern 1: "what is my favorite car"
    /(?:what)\s+(?:is|are|was|were)\s+my\s+(?:favorite|favourite|preferred|go-to)\s+(.+?)(?:\?|$)/,
    // Pattern 6: "what kind of food do I like" (must precede Pattern 2 — more specific)
    // End anchor: \b not (?:\?|$) — allows "...like and why?" continuations
    /what\s+(?:kind|type|sort)\s+of\s+(.+?)\s+(?:do|did|does|would)\s+i\s+(?:like|prefer|love|enjoy)\b/,
    // Pattern 2: "what car do I like" / "what cars do I love and why"
    // End anchor: \b not (?:\?|$) — allows "...love and what do they say..." continuations
    /what\s+(.+?)\s+(?:do|did|does|would)\s+i\s+(?:like|prefer|love|enjoy|use)\b/,
    // Pattern 3: "tell me my favorite car" / "remind me about my preferred food"
    /(?:tell|remind)\s+me\s+(?:about\s+)?my\s+(?:favorite|favourite|preferred|go-to)\s+(.+?)(?:\?|$)/,
    // Pattern 4: "do I like Python" (value-based)
    /(?:do|did|does)\s+i\s+(?:like|prefer|love|enjoy)\s+(.+?)(?:\?|$)/,
    // Pattern 5: "which car is my favorite" / "which car is my favorite and why"
    // End anchor: \b not (?:\?|$) — allows "...favorite and why?" continuations
    /which\s+(.+?)\s+(?:is|are|was|were)\s+my\s+(?:favorite|favourite|preferred|go-to)\b/,
  ];

  for (const pattern of patterns) {
    const match = q.match(pattern);
    if (match && match[1]) {
      // Clean up the extracted category: strip punctuation + trailing filler phrases
      // (?:^|\s+) — handles both "cars and why" (mid-string) and "and what do they say" (start)
      const category = match[1]
        .replace(/[?.!,]/g, '')
        .replace(/(?:^|\s+)(?:and|or)\s+(?:why|how|when|where|who|what|which|how much|how many).*$/i, '')
        .replace(/\s+(?:of all time[s]?|ever|in the world|in the universe|on earth|in history)\s*$/i, '')
        .trim();
      if (category.length > 0 && category.length < 50) {
        return category;
      }
    }
  }

  return null;
}

/**
 * Look up user preferences via Supabase REST RPC.
 * Auth: tries JWT first (may still be valid for Supabase REST even when
 * expired per extension's session check), falls back to anon key.
 *
 * @param {string} category - Preference category to look up
 * @param {object} apiConfig - From getApiConfig()
 * @returns {Array} Raw preference rows from the RPC
 */
export async function lookupPreferencesViaREST(category, apiConfig) {
  // Resolve userId: apiConfig.userId (from JWT session) or fallback from storage
  let userId = apiConfig.userId;
  if (!userId) {
    const stored = await chrome.storage.local.get([AUTH_SESSION_KEY, 'user_id']);
    userId = stored[AUTH_SESSION_KEY]?.user?.id || stored.user_id || null;
  }
  if (!userId) {
    console.warn('⚠️ Preference router: no userId available, skipping lookup');
    return [];
  }

  // Build auth header: prefer JWT, fall back to anon key
  const authToken = apiConfig.accessToken || SUPABASE_ANON_KEY;
  const headers = {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_ANON_KEY,
    'Authorization': `Bearer ${authToken}`,
  };

  const url = `${SUPABASE_URL}/rest/v1/rpc/lookup_user_preferences`;
  const { id: prefProjectId } = await getActiveProject();
  const body = JSON.stringify({
    p_user_id: userId,
    p_category: category,
    p_limit: 3,  // Cap at 3 — dedup concern: 7 car rows floods injection, 3 suffices
    p_profile_id: await getActiveProfileId() || null,
    p_project_id: prefProjectId || null,
  });

  try {
    const response = await withTimeout(
      fetch(url, { method: 'POST', headers, body }),
      10000,  // 10s — RPC is a simple DB query, should be fast
      'preference-lookup'
    );

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      console.warn(`⚠️ Preference lookup RPC failed: ${response.status} ${errText}`);
      return [];
    }

    const data = await response.json();
    return data || [];
  } catch (err) {
    console.warn(`⚠️ Preference lookup failed: ${err.message}`);
    return [];
  }
}

/**
 * Convert preference RPC rows to the injection item format expected by
 * buildMemoryInjection(). Mirrors the edge function's candidate synthesis.
 *
 * @param {Array} prefRows - Rows from lookup_user_preferences RPC
 * @returns {Array} Items shaped for the retrieval result
 */
export function synthesizePreferenceItems(prefRows) {
  return prefRows.map(pref => {
    const sentimentLabel = pref.sentiment === 'positive' ? 'favorite'
      : pref.sentiment === 'negative' ? 'disliked'
      : '';
    const dateStr = pref.updated_at
      ? new Date(pref.updated_at).toLocaleDateString()
      : 'unknown date';

    const content = `User's ${sentimentLabel} ${pref.category}: ${pref.value}. Recorded: ${dateStr}.`;

    return {
      id: pref.source_turn_id || pref.id,
      content,
      platform: 'kyt',
      timestamp: pref.updated_at || pref.created_at || new Date().toISOString(),
      similarity: (pref.confidence || 0.8) * 0.9, // 0.8 * 0.9 = 0.72 (above 0.40 threshold)
      source_type: 'user_preference',
      preference_match: true,
    };
  });
}

/**
 * Main context retrieval pipeline.
 *
 * @param {string} userMessage - User's message text
 * @param {Object} config - Context injection configuration
 * @param {Object} deps - Injectable dependencies from background.js
 * @param {Function} deps.isCircuitBreakerOpen - Check if API circuit breaker is open
 * @param {number} deps.circuitBreakerOpenUntil - Timestamp when CB resets
 * @param {number} deps.consecutiveApiFailures - Failure count
 * @param {Function} deps.syncBeforeSearch - Flush pending sync (fire-and-forget)
 * @param {Object} deps.apiMetrics - API performance metrics object
 * @param {Function} deps.logApiMetrics - Log metrics function
 * @returns {Promise<Object>} Context data with formatted string and items
 */
export async function getContextForInjection(userMessage, config, deps = {}) {
  const startTime = performance.now();
  console.log(`🔍 getContextForInjection() called with query: "${userMessage.substring(0, 80)}${userMessage.length > 80 ? '...' : ''}"`);

  // Overall pipeline timeout — must complete before content.js port timeout (26s).
  // 22s gives 4s margin for message serialization + port communication.
  const PIPELINE_TIMEOUT_MS = 22000;

  try {
    const pipelineResult = await Promise.race([
      _runContextPipeline(userMessage, config, deps, startTime),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Pipeline timeout')), PIPELINE_TIMEOUT_MS)
      )
    ]);
    return pipelineResult;
  } catch (timeoutError) {
    if (timeoutError.message === 'Pipeline timeout') {
      const elapsed = performance.now() - startTime;
      console.error(`❌ Pipeline timeout after ${(elapsed / 1000).toFixed(1)}s — returning empty to avoid port disconnect`);
      return {
        success: false,
        error: 'Pipeline timeout',
        items: [],
        formattedContext: null,
        elapsedMs: elapsed,
        diagnostics: { pipelineTimeout: true },
      };
    }
    throw timeoutError;
  }
}

/** @private Inner pipeline — extracted so getContextForInjection can race it against a timeout. */
async function _runContextPipeline(userMessage, config, deps, startTime) {
  try {
    // PHASE 1 FIX #2: Use cached API config (survives service worker sleep)
    const apiConfig = await getApiConfig();

    // Use provided config or defaults
    const contextConfig = {
      threshold: config?.threshold || 0.5,
      maxContextItems: config?.maxContextItems || 3,
      candidatePoolSize: config?.candidatePoolSize || 25, // Retrieve more candidates — headroom for server-side filters before MMR
      minDistance: config?.minDistance || 0.0,
      excludeRecentSeconds: config?.excludeRecentSeconds || 120, // CONTEXT POLLUTION FIX: Exclude last 2 minutes
      confidenceThreshold: config?.confidenceThreshold || null, // Intent classifier override (PASSIVE → 0.60)
      debugMode: config?.debugMode || false,
      disableQueryTransformation: config?.disableQueryTransformation ?? apiConfig.disableQueryTransformation ?? false,
      conversationWindow: config?.conversationWindow || null, // Recent messages from current conversation
    };

    // ===== PIPELINE DIAGNOSTICS =====
    // Accumulates per-stage counts for debugging 0-item results
    const diagnostics = {
      routingMode: null,
      edgeItems: null,        // items from edge function (null = not attempted)
      legacyItems: null,      // items from legacy hybrid search (null = not attempted)
      preFilterItems: 0,      // items before confidence filter
      postFilterItems: 0,     // items after confidence filter
      confidenceThreshold: null,
      highestScore: null,
      apiCircuitBreakerOpen: false,
      embeddingCircuitBreakerOpen: false,
      hydeCBOpen: false,
      queryTransformed: false,
      preferenceRouted: false,
    };

    // ========================================================================
    // STEP 0: Preference Query Router (0ms regex, before any embedding)
    // Short-circuits the entire vector pipeline for "what is my favorite X?"
    // If query has trailing qualifiers ("and why", "and how"), preference items
    // are saved but vector pipeline also runs to provide supporting context.
    // Path-independent — works whether queries go edge or legacy.
    // ========================================================================
    let prefItems = null;  // populated if preference router finds results
    const queryHasQualifier = /\b(?:and|or)\s+(?:why|how|when|where|who|what)\b/i.test(userMessage);
    try {
      const prefCategory = detectPreferenceQuery(userMessage);
      if (prefCategory) {
        console.log(`🎯 Preference router activated: category="${prefCategory}"${queryHasQualifier ? ' (has qualifier — will also run vector pipeline)' : ''}`);
        const prefRows = await lookupPreferencesViaREST(prefCategory, apiConfig);
        if (prefRows.length > 0) {
          prefItems = synthesizePreferenceItems(prefRows);

          // Short-circuit only if no trailing qualifier — pure "what is my favorite X?"
          if (!queryHasQualifier) {
            console.log(`✅ Preference router: ${prefItems.length} preferences found — short-circuiting vector pipeline`);
            diagnostics.preferenceRouted = true;

            const elapsedTime = performance.now() - startTime;

            const retrievalResult = {
              state: 'FOUND',
              items: prefItems.map(item => ({
                id: item.id,
                content: item.content,
                platform: item.platform,
                timestamp: item.timestamp,
                similarity: item.similarity,
                source_type: item.source_type,
              })),
              latencyMs: elapsedTime,
              queryType: 'PREFERENCE',
              queryOriginal: userMessage,
              queryTransformed: null,
            };

            const formattedContext = buildMemoryInjection(retrievalResult, {
              debugMode: contextConfig.debugMode || false,
            });

            return {
              success: true,
              items: prefItems,
              formattedContext,
              elapsedMs: elapsedTime,
              transformation: { transformed: false },
              diagnostics,
            };
          }
          console.log(`ℹ️ Preference router: ${prefItems.length} preferences found — continuing to vector pipeline for "${userMessage.match(/\b(?:and|or)\s+(?:why|how|when|where|who|what)\b.*/i)?.[0] || 'qualifier'}" context`);
        } else {
          console.log('ℹ️ Preference router: no preferences found, falling through to vector pipeline');
        }
      }
    } catch (prefError) {
      console.warn('⚠️ Preference router failed (non-fatal), falling through:', prefError.message);
    }

    // Check in-memory circuit breaker — only affects API-dependent paths
    // BM25 keyword search is local and always available even when CB is open
    const apiAvailable = deps.isCircuitBreakerOpen ? !deps.isCircuitBreakerOpen() : true;
    diagnostics.apiCircuitBreakerOpen = !apiAvailable;
    if (!apiAvailable) {
      const waitSeconds = Math.ceil(((deps.circuitBreakerOpenUntil || 0) - Date.now()) / 1000);
      console.warn(
        `⚠️ Circuit breaker is OPEN — API paths disabled, BM25 still active. ` +
        `Resets in ${waitSeconds}s (${deps.consecutiveApiFailures || 0} failures)`
      );
    }

    // Check embedding circuit breaker (shared HuggingFace rate limit)
    try {
      const embCBStatus = await isEmbeddingCircuitOpen();
      diagnostics.embeddingCircuitBreakerOpen = embCBStatus.open;
      if (embCBStatus.open) {
        console.warn(`⚠️ Embedding circuit breaker OPEN: ${embCBStatus.reason} — vector search will fall back to BM25`);
      }
    } catch (_) {
      // Non-fatal — just can't report status
    }

    // Resolve routing mode early — edge mode handles query expansion server-side
    // so we skip client-side OpenAI calls that would CORS-fail from the SW.
    const routingMode = await getRoutingMode();
    diagnostics.routingMode = routingMode;

    // PHASE 7: Query Transformation (Dual ICP Support)
    let searchQuery = userMessage;
    let transformationMetadata = { transformed: false };

    // Skip client-side transformation in edge mode: the search_memories edge
    // function already runs HyDE + dual embedding + reranking server-side.
    if (!contextConfig.disableQueryTransformation && apiAvailable && routingMode !== 'edge') {
      // Skip transformation if HyDE CB is open (same OpenAI key — would 429 too)
      const hydeCbStatus = await hydeCB.isOpen();
      diagnostics.hydeCBOpen = hydeCbStatus.open;
      if (hydeCbStatus.open) {
        console.log('⚡ Query transformation skipped: HyDE circuit breaker open (shared OpenAI key)');
      } else {
      try {
        // 3s timeout: query transformation is an enhancement, not critical path.
        // On timeout, falls through to using the original query.
        const transformResult = await withTimeout(
          (async () => {
            // Get recent messages for context (to extract topics/emotional state)
            // PHASE 4 UPDATE: Fetch from Supabase for cross-device context
            const recentTopics = await fetchRecentTopicsFromSupabase(apiConfig);

            // Transform query
            return await transformQuery(
              userMessage,
              {
                recentTopics: recentTopics,
                searchContext: 'chat_history'
              },
              null
            );
          })(),
          3000,
          'Query transformation'
        );

        if (transformResult?.success && transformResult.transformed) {
          searchQuery = transformResult.optimizedQuery;
          transformationMetadata = {
            transformed: true,
            original: userMessage,
            optimized: searchQuery
          };
          diagnostics.queryTransformed = true;
          console.log(`🔄 Query transformed: "${userMessage}" → "${searchQuery}"`);
        } else if (transformResult) {
          console.log(`📊 Using original query (transformation ${transformResult.transformed ? 'succeeded' : 'skipped/failed'})`);
        }
      } catch (transformError) {
        console.warn('⚠️ Query transformation failed, using original query:', transformError);
      }
      } // end hydeCB else block
    } else if (routingMode === 'edge') {
      console.log('⚡ Query transformation skipped: edge mode (server-side HyDE handles expansion)');
    }

    // Sync-before-search: flush pending messages so cross-platform
    // memories are available immediately.
    if (deps.syncBeforeSearch) {
      try {
        await deps.syncBeforeSearch();
      } catch (syncErr) {
        console.warn('Sync-before-search failed (non-fatal):', syncErr.message);
      }
    }

    // Extract platform mention early (needed by topic enrichment + temporal fallback)
    const targetPlatform = extractPlatformMention(userMessage);

    // ===== RECENT TOPIC ENRICHMENT (implicit/vague query boost) =====
    // When the query is short/vague and has temporal language, enrich with
    // recently discussed topics to ground the retrieval.
    let recentTopicBoost = null;
    try {
      const temporalHint = scoreTemporalReference(userMessage.toLowerCase());
      const wordCount = userMessage.trim().split(/\s+/).length;
      if (wordCount <= 6 || temporalHint >= 0.3) {
        const topics = await getRecentTopics(targetPlatform);
        if (topics.length > 0) {
          recentTopicBoost = topics.slice(0, 5);
          diagnostics.recentTopicBoost = recentTopicBoost;
        }
      }
    } catch (_) {}

    let contextItems = [];

    try {
      // Use transformed query if available, otherwise original
      const queryToUse = transformationMetadata.transformed ? searchQuery : userMessage;

      console.log(`🔍 Context Retrieval: Using query "${queryToUse}"`);

      // Get active project for scoped search
      const { id: activeProjectId } = await getActiveProject();

      // Dual-path: edge function vs legacy client-side search
      if (routingMode === 'edge') {
        // ─── Edge function path (authenticated users) ───
        try {
          contextItems = await searchViaEdgeFunction(queryToUse, {
            topK: contextConfig.candidatePoolSize,
            fast: true,
            confidenceThreshold: contextConfig.confidenceThreshold || undefined,
            recentTopics: recentTopicBoost || undefined,
            conversationWindow: contextConfig.conversationWindow || undefined,
            projectId: activeProjectId || undefined,
          });
          diagnostics.edgeItems = contextItems.length;
          console.log(`✅ Context Retrieval (edge): Found ${contextItems.length} items (pool: ${contextConfig.candidatePoolSize}, inject cap: ${contextConfig.maxContextItems})`);

          // Retry with original query if transformed returned 0
          if (contextItems.length === 0 && transformationMetadata.transformed) {
            console.log('🔄 Retry (edge): retrying with original query...');
            try {
              contextItems = await searchViaEdgeFunction(userMessage, {
                topK: contextConfig.candidatePoolSize,
                fast: true,
                confidenceThreshold: contextConfig.confidenceThreshold || undefined,
                projectId: activeProjectId || undefined,
              });
              console.log(`🔄 Retry (edge) result: ${contextItems.length} items`);
            } catch (retryErr) {
              console.warn(`⚠️ Edge retry failed: ${retryErr.message}`);
              contextItems = [];
            }
          }
        } catch (edgeError) {
          console.warn(`⚠️ Edge function search failed, falling back to legacy: ${edgeError.message}`);
          contextItems = [];
        }
      }

      if (routingMode !== 'edge' || contextItems.length === 0) {
        // ─── Legacy client-side path ───
        if (routingMode === 'edge') {
          console.warn('⚠️ Edge path returned 0 results or failed — legacy fallback.');
        }

        const maxTimestamp = Date.now() - (contextConfig.excludeRecentSeconds * 1000);

        const searchStart = performance.now();
        contextItems = await searchHybrid(queryToUse, {
          limit: contextConfig.candidatePoolSize,
          semanticThreshold: 0.50,
          bm25Threshold: 0.1,
          enableBM25: true,
          enableSemantic: apiAvailable,
          enableHyDE: apiAvailable,
          enableGraph: true,
          role: null,
          source: null,
          maxTimestamp: maxTimestamp,
        });
        const searchMs = (performance.now() - searchStart).toFixed(0);

        diagnostics.legacyItems = contextItems.length;
        diagnostics.searchMs = Number(searchMs);
        console.log(`✅ Context Retrieval: Found ${contextItems.length} items via Hybrid Search in ${searchMs}ms (pool: ${contextConfig.candidatePoolSize})`);
        console.log('📊 Search Strategy Breakdown:', JSON.stringify({
          routing: routingMode,
          query: queryToUse.substring(0, 80),
          totalResults: contextItems.length,
          semanticAvailable: contextItems.metadata?.semanticAvailable,
          jinaReranked: contextItems.metadata?.jinaReranked,
          embeddingCBOpen: deps.isCircuitBreakerOpen ? deps.isCircuitBreakerOpen() : false,
          apiAvailable,
        }));

        // E1: If transformed query returned 0 results, retry with original query
        if (contextItems.length === 0 && transformationMetadata.transformed) {
          console.log('🔄 Retry: Transformed query returned 0 results, retrying with original query...');
          contextItems = await searchHybrid(userMessage, {
            limit: contextConfig.candidatePoolSize,
            semanticThreshold: 0.50,
            bm25Threshold: 0.1,
            enableBM25: true,
            enableSemantic: apiAvailable,
            enableHyDE: apiAvailable,
            enableGraph: true,
            role: null,
            source: null,
            maxTimestamp: maxTimestamp,
          });
          console.log(`🔄 Retry result: ${contextItems.length} items with original query`);
        }
      }

    } catch (searchError) {
      console.error('❌ Context Retrieval failed:', searchError);
      contextItems = [];
    }

    // TEMPORAL + PLATFORM FALLBACK: When query mentions a specific platform with
    // temporal intent and main search found nothing from that platform, fetch
    // recent items directly via ORDER BY created_at DESC.
    const temporalScore = scoreTemporalReference(userMessage.toLowerCase());
    const hasTargetPlatformItems = targetPlatform &&
      contextItems.some(item => (item.source || item.platform) === targetPlatform);

    if (temporalScore >= 0.4 && targetPlatform && !hasTargetPlatformItems) {
      console.log(`🕐 Temporal+platform fallback: "${userMessage.substring(0, 40)}..." → ${targetPlatform} (temporal: ${temporalScore})`);
      try {
        const recencyItems = await searchViaEdgeFunction(userMessage, {
          topK: 3,
          recentByPlatform: targetPlatform,
          projectId: activeProjectId || undefined,
        });
        if (recencyItems.length > 0) {
          const existingIds = new Set(contextItems.map(i => i.id));
          const newItems = recencyItems.filter(i => !existingIds.has(i.id));
          contextItems = contextItems.concat(newItems);
          console.log(`🕐 Temporal fallback: added ${newItems.length} recent ${targetPlatform} items`);
          diagnostics.temporalFallback = { platform: targetPlatform, added: newItems.length };
        }
      } catch (err) {
        console.warn(`⚠️ Temporal fallback failed: ${err.message}`);
      }
    }

    // SYNTHESIS + PLATFORM FALLBACK: When query uses synthesis language ("connect",
    // "relate") and mentions a platform, ensure platform-specific content is available
    // for the LLM to bridge topics.
    const synthesisScore = scoreSynthesisIntent(userMessage);
    // Recalculate after temporal fallback may have mutated contextItems
    const hasTargetPlatformItemsNow = targetPlatform &&
      contextItems.some(item => (item.source || item.platform) === targetPlatform);
    if (synthesisScore >= 0.5 && targetPlatform && !hasTargetPlatformItemsNow) {
      console.log(`🔗 Synthesis+platform fallback: "${userMessage.substring(0, 40)}..." → ${targetPlatform} (synthesis: ${synthesisScore})`);
      try {
        const synthItems = await searchViaEdgeFunction(userMessage, {
          topK: 5,
          recentByPlatform: targetPlatform,
          projectId: activeProjectId || undefined,
        });
        if (synthItems.length > 0) {
          const existingIds = new Set(contextItems.map(i => i.id));
          const newItems = synthItems.filter(i => !existingIds.has(i.id));
          contextItems = contextItems.concat(newItems);
          console.log(`🔗 Synthesis fallback: added ${newItems.length} ${targetPlatform} items for multi-topic bridging`);
          diagnostics.synthesisFallback = { platform: targetPlatform, added: newItems.length };
        }
      } catch (err) {
        console.warn(`⚠️ Synthesis fallback failed: ${err.message}`);
      }
    }

    // === CONFIDENCE THRESHOLD FILTERING ===
    // Quality penalties, MMR, keyword boost, echo/meta/deflection filters are
    // now handled server-side. Client only applies confidence threshold.
    let filteredItems = contextItems;
    diagnostics.preFilterItems = filteredItems.length;
    if (filteredItems.length > 0) {
      try {
        const semanticWasAvailable = contextItems.metadata?.semanticAvailable ?? true;
        const jinaReranked = contextItems.metadata?.jinaReranked ?? true;
        let defaultThreshold;
        if (!jinaReranked) {
          defaultThreshold = 0.01;
        } else if (!semanticWasAvailable) {
          defaultThreshold = 0.25;
        } else {
          defaultThreshold = 0.40;
        }
        const confidenceThreshold = contextConfig.confidenceThreshold || defaultThreshold;
        if (!jinaReranked) {
          console.log(`🎯 Jina unavailable — uncalibrated threshold: ${confidenceThreshold}`);
        } else if (!semanticWasAvailable) {
          console.log(`🎯 BM25-only mode — adaptive threshold: ${confidenceThreshold}`);
        }
        diagnostics.confidenceThreshold = confidenceThreshold;
        console.log(`🎯 Applying confidence filter (threshold: ${confidenceThreshold}) to ${filteredItems.length} candidates...`);

        const filterResult = filterByConfidence(filteredItems, confidenceThreshold);
        diagnostics.highestScore = filterResult.highestScore ?? null;

        // Log filtering results
        if (filterResult.status === 'success') {
          console.log(`✅ Confidence filter: ${filterResult.results.length}/${filteredItems.length} items passed (highest: ${filterResult.highestScore.toFixed(3)})`);
          filteredItems = filterResult.results;
        } else if (filterResult.status === 'low_confidence') {
          console.warn(`⚠️ Confidence filter: All ${filteredItems.length} items below threshold (highest: ${filterResult.highestScore.toFixed(3)})`);
          if (filterResult.suggestions && contextConfig.debugMode) {
            console.log(`💡 Suggestions:`, filterResult.suggestions);
          }
          // Platform-aware rescue: when user explicitly asks about a platform, rescue top 2 items
          // with a 0.25 floor — cross-platform queries are inherently harder and deserve leniency.
          const platformMention = /\b(gemini|chatgpt|claude|cross.?platform|other\s+(?:chat|conversation|platform))\b/i.test(userMessage);
          if (platformMention && filterResult.highestScore >= 0.25) {
            console.log(`🌐 Platform-aware rescue: "${userMessage.substring(0, 40)}..." mentions platform — rescuing top 2 (highest: ${filterResult.highestScore.toFixed(3)})`);
            filteredItems = filteredItems
              .sort((a, b) => {
                const scoreA = a.cross_encoder_score ?? a.weighted_score ?? 0;
                const scoreB = b.cross_encoder_score ?? b.weighted_score ?? 0;
                return scoreB - scoreA;
              })
              .slice(0, 2)
              .map(item => ({ ...item, lowConfidence: true }));
          } else if (filterResult.highestScore >= 0.10) {
            console.log(`📋 Low-confidence tier: keeping top 2 items (highest: ${filterResult.highestScore.toFixed(3)})`);
            filteredItems = filteredItems
              .sort((a, b) => {
                const scoreA = a.cross_encoder_score ?? a.weighted_score ?? 0;
                const scoreB = b.cross_encoder_score ?? b.weighted_score ?? 0;
                return scoreB - scoreA;
              })
              .slice(0, 2)
              .map(item => ({ ...item, lowConfidence: true }));
          } else {
            // Below 0.10 — truly irrelevant, drop everything
            filteredItems = [];
          }
        } else {
          // no_results status
          console.log(`ℹ️ Confidence filter: No results to filter`);
          filteredItems = [];
        }

      } catch (error) {
        console.error('❌ Confidence filtering failed, falling back to raw results:', error.message);
      }
    }

    diagnostics.postFilterItems = filteredItems.length;

    // === PREFERENCE + VECTOR MERGE ===
    if (prefItems && prefItems.length > 0 && queryHasQualifier) {
      const prefIds = new Set(prefItems.map(p => p.id));
      filteredItems = filteredItems.filter(item => !prefIds.has(item.message_id || item.id));
      const highestVectorScore = filteredItems.reduce((max, item) => {
        const s = item.cross_encoder_score ?? item.weighted_score ?? item.rrf_score ?? 0;
        return s > max ? s : max;
      }, 0);

      const prefAsVector = prefItems.map(p => {
        const baseScore = p.similarity;
        const floorScore = Math.max(baseScore, highestVectorScore + 0.01);
        if (floorScore > baseScore) {
          console.log(`📌 Preference score floor: ${baseScore.toFixed(3)} → ${floorScore.toFixed(3)} (vector max was ${highestVectorScore.toFixed(3)})`);
        }
        return {
          id: p.id,
          content: p.content,
          platform: p.platform,
          timestamp: p.timestamp,
          msg_timestamp: p.timestamp,
          cross_encoder_score: floorScore,
          source: p.source_type,
          source_type: p.source_type,
          preference_match: true,
        };
      });
      filteredItems = [...prefAsVector, ...filteredItems];
      console.log(`🔀 Preference+Vector merge: ${prefItems.length} pref + ${filteredItems.length - prefItems.length} vector = ${filteredItems.length} total`);
    }

    // === MEMORY INJECTION PROTOCOL v1.0 ===
    const elapsedTime = performance.now() - startTime;

    let formattedContext = null;

    if (filteredItems.length > 0) {
      const retrievalResult = {
        state: 'FOUND',
        items: filteredItems.map(item => ({
          id: item.message_id || item.id,
          content: item.content,
          role: item.role || 'unknown',
          platform: item.source === 'cli' ? 'terminal' : (item.platform || 'chatgpt'),
          timestamp: (() => { const d = new Date(item.msg_timestamp || item.timestamp); return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString(); })(),
          similarity: item.cross_encoder_score != null
            ? item.cross_encoder_score
            : (item.distance != null && !isNaN(item.distance))
              ? Math.max(0, 1 - item.distance)
              : (item.weighted_score ?? item.rrf_score ?? 0.5),
          source_type: item.source || 'conversation'
        })),
        latencyMs: elapsedTime,
        queryType: synthesisScore >= 0.5 ? 'SYNTHESIS' : (transformationMetadata.transformed ? 'HYBRID' : 'SEMANTIC'),
        queryOriginal: userMessage,
        queryTransformed: transformationMetadata.transformed ? transformationMetadata.optimized : null
      };

      formattedContext = buildMemoryInjection(retrievalResult, {
        debugMode: contextConfig.debugMode || false,
        facetedGrouping: synthesisScore >= 0.5,
      });

      console.log('✅ Memory Injection Protocol: Injection block built with', filteredItems.length, 'items');
    } else {
      formattedContext = null;
      console.log('ℹ️ Memory Injection Protocol: No results — skipping injection (no negative signal)');
    }

    // VALIDATION FIX: Log API metrics periodically
    if (deps.apiMetrics && deps.apiMetrics.totalAttempts % 10 === 0 && deps.apiMetrics.totalAttempts > 0) {
      if (deps.logApiMetrics) deps.logApiMetrics();
    }

    return {
      success: true,
      items: filteredItems,
      formattedContext: formattedContext,
      elapsedMs: elapsedTime,
      transformation: transformationMetadata,
      diagnostics,
    };

  } catch (error) {
    console.error('❌ Context retrieval failed:', error);

    // VALIDATION FIX: Log metrics on failure
    if (deps.logApiMetrics) deps.logApiMetrics();

    // Use Memory Injection Protocol error state
    const errorInjection = buildErrorInjection(
      error.code || 'RETRIEVAL_ERROR',
      error.message,
      userMessage
    );

    return {
      success: false,
      error: error.message,
      items: [],
      formattedContext: errorInjection
    };
  }
}
