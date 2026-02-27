/**
 * Context Retrieval Module
 * Extracted from background.js — the full getContextForInjection() pipeline.
 *
 * Owns: preference router, search dispatch, recency resolution, echo/meta/deflection
 * filters, MMR, keyword boost, confidence filter, injection building.
 *
 * IMPORTANT (MV3): All imports must be static. No dynamic import().
 */

import { searchHybrid } from './browser-search.js';
import { applyMMR, extractEntities } from './mmr.js';
import { transformQuery, fetchRecentTopicsFromSupabase } from './query-transformer.js';
import { buildMemoryInjection, buildErrorInjection } from '../kyt-memory-injection-builder.js';
import { classifyContent } from './taxonomy-classifier.js';
import { applyKeywordBoost } from './keyword-boost.js';
import { filterByConfidence } from './confidence-filter.js';
import { detectDeflection, applyDeflectionPenalty } from './assistant-quality-detector.js';
import { searchViaEdgeFunction } from './edge-search.js';
import { hydeCB } from './hyde-search-generator.js';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './supabase-config.js';
import { getApiConfig, getRoutingMode } from './auth-config.js';
import { AUTH_SESSION_KEY } from './auth/auth-service.js';
import { getActiveProfileId } from './profile-manager.js';

// ===== MODULE-LEVEL CONSTANTS (extracted for testability) =====

// Stop words excluded from echo overlap calculation
export const ECHO_STOP = new Set([
  'the','and','for','with','from','that','this','have','has','what','when',
  'where','which','who','how','why','are','was','were','been','being','can',
  'could','should','would','will','not','but','about','into','than','then',
  'them','they','your','you','our','its','his','her','their','does','did',
  'top','best','most','need','needs','want','use','like','just','also',
  'some','any','all','each','every','tell','know','think','make','take',
]);

// Meta-conversation patterns: penalize KYT/extension operational chatter
export const KYT_META_PATTERNS = [
  /\bK\.?Y\.?T\.?\b.*\b(extension|plugin|add-?on)\b.*\b(working|broken|not working|crash|error|bug|fix|debug)\b/i,
  /\b(extension|memory system|knowledge base)\b.*\b(broken|not working|crash|paused|down|error)\b/i,
  /\bchrome\.?(runtime|storage|extension)\b.*\b(error|bug|crash|fail|broken|terminat|restart|debug)\b/i,
  /\bservice worker\b.*\b(terminat|restart|error|log|crash|fail)\b/i,
  /\bKYT_(?:MESSAGE|CONTEXT|BRIDGE|DEBUG)\b/,
];

// Skip meta-penalty when the user's query is genuinely about KYT/extension
export const KYT_QUERY_PATTERNS = [
  /\bK\.?Y\.?T\.?\b/i,
  /\b(extension|chrome extension)\b.*\b(model|support|need|use|feature|work)/i,
  /\bservice worker\b/i,
];

// Retrieval-diagnostic patterns: penalize chunks that analyze retrieval behavior
// These are "meta about meta" — conversations about query failures, scoring, thresholds
// Without this, diagnostic discussions cannibalize source content (meta-echo problem)
export const RETRIEVAL_DIAGNOSTIC_PATTERNS = [
  // --- Original 12 patterns: mechanical pipeline vocabulary ---
  /\b(query|retrieval|search)\s+(failed|returned|missed|found nothing)\b/i,
  /\bconfidence\s+(was|of|at)\s+0\.\d+\b/i,
  /\b(semantic|vector)\s+anchor/i,
  /\bfalse\s+fire\b/i,
  /\bburned\s+a\s+retrieval\s+cycle\b/i,
  /\b(meta-?echo|echo\s+problem)\b/i,
  /\bretrieval\s+(failure|gap|quality|pipeline)\b/i,
  /\bintent\s+classif(ier|ication)\s+(would|should|could|will)\b/i,
  /\b(confidence|match)\s+threshold\b.*\b0\.\d+\b/i,
  /\b(scored|scoring)\s+(at|with)\s+0\.\d+\b/i,
  /\bpipeline\s+(fires|fired|should\s+(not\s+)?fire|didn't\s+fire)\b/i,
  /\bwasted\s+retrieval\s+cycle\b/i,

  // --- 11 new patterns (v2): natural-language diagnostic analysis ---
  // #13: Analysis of retrieved items quality
  /\bretrieved\s+item\b.*\b(useful|thin|relevant|partial|incomplete|sufficient)\b/i,
  // #14: Chunk/pointer diagnostic vocabulary
  /\b(single\s+)?chunk\s+(is\s+a\s+)?(pointer|fragment|partial|slice)\b/i,
  // #15: Injection quality assessment
  /\binjection\s+(quality|accuracy|completeness|coverage)\b/i,
  // #16: Provenance chain analysis
  /\bprovenance\s+(chain|trail|path)\b/i,
  // #17: Numeric score in analysis context ("0.62 single-item result")
  /\b0\.\d{2}\s+(single-?item|item|result|confidence)\b/i,
  // #18: Cross-session/distributed answer discussion
  /\b(cross-?session|multi-?day|distributed)\s+(answer|content|result|retrieval)\b/i,
  // #19: "what the pipeline/system returned/found/missed"
  /\bwhat\s+the\s+(pipeline|system|retrieval|search)\s+(returned|found|missed|surfaced)\b/i,
  // #20: Low/high confidence result analysis
  /\b(low|high|medium|weak|strong)-?confidence\s+(result|item|match|retrieval)s?\b/i,
  // #21: "KYT performed/did/ran a retrieval/search"
  /\bK\.?Y\.?T\.?\s+(performed|did|ran|executed|triggered)\s+a?\s*(retrieval|search|query|lookup)\b/i,
  // #22: "answer isn't/wasn't in one place/chunk"
  /\banswer\s+(isn'?t|wasn'?t|is\s+not|was\s+not)\s+in\s+(one|a\s+single)\s+(place|chunk|item|turn)\b/i,
  // #23: Pipeline returned N items
  /\b(pipeline|retrieval)\s+(returned|surfaced|pulled|fetched)\s+\d+\s+(item|result|chunk|match)/i,
];

// Skip diagnostic penalty when user is genuinely asking about retrieval analysis
export const RETRIEVAL_QUERY_PATTERNS = [
  /\bretrieval\s+(failures?|issues?|problems?|quality)\b/i,
  /\b(query|search)\s+(failures?|diagnostics?|analysis)\b/i,
  /\bwhat\s+(went\s+wrong|failed)\s+with\s+(the\s+)?(search|retrieval|query)\b/i,
];

/**
 * Calculate word overlap ratio between query and content.
 * Used by echo filter to detect query parroting.
 * @param {string} query
 * @param {string} content
 * @returns {number} Overlap ratio (0-1)
 */
export function echoOverlapRatio(query, content) {
  const getWords = (text) =>
    text.toLowerCase().replace(/[^\w\s]/g, '').split(/\s+/)
      .filter(w => w.length > 2 && !ECHO_STOP.has(w));
  const qWords = new Set(getWords(query));
  if (qWords.size === 0) return 0;
  const cWords = new Set(getWords(content));
  const overlap = [...qWords].filter(w => cWords.has(w)).length;
  return overlap / qWords.size;
}

/**
 * Length-scaled echo penalty multiplier.
 * Short echoes (<300 chars) get harsh penalty; long substantive responses get gentle.
 * @param {number} contentLength
 * @returns {number} Multiplier (0.50, 0.70, or 0.90)
 */
export function echoMultiplier(contentLength) {
  if (contentLength < 300) return 0.50;
  if (contentLength <= 800) return 0.70;
  return 0.90;
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
  const body = JSON.stringify({
    p_user_id: userId,
    p_category: category,
    p_limit: 3,  // Cap at 3 — dedup concern: 7 car rows floods injection, 3 suffices
    p_profile_id: await getActiveProfileId() || null,
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
 * Entity-aware recency resolution — pure timestamp ordering.
 * When multiple items reference the same entity, the newest item always wins.
 * No negation heuristic — handles affirmation chains correctly:
 *   "Jerry is real" → "Jerry is not real" → "Jerry is now real"
 *
 * For each entity group: newest gets 1.5x boost, all older get 0.6x penalty.
 * Uses server entity data (item.entities[]) when available, falls back to regex.
 */
export function applyRecencyResolution(items) {
  if (items.length <= 1) return items;

  // Group items by shared entities
  const entityGroups = new Map(); // entity -> [items]

  for (const item of items) {
    // Prefer server-provided entity data (canonical names from GPT-4o-mini extraction)
    const entities = (item.entities && item.entities.length > 0)
      ? new Set(item.entities.map(e => (e.canonical_name || e).toLowerCase()))
      : extractEntities(item);
    for (const entity of entities) {
      if (!entityGroups.has(entity)) entityGroups.set(entity, []);
      entityGroups.get(entity).push(item);
    }
  }

  // For each entity with multiple items, apply pure timestamp-based resolution
  const boosted = new Set();   // items that got a recency boost
  const penalized = new Set(); // items that got a recency penalty

  // Determine the score key (cross_encoder_score > distance > weighted_score)
  const scoreKey = items[0]?.cross_encoder_score != null ? 'cross_encoder_score'
      : items[0]?.distance != null ? 'distance'
      : 'weighted_score';

  for (const [entity, group] of entityGroups) {
    if (group.length < 2) continue;

    // Sort by timestamp descending (newest first)
    group.sort((a, b) => {
      const tA = new Date(a.msg_timestamp || a.timestamp || 0).getTime();
      const tB = new Date(b.msg_timestamp || b.timestamp || 0).getTime();
      return tB - tA;
    });

    const newest = group[0];
    const older = group.slice(1);

    // Confidence gate: if the highest-scoring older item significantly outscores
    // the newest, skip recency resolution for this entity. This prevents a
    // low-confidence assistant "revision" (e.g., 0.54) from overtaking a
    // high-confidence match (e.g., 0.93) via a small timestamp advantage.
    const newestScore = newest[scoreKey] ?? 0;
    const bestOlderScore = Math.max(...older.map(o => o[scoreKey] ?? 0));
    if (bestOlderScore - newestScore > 0.2) {
      console.log(`🕐 Recency SKIPPED: "${entity}" — oldest scores higher (${bestOlderScore.toFixed(3)} vs ${newestScore.toFixed(3)}, gap ${(bestOlderScore - newestScore).toFixed(3)})`);
      continue;
    }

    // Timestamp ordering: newest wins for any entity with multiple mentions
    if (!boosted.has(newest) && newest[scoreKey] != null) {
      newest[scoreKey] = Math.min(1.0, newest[scoreKey] * 1.5);
      boosted.add(newest);
      console.log(`🕐 Recency boost: "${entity}" — newest item boosted 1.5x`);
    }

    // Penalize all older items for this entity (mild — complementary facts survive)
    for (const old of older) {
      if (old[scoreKey] != null && !penalized.has(old)) {
        old[scoreKey] *= 0.8;
        penalized.add(old);
        console.log(`🕐 Recency penalty: "${entity}" — older item penalized 0.8x`);
      }
    }
  }

  return items;
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

  try {
    // PHASE 1 FIX #2: Use cached API config (survives service worker sleep)
    const apiConfig = await getApiConfig();

    // Use provided config or defaults
    const contextConfig = {
      threshold: config?.threshold || 0.5,
      maxContextItems: config?.maxContextItems || 3,
      candidatePoolSize: config?.candidatePoolSize || 25, // Retrieve more candidates — headroom for echo/deflection filters before MMR
      minDistance: config?.minDistance || 0.0,
      excludeRecentSeconds: config?.excludeRecentSeconds || 120, // CONTEXT POLLUTION FIX: Exclude last 2 minutes
      confidenceThreshold: config?.confidenceThreshold || null, // Intent classifier override (PASSIVE → 0.60)
      debugMode: config?.debugMode || false,
      disableQueryTransformation: config?.disableQueryTransformation ?? apiConfig.disableQueryTransformation ?? false
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
    if (!apiAvailable) {
      const waitSeconds = Math.ceil(((deps.circuitBreakerOpenUntil || 0) - Date.now()) / 1000);
      console.warn(
        `⚠️ Circuit breaker is OPEN — API paths disabled, BM25 still active. ` +
        `Resets in ${waitSeconds}s (${deps.consecutiveApiFailures || 0} failures)`
      );
    }

    // Resolve routing mode early — edge mode handles query expansion server-side
    // so we skip client-side OpenAI calls that would CORS-fail from the SW.
    const routingMode = await getRoutingMode();

    // PHASE 7: Query Transformation (Dual ICP Support)
    let searchQuery = userMessage;
    let transformationMetadata = { transformed: false };

    // Skip client-side transformation in edge mode: the search_memories edge
    // function already runs HyDE + dual embedding + reranking server-side.
    if (!contextConfig.disableQueryTransformation && apiAvailable && routingMode !== 'edge') {
      // Skip transformation if HyDE CB is open (same OpenAI key — would 429 too)
      const hydeCbStatus = await hydeCB.isOpen();
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
              apiConfig.openaiKey
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

    let contextItems = [];

    try {
      // Use transformed query if available, otherwise original
      const queryToUse = transformationMetadata.transformed ? searchQuery : userMessage;

      console.log(`🔍 Context Retrieval: Using query "${queryToUse}"`);

      // Dual-path: edge function vs legacy client-side search
      if (routingMode === 'edge') {
        // ─── Edge function path (authenticated users) ───
        try {
          contextItems = await searchViaEdgeFunction(queryToUse, {
            topK: contextConfig.candidatePoolSize,
          });
          console.log(`✅ Context Retrieval (edge): Found ${contextItems.length} items (pool: ${contextConfig.candidatePoolSize}, inject cap: ${contextConfig.maxContextItems})`);

          // Retry with original query if transformed returned 0
          if (contextItems.length === 0 && transformationMetadata.transformed) {
            console.log('🔄 Retry (edge): retrying with original query...');
            contextItems = await searchViaEdgeFunction(userMessage, {
              topK: contextConfig.candidatePoolSize,
            });
            console.log(`🔄 Retry (edge) result: ${contextItems.length} items`);
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

        contextItems = await searchHybrid(queryToUse, {
          limit: contextConfig.candidatePoolSize,
          semanticThreshold: 0.50,
          bm25Threshold: 0.1,
          enableBM25: true,
          enableSemantic: apiAvailable,
          enableHyDE: apiAvailable && !!apiConfig.openaiKey,
          enableGraph: true,
          openaiKey: apiConfig.openaiKey,
          role: null,
          source: null,
          maxTimestamp: maxTimestamp,
        });

        console.log(`✅ Context Retrieval: Found ${contextItems.length} items via Hybrid Search (pool: ${contextConfig.candidatePoolSize})`);
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
            enableHyDE: apiAvailable && !!apiConfig.openaiKey,
            enableGraph: true,
            openaiKey: apiConfig.openaiKey,
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

    // Apply mild recency boost to help newer memories compete with semantically richer older ones
    if (contextItems.length > 1) {
      const HALF_LIFE_DAYS = 30;
      const now = Date.now();
      const scoreKey = contextItems[0]?.cross_encoder_score != null ? 'cross_encoder_score'
          : contextItems[0]?.distance != null ? 'distance'
          : 'weighted_score';

      for (const item of contextItems) {
        if (item[scoreKey] == null) continue;
        const itemTime = new Date(item.msg_timestamp || item.timestamp || 0).getTime();
        const daysSince = Math.max(0, (now - itemTime) / 86400000);
        const recencyMultiplier = Math.exp(-daysSince / HALF_LIFE_DAYS);
        // Blend: 85% original score + 15% recency-adjusted score
        item[scoreKey] = item[scoreKey] * 0.85 + item[scoreKey] * recencyMultiplier * 0.15;
      }
      console.log(`🕐 Recency multiplier applied to ${contextItems.length} results (half-life: ${HALF_LIFE_DAYS}d)`);
    }

    // QUERY ECHO FILTER: Remove results that just repeat the search query
    // Uses module-level ECHO_STOP set (exported for testing)
    {
      const qWords = new Set(
        userMessage.toLowerCase().replace(/[^\w\s]/g, '').split(/\s+/)
          .filter(w => w.length > 2 && !ECHO_STOP.has(w))
      );
      if (qWords.size > 0) {
        const beforeCount = contextItems.length;
        contextItems = contextItems.filter(item => {
          const content = (item.content || '').toLowerCase().replace(/[^\w\s]/g, '');
          if (content.length < 80) {
            const cWords = new Set(content.split(/\s+/).filter(w => w.length > 2 && !ECHO_STOP.has(w)));
            const overlap = [...qWords].filter(w => cWords.has(w)).length;
            if (overlap / Math.max(qWords.size, 1) > 0.7) {
              console.log(`🔇 Query echo filter: dropped "${(item.content || '').substring(0, 60)}..." (${overlap}/${qWords.size} word overlap)`);
              return false;
            }
          }
          return true;
        });
        if (contextItems.length < beforeCount) {
          console.log(`🔇 Query echo filter: removed ${beforeCount - contextItems.length} echo(es)`);
        }
      }
    }

    // RECURSION GUARD: Filter out items that contain K.Y.T. protocol headers or artifacts
    contextItems = contextItems.filter(item => {
      const content = item.content || '';
      const hasInjectionHeader = content.includes("K.Y.T. MEMORY INJECTION PROTOCOL") ||
        content.includes("K.Y.T. — User's Personal Knowledge Base");
      const hasInjectionArtifacts = content.includes("[RETRIEVAL_CONTEXT]") ||
        content.includes("[SESSION_CONTEXT]") ||
        content.includes("[DATA_PROVENANCE]") ||
        content.includes("[Retrieved Items]");
      const hasNestedMarkers = content.includes("[Memory Context") ||
        content.includes("[Query Optimized");
      const isPolluted = hasInjectionHeader || hasInjectionArtifacts || hasNestedMarkers;
      if (isPolluted) {
        console.warn(`⚠️ Recursion Guard: Dropped polluted memory item (ID: ${item.id || 'unknown'})`);
      }
      return !isPolluted;
    });

    // META FLAG FILTER
    contextItems = contextItems.filter(item => {
      if (item.meta === true) {
        console.warn(`⚠️ Meta Filter: Dropped meta-conversation item (ID: ${item.id || 'unknown'})`);
        return false;
      }
      return true;
    });

    // DEFLECTION PENALTY (Layer 2: retrieval-time)
    for (const item of contextItems) {
      let deflectionContent = item.content;
      let deflectionRole = item.role;
      if (deflectionRole !== 'assistant' && item.content) {
        const asstBlocks = [];
        const re = /(?:^|\n\n)Assistant:\s*([\s\S]*?)(?=\n\nUser:|\s*$)/gi;
        let m;
        while ((m = re.exec(item.content)) !== null) {
          asstBlocks.push(m[1].trim());
        }
        if (asstBlocks.length > 0) {
          deflectionContent = asstBlocks.join('\n');
          deflectionRole = 'assistant';
        } else if (deflectionRole === 'unknown') {
          deflectionRole = 'assistant';
        }
      }

      const check = detectDeflection(deflectionContent, deflectionRole);
      if (check.isDeflection && check.confidence > 0) {
        const before = item.cross_encoder_score ?? item.weighted_score ?? item.rrf_score ?? 'n/a';
        applyDeflectionPenalty(item, check.confidence);
        const after = item.cross_encoder_score ?? item.weighted_score ?? item.rrf_score ?? 'n/a';
        console.log(`🗑️ Deflection penalty: ${check.reason} | score ${before} → ${after} (ID: ${item.id || item.message_id || 'unknown'})`);
        if (check.confidence >= 0.85) {
          item._deflectionDropped = true;
        }
      }
    }

    // Remove hard-dropped deflections (high confidence ≥ 0.85)
    contextItems = contextItems.filter(item => !item._deflectionDropped);

    // BARE QUESTION FILTER
    contextItems = contextItems.filter(item => {
      const content = (item.content || '').trim();
      if (content.length < 120 && !/\bAssistant:/i.test(content)) {
        if (content.endsWith('?') || INTERROGATIVE_RE.test(content)) {
          console.log(`🔍 Bare question filter: dropped "${content.substring(0, 60)}..." (ID: ${item.id || item.message_id || 'unknown'})`);
          return false;
        }
      }
      return true;
    });

    // KYT META-CONVERSATION PENALTY
    // Uses module-level KYT_META_PATTERNS and KYT_QUERY_PATTERNS (exported for testing)
    const ECHO_PATTERNS = [
      /\byou (?:said|mentioned|noted|discussed|talked about|asked about|brought up)\b/i,
      /\bfrom your (?:stored|previous|earlier) conversations?\b/i,
      /\bKYT (?:picked it up|captured|found|retrieved|surfaced)\b/i,
      /\bthat was captured from\b/i,
      /\bfrom (?:a|your) (?:chatgpt|claude) conversation\b/i,
      /\b(?:your |the )?stored (?:data|conversations?|items?|records?|entries|knowledge)\b/i,
      /\b(?:retrieved|stored) (?:items?|entries?) (?:are|is|were) (?:just|only)\b/i,
    ];

    const queryIsAboutKYT = KYT_QUERY_PATTERNS.some(p => p.test(userMessage));
    if (queryIsAboutKYT) {
      console.log('🔧 Meta-conversation penalty SKIPPED: query is about KYT/extension');
    }
    const queryIsAboutRetrieval = RETRIEVAL_QUERY_PATTERNS.some(p => p.test(userMessage));
    if (queryIsAboutRetrieval) {
      console.log('🔬 Diagnostic-content penalty SKIPPED: query is about retrieval analysis');
    }

    for (const item of contextItems) {
      const content = item.content || '';
      const scoreKey = item.cross_encoder_score != null ? 'cross_encoder_score'
                     : item.weighted_score != null ? 'weighted_score'
                     : item.rrf_score != null ? 'rrf_score' : null;

      // Meta-conversation penalty (0.3x) — skipped when query is about KYT
      if (!queryIsAboutKYT && scoreKey && item[scoreKey] != null && KYT_META_PATTERNS.some(p => p.test(content))) {
        const before = item[scoreKey];
        item[scoreKey] *= 0.3;
        console.log(`🔧 Meta-conversation penalty: score ${before.toFixed(3)} → ${item[scoreKey].toFixed(3)} (ID: ${item.id || item.message_id || 'unknown'})`);
      }

      // Retrieval-diagnostic penalty (0.5x) — prevent meta-echo feedback loop
      // Diagnostic conversations share vocabulary with source content ("3 levels", "modes")
      // and outscore it. 0.5x is enough to let source win while keeping diagnostics
      // findable when genuinely queried. Skipped when user asks about retrieval analysis.
      if (!queryIsAboutRetrieval && scoreKey && item[scoreKey] != null
          && RETRIEVAL_DIAGNOSTIC_PATTERNS.some(p => p.test(content))) {
        const before = item[scoreKey];
        item[scoreKey] *= 0.5;
        console.log(`🔬 Diagnostic-content penalty: score ${before.toFixed(3)} → ${item[scoreKey].toFixed(3)} (ID: ${item.id || item.message_id || 'unknown'})`);
      }

      // Echo penalty — assistant messages that echo stored data
      let echoContent = content;
      let echoIsAssistant = item.role === 'assistant';
      if (!echoIsAssistant && content) {
        const asstBlocks = [];
        const echoRe = /(?:^|\n\n)Assistant:\s*([\s\S]*?)(?=\n\nUser:|\s*$)/gi;
        let echoMatch;
        while ((echoMatch = echoRe.exec(content)) !== null) {
          asstBlocks.push(echoMatch[1].trim());
        }
        if (asstBlocks.length > 0) {
          echoContent = asstBlocks.join('\n');
          echoIsAssistant = true;
        } else if (item.role === 'unknown') {
          echoIsAssistant = true;
        }
      }
      if (!scoreKey || item[scoreKey] == null) {
        if (ECHO_PATTERNS.some(p => p.test(echoContent))) {
          console.warn(`⚠️ Echo penalty SKIPPED: no score key available for item (role=${item.role}, id=${item.id || item.message_id || 'unknown'}). Pattern matched but cannot apply penalty.`);
        }
      } else if (echoIsAssistant && ECHO_PATTERNS.some(p => p.test(echoContent))) {
        const before = item[scoreKey];
        const echoLen = echoContent.length;
        const echoPenalty = echoLen < 300 ? 0.50
                          : echoLen < 800 ? 0.70
                          : 0.90;
        item[scoreKey] *= echoPenalty;
        console.log(`🔄 Echo penalty (${echoLen < 300 ? 'short' : echoLen < 800 ? 'medium' : 'long'}): assistant item echoing stored data, score ${before.toFixed(3)} → ${item[scoreKey].toFixed(3)} (${echoLen} chars, ${echoPenalty}x) (ID: ${item.id || item.message_id || 'unknown'})`);
      }
    }

    // Filter by minimum distance/score (client-side double check)
    let filteredItems = contextItems;

    // CONTENT DEDUPLICATION
    const uniqueContent = new Set();
    filteredItems = filteredItems.filter(item => {
      const normalized = item.content.trim().toLowerCase();
      if (uniqueContent.has(normalized)) {
        if (contextConfig.debugMode) console.log(`Start duplicate filtered: ${item.id}`);
        return false;
      }
      uniqueContent.add(normalized);
      return true;
    });

    // Entity-aware recency resolution
    filteredItems = applyRecencyResolution(filteredItems);

    // Apply MMR (Maximal Marginal Relevance) reranking
    if (filteredItems.length > 1) {
      const mmrConfig = contextConfig.mmrPreset || 'DIVERSITY';
      const mmrLambda = 0.5;

      console.log(`🎯 Applying MMR reranking (preset: ${mmrConfig}, λ=${mmrLambda})`);

      filteredItems = applyMMR(
        filteredItems,
        contextConfig.maxContextItems,
        mmrLambda,
        {
          requireEmbeddings: false,
          fallbackToRelevance: true,
          debugMode: contextConfig.debugMode || false,
          boostFunction: (item) => {
            const classification = classifyContent(item.content);
            let boost = 0.0;
            if (classification.type === 'reference_data' && classification.intent === 'explicit_save') {
              boost += 0.25;
            } else if (classification.type === 'instruction') {
              boost += 0.20;
            } else if (classification.type === 'user_preference') {
              boost += 0.15;
            } else if (classification.type === 'factual_note') {
              boost += 0.15;
            }
            if (item.source === 'cli' || item.source === 'terminal') {
              boost += 0.50;
            }
            return boost;
          }
        }
      );

      console.log(`✅ MMR reranking complete: ${filteredItems.length} items selected`);
    }

    // Apply keyword coverage boost
    if (filteredItems.length > 1) {
      console.log(`🎯 Applying keyword boost for query: "${userMessage}"`);
      filteredItems = applyKeywordBoost(userMessage, filteredItems, {
        boostFactor: 0.3,
        debugMode: contextConfig.debugMode || false
      });
      console.log(`✅ Keyword boost complete: candidates re-sorted by boosted scores`);
    }

    // === PRIORITY 2: CONFIDENCE THRESHOLD FILTERING ===
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
        console.log(`🎯 Applying confidence filter (threshold: ${confidenceThreshold}) to ${filteredItems.length} candidates...`);

        const filterResult = filterByConfidence(filteredItems, confidenceThreshold);

        // Log filtering results
        if (filterResult.status === 'success') {
          console.log(`✅ Confidence filter: ${filterResult.results.length}/${filteredItems.length} items passed (highest: ${filterResult.highestScore.toFixed(3)})`);
          filteredItems = filterResult.results;
        } else if (filterResult.status === 'low_confidence') {
          console.warn(`⚠️ Confidence filter: All ${filteredItems.length} items below threshold (highest: ${filterResult.highestScore.toFixed(3)})`);
          if (filterResult.suggestions && contextConfig.debugMode) {
            console.log(`💡 Suggestions:`, filterResult.suggestions);
          }
          // Low-confidence tier: if highest score >= 0.10, keep top 2 items with caveat tag
          if (filterResult.highestScore >= 0.10) {
            console.log(`📋 Low-confidence tier: keeping top 2 items (highest: ${filterResult.highestScore.toFixed(3)})`);
            filteredItems = filteredItems
              .sort((a, b) => {
                const scoreA = a.cross_encoder_score ?? a.weighted_score ?? 0;
                const scoreB = b.cross_encoder_score ?? b.weighted_score ?? 0;
                return scoreB - scoreA;
              })
              .slice(0, 2)
              .map(item => ({ ...item, lowConfidence: true }));
            // Deflection guard: don't rescue deflection items
            filteredItems = filteredItems.filter(item => {
              let checkContent = item.content;
              let checkRole = item.role;
              if (checkRole !== 'assistant' && item.content) {
                const blocks = [];
                const rescueRe = /(?:^|\n\n)Assistant:\s*([\s\S]*?)(?=\n\nUser:|\s*$)/gi;
                let rm;
                while ((rm = rescueRe.exec(item.content)) !== null) blocks.push(rm[1].trim());
                if (blocks.length > 0) { checkContent = blocks.join('\n'); checkRole = 'assistant'; }
                else if (checkRole === 'unknown') checkRole = 'assistant';
              }
              const defl = detectDeflection(checkContent, checkRole);
              if (defl.isDeflection) {
                console.log(`🗑️ Low-confidence rescue: dropped deflection (${defl.reason})`);
                return false;
              }
              return true;
            });
          } else {
            // Below 0.15 — truly irrelevant, drop everything
            filteredItems = [];
          }
        } else {
          // no_results status
          console.log(`ℹ️ Confidence filter: No results to filter`);
          filteredItems = [];
        }

      } catch (error) {
        console.error('❌ Confidence filtering failed, falling back to keyword-boosted results:', error.message);
      }
    }

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
          timestamp: new Date(item.msg_timestamp || item.timestamp).toISOString(),
          similarity: item.cross_encoder_score != null
            ? item.cross_encoder_score
            : item.distance != null
              ? Math.max(0, 1 - item.distance)
              : (item.weighted_score || item.rrf_score || 0.5),
          source_type: item.source || 'conversation'
        })),
        latencyMs: elapsedTime,
        queryType: transformationMetadata.transformed ? 'HYBRID' : 'SEMANTIC',
        queryOriginal: userMessage,
        queryTransformed: transformationMetadata.transformed ? transformationMetadata.optimized : null
      };

      formattedContext = buildMemoryInjection(retrievalResult, {
        debugMode: contextConfig.debugMode || false
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
      transformation: transformationMetadata
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
