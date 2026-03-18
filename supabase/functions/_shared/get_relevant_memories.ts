/**
 * Memory Retrieval Pipeline with Hybrid HyDE
 *
 * Full pipeline:
 * 1. Adaptive Short-Circuit Check (skip HyDE for high-confidence entity matches)
 * 2. Parallel Generation: HyDE document + Entity search
 * 3. Parallel Embedding: HyDE doc + Raw query
 * 4. Parallel Vector Search: Search with both embeddings
 * 5. RRF Merge: Combine results (0.6 HyDE / 0.4 Raw)
 * 6. Rerank → BM25 Boost → Entity Boost → Confidence Filter → Top-5
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { HuggingFaceClient, HFRerankResponse } from "./huggingface-client.ts";
import { AnthropicClient, type ClientContext } from "./anthropic-client.ts";
import { Logger } from "./utils.ts";
import { generateHyDEWithFallback, shouldSkipHyDE } from "./hyde-generator.ts";
import { mergeHydeAndRawResults, fallbackToRawResults, reciprocalRankFusion } from "./rrf.ts";
import { applyQualityPenalties } from "./quality-penalties.ts";
import { deduplicateByContent, applyServerMMR, applyKeywordBoost as applyPostMMRKeywordBoost } from "./mmr.ts";

type Candidate = {
    id: string;
    content: string;
    contextual_content?: string;  // Contextual retrieval: LLM-generated context prefix + raw content
    gravity_score?: number;
    entity_boost?: boolean;
    rrf_score?: number;  // Added by RRF merge
    platform?: string;   // Source platform (gemini, chatgpt, claude, claude-code)
    impact_score?: number;     // Holmes-Rahe: 0-100, from memory-classifier.ts
    intimacy_level?: number;   // Aron's 36 Questions: 0-3, from memory-classifier.ts
};
export type CandidateWithScore = Candidate & { rerank_score: number };

export interface SearchOptions {
    topK?: number;
    useHyde?: boolean;  // Default: true
    hydeWeight?: number;  // Default: 0.6
    fast?: boolean;       // Skip HyDE, reranking, entity search. ~200ms.
    confidenceThreshold?: number; // Override default 0.40 confidence filter
    mmrLambda?: number;   // MMR diversity/relevance trade-off (0.35 for synthesis, 0.5 default)
    recentTopics?: string[];  // Recent topic words for implicit query enrichment
    conversationWindow?: Array<{ role: string; content: string }>;  // Recent messages for coreference resolution
    edgeFunction?: string;  // Source edge function for cost attribution
}

// ========================================================================
// QUERY DECOMPOSITION
// Breaks multi-faceted queries into focused sub-queries for parallel retrieval.
// Only triggers when multi-hop/compound signals detected (regex gate).
// ========================================================================

// ========================================================================
// COREFERENCE RESOLUTION
// Resolves implicit references ("that", "it", "the other one") using
// recent conversation context. Only triggers when conversation window
// is provided AND query contains pronouns/demonstratives with low entity count.
// ========================================================================

const IMPLICIT_SIGNALS = /\b(it|that|this|those|these|them|the other|above|below|same|previous|earlier|last one|the one)\b/i;
const HAS_NAMED_ENTITY = /(?<=[.!?\s]|^)[A-Z][a-z]{2,}(?:\s+[A-Z][a-z]+)+|"[^"]+"|'[^']+'/;
const HAS_TECH_KEYWORD = /\b(?:python|javascript|typescript|rust|react|docker|gemini|chatgpt|claude)\b/i;
const HAS_ENTITIES = { test: (s: string) => HAS_NAMED_ENTITY.test(s) || HAS_TECH_KEYWORD.test(s) };

/**
 * Resolve implicit references in a query using conversation context.
 * Returns the enriched query, or null if no resolution needed/possible.
 */
async function resolveImplicitQuery(
    query: string,
    conversationWindow: Array<{ role: string; content: string }>,
    anthropicApiKey: string,
    requestId?: string,
    context?: ClientContext
): Promise<string | null> {
    if (!conversationWindow || conversationWindow.length === 0) return null;
    if (!IMPLICIT_SIGNALS.test(query)) return null;
    if (HAS_ENTITIES.test(query)) return null; // Already has explicit entities
    if (!anthropicApiKey) return null;

    try {
        const contextStr = conversationWindow
            .map(m => `${m.role}: ${m.content}`)
            .join('\n');

        const client = new AnthropicClient(anthropicApiKey, context);
        const result = await client.generateJsonCompletion<{ resolvedQuery: string; changed: boolean }>(
            `You resolve implicit references in search queries using recent conversation context. Given the conversation window and the query, replace pronouns/demonstratives ("it", "that", "the other one", etc.) with their referents from the conversation. Return JSON: {"resolvedQuery": "the explicit query", "changed": true/false}. If no resolution is needed, return the original query with changed=false.`,
            `Recent conversation:\n${contextStr}\n\nQuery to resolve: "${query}"`,
            { maxTokens: 150, temperature: 0.0, operation: 'coreference_resolution' },
            requestId
        );

        if (result.changed && result.resolvedQuery && result.resolvedQuery !== query) {
            Logger.info(`Coreference resolved: "${query}" → "${result.resolvedQuery}"`, { requestId });
            return result.resolvedQuery;
        }
        return null;
    } catch (e) {
        Logger.warn(`Coreference resolution failed: ${(e as Error).message}`, { requestId });
        return null;
    }
}

// ========================================================================
// QUERY DECOMPOSITION
// ========================================================================

/** Detects queries likely to benefit from decomposition */
const MULTI_HOP_SIGNALS = /\b(compare|contrast|relate|connect|bridge|cross.?reference|vs\.?|versus)\b|\b(what|who|where).*\b(and|then|also)\b.*\b(what|who|where)\b|\b(from|on|in)\s+(gemini|chatgpt|claude)\b.*\b(from|on|in)\s+(gemini|chatgpt|claude)\b/i;

interface DecomposedQuery {
    subQueries: string[];
    reasoning: string;
}

/**
 * Decompose a complex query into focused sub-queries using Haiku.
 * Returns null if decomposition is unnecessary or fails.
 */
async function decomposeQuery(
    query: string,
    anthropicApiKey: string,
    requestId?: string,
    context?: ClientContext
): Promise<DecomposedQuery | null> {
    if (!MULTI_HOP_SIGNALS.test(query)) return null;
    if (!anthropicApiKey) return null;

    try {
        const client = new AnthropicClient(anthropicApiKey, context);
        const result = await client.generateJsonCompletion<DecomposedQuery>(
            `You decompose complex search queries into 2-3 focused sub-queries for a personal conversation memory search system. Each sub-query should target a distinct information need. Return JSON: {"subQueries": ["query1", "query2"], "reasoning": "brief explanation"}. If the query is already focused enough, return {"subQueries": [], "reasoning": "no decomposition needed"}.`,
            `Query: "${query}"`,
            { maxTokens: 200, temperature: 0.0, operation: 'query_decomposition' },
            requestId
        );

        if (result.subQueries && result.subQueries.length >= 2) {
            Logger.info(`Query decomposed into ${result.subQueries.length} sub-queries: ${result.subQueries.join(' | ')}`, { requestId });
            return result;
        }
        return null;
    } catch (e) {
        Logger.warn(`Query decomposition failed: ${(e as Error).message}`, { requestId });
        return null;
    }
}

/**
 * Extract platform mention from a user query (e.g. "on Gemini" → "gemini").
 * Ported from src/context-retrieval.js — keep in sync.
 */
function extractPlatformMention(message: string): string | null {
    const m = message.match(/\b(notebooklm|notebook\s*lm|gemini|chatgpt|claude[- ]code|claude)\b/i);
    if (!m) return null;
    return m[1].toLowerCase().replace(/\s+/g, '-');
}

/**
 * Apply platform-mismatch penalty to reranked results (Gap 3).
 * When user asks about a specific platform, penalize items from other platforms.
 * Mutates the array in place: re-sorts and removes items below threshold.
 */
function applyPlatformPenalty(
    query: string,
    results: CandidateWithScore[],
    confidenceThreshold?: number,
    requestId?: string,
): void {
    const targetPlatform = extractPlatformMention(query);
    if (!targetPlatform || results.length === 0) return;

    for (const c of results) {
        if (c.platform && c.platform !== targetPlatform) {
            c.rerank_score *= 0.3;
        }
    }
    // Re-sort after penalty
    results.sort((a, b) => b.rerank_score - a.rerank_score);
    // Remove items that dropped below threshold
    const threshold = confidenceThreshold ?? 0.40;
    while (results.length > 0 && results[results.length - 1].rerank_score < threshold) {
        results.pop();
    }
    Logger.info(`Platform-mismatch penalty applied for target="${targetPlatform}"`, { requestId });
}

/**
 * Filter self-referential results — retrieved content that echoes the query
 * provides no new information and causes circular retrieval.
 * Targets short content (<80 chars) with >70% word overlap with the query.
 */
function filterQueryEchoes(query: string, candidates: Candidate[]): Candidate[] {
    const ECHO_STOP = new Set([
        'the','and','for','with','from','that','this','have','has','what','when',
        'where','which','who','how','why','are','was','were','been','being','can',
        'could','should','would','will','not','but','about','into','than','then',
        'them','they','your','you','our','its','his','her','their','does','did',
        'top','best','most','need','needs','want','use','like','just','also',
        'some','any','all','each','every','tell','know','think','make','take',
    ]);
    const queryNorm = query.toLowerCase().replace(/[^\w\s]/g, '').trim();
    const queryWords = new Set(queryNorm.split(/\s+/).filter(w => w.length > 2 && !ECHO_STOP.has(w)));
    if (queryWords.size === 0) return candidates;

    return candidates.filter(c => {
        const contentNorm = (c.content || '').toLowerCase().replace(/[^\w\s]/g, '').trim();
        const contentWords = new Set(contentNorm.split(/\s+/).filter(w => w.length > 2 && !ECHO_STOP.has(w)));
        if (contentWords.size < 3) return true; // too few content words for reliable echo detection

        if (contentNorm.length < 80) {
            // Short content: high overlap = echo (user prompt re-captured)
            const overlap = [...queryWords].filter(w => contentWords.has(w)).length;
            const overlapRatio = overlap / Math.max(queryWords.size, 1);
            if (overlapRatio > 0.7) return false;
        } else {
            // Long content: check if it contains the verbatim query as a substring.
            // This catches assistant responses that quote/discuss the query itself
            // (meta-echo: "You asked about X" → captured → retrieved for query "X").
            if (queryNorm.length >= 10 && contentNorm.includes(queryNorm)) {
                return false;
            }
        }
        return true;
    });
}

/** Simple BM25-style keyword boost (max 30% of score) */
function applyBm25Boost(query: string, items: CandidateWithScore[]): CandidateWithScore[] {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return items;

    const bm25Scores = items.map((item) => {
        // Use contextual_content for BM25 boost — richer text includes topic keywords
        const txt = ((item as any).contextual_content || item.content).toLowerCase();
        let score = 0;
        for (const term of terms) {
            const matches = txt.match(new RegExp(`\\b${term}\\b`, "g")) ?? [];
            score += matches.length;
        }
        return score;
    });

    const maxScore = Math.max(...bm25Scores, 1);
    return items.map((item, i) => {
        let boost = (0.3 * bm25Scores[i]) / maxScore;

        // Apply Entity Boost (0.1) if present
        if (item.entity_boost) {
            boost += 0.1;
        }

        return {
            ...item,
            rerank_score: item.rerank_score + boost,
        };
    });
}

/**
 * Perform vector search with a given embedding
 */
async function vectorSearch(
    supabase: any,
    embedding: number[],
    userId: string,
    boostEntityIds: string[],
    topK: number,
    requestId?: string,
    profileId?: string,
    projectId?: string
): Promise<Candidate[]> {
    const { data, error } = await supabase
        .rpc("match_messages_with_gravity", {
            query_embedding: embedding,
            match_threshold: 0.5,
            match_count: topK,
            exclude_recent_seconds: 120,
            p_user_id: userId,
            boost_entity_ids: boostEntityIds,
            p_profile_id: profileId,
            p_project_id: projectId || null
        });

    if (error) {
        Logger.error("Vector search RPC error", { requestId, error: error.message });
        throw new Error(`RPC Error: ${error.message}`);
    }

    return (data as Candidate[]) || [];
}

/**
 * Search for entities matching the query embedding, with text fallback
 */
// Concept synonym expansion for server-side entity text search
// Maps vague referential terms → domain-specific equivalents
const CONCEPT_SYNONYMS: Record<string, string[]> = {
    'nfl': ['football', 'player', 'quarterback'],
    'football': ['nfl', 'player'],
    'player': ['athlete'], 'players': ['athletes'],
    'weight': ['diet', 'fitness', 'kg'],
    'diet': ['weight', 'nutrition'],
    'fitness': ['exercise', 'workout'],
    'goal': ['target', 'objective'], 'goals': ['targets', 'objectives'],
    'book': ['reading', 'author'], 'books': ['reading', 'authors'],
    'level': ['mode', 'tier'], 'levels': ['modes', 'tiers'],
    'tier': ['mode', 'level'], 'tiers': ['modes', 'levels'],
};

/**
 * Load dynamic synonyms from entity_relationships with high co-occurrence.
 * Cached per-request (called once at pipeline start, reused for all expansions).
 */
async function loadDynamicSynonyms(
    supabase: any,
    userId: string,
    requestId?: string
): Promise<Record<string, string[]>> {
    try {
        const { data, error } = await supabase
            .from('entity_relationships')
            .select(`
                entity_id_1,
                entity_id_2,
                relationship_strength,
                entity1:entities!entity_relationships_entity_id_1_fkey(canonical_name),
                entity2:entities!entity_relationships_entity_id_2_fkey(canonical_name)
            `)
            .gte('relationship_strength', 0.7)
            .limit(50);

        if (error || !data) return {};

        const synonyms: Record<string, string[]> = {};
        for (const row of data) {
            const name1 = (row.entity1 as any)?.canonical_name?.toLowerCase();
            const name2 = (row.entity2 as any)?.canonical_name?.toLowerCase();
            if (!name1 || !name2 || name1 === name2) continue;

            if (!synonyms[name1]) synonyms[name1] = [];
            if (!synonyms[name2]) synonyms[name2] = [];
            if (!synonyms[name1].includes(name2)) synonyms[name1].push(name2);
            if (!synonyms[name2].includes(name1)) synonyms[name2].push(name1);
        }

        const count = Object.keys(synonyms).length;
        if (count > 0) {
            Logger.info(`Dynamic synonyms loaded: ${count} entries`, { requestId });
        }
        return synonyms;
    } catch (e) {
        Logger.warn(`Dynamic synonym load failed: ${(e as Error).message}`, { requestId });
        return {};
    }
}

function expandQueryWithSynonyms(query: string, dynamicSynonyms?: Record<string, string[]>): string {
    const words = query.toLowerCase().split(/\s+/);
    const expansions: string[] = [];
    for (const word of words) {
        // Check static synonyms first
        const synonyms = CONCEPT_SYNONYMS[word];
        if (synonyms) expansions.push(...synonyms);
        // Check dynamic synonyms from entity co-occurrences
        if (dynamicSynonyms) {
            const dynSyns = dynamicSynonyms[word];
            if (dynSyns) expansions.push(...dynSyns);
        }
    }
    return expansions.length > 0 ? query + ' ' + [...new Set(expansions)].join(' ') : query;
}

async function searchEntities(
    supabase: any,
    embedding: number[],
    userId: string,
    queryText: string,
    requestId?: string,
    profileId?: string,
    dynamicSynonyms?: Record<string, string[]>,
    projectId?: string
): Promise<{ ids: string[]; entities: any[] }> {
    // Run embedding and text search in PARALLEL (Gap 2: entity bridging)
    // Text search always runs — catches entities that embedding similarity misses
    // (e.g., "NFL" has no vector similarity to "Walter Payton")
    const expandedQuery = expandQueryWithSynonyms(queryText, dynamicSynonyms);

    const [embeddingResult, textResult] = await Promise.allSettled([
        supabase.rpc("search_entities_by_embedding", {
            query_embedding: embedding,
            match_threshold: 0.8,
            match_count: 5,
            p_user_id: userId,
            p_profile_id: profileId,
            p_project_id: projectId || null
        }),
        supabase.rpc("search_entities_by_text", {
            p_query_text: expandedQuery,
            p_user_id: userId,
            p_match_count: 5,
            p_profile_id: profileId,
            p_project_id: projectId || null
        }),
    ]);

    const embeddingEntities = embeddingResult.status === 'fulfilled' && !embeddingResult.value.error
        ? (embeddingResult.value.data || [])
        : [];
    const textEntities = textResult.status === 'fulfilled' && !textResult.value.error
        ? (textResult.value.data || [])
        : [];

    if (embeddingResult.status === 'rejected' || (embeddingResult.status === 'fulfilled' && embeddingResult.value.error)) {
        const errMsg = embeddingResult.status === 'rejected' ? embeddingResult.reason?.message : embeddingResult.value.error?.message;
        Logger.warn("Entity embedding search failed", { requestId, error: errMsg });
    }
    if (textResult.status === 'rejected' || (textResult.status === 'fulfilled' && textResult.value.error)) {
        const errMsg = textResult.status === 'rejected' ? textResult.reason?.message : textResult.value.error?.message;
        Logger.warn("Entity text search failed", { requestId, error: errMsg });
    }

    // Merge unique by id (embedding results first — higher confidence)
    const seenIds = new Set<string>();
    const merged: any[] = [];
    for (const e of [...embeddingEntities, ...textEntities]) {
        if (!seenIds.has(e.id)) {
            seenIds.add(e.id);
            merged.push(e);
        }
    }

    const ids = merged.map((e: any) => e.id);
    if (ids.length > 0) {
        Logger.info(`Found ${ids.length} entities (${embeddingEntities.length} embedding + ${textEntities.length} text, ${ids.length} unique)`, { requestId });
    }
    if (expandedQuery !== queryText) {
        Logger.info(`Entity query expanded: "${queryText}" → "${expandedQuery}"`, { requestId });
    }

    return { ids, entities: merged };
}

// ==========================================================================
// PREFERENCE QUERY ROUTER
// Regex classifier that detects preference queries and short-circuits the
// vector pipeline. 0ms cost — runs before any embedding generation.
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
function detectPreferenceQuery(query: string): string | null {
    const q = query.toLowerCase().trim()
        .replace(/what's/g, 'what is');

    const patterns: RegExp[] = [
        // Pattern 1: "what is my favorite car"
        /(?:what)\s+(?:is|are|was|were)\s+my\s+(?:favorite|favourite|preferred|go-to)\s+(.+?)(?:\?|$)/,
        // Pattern 6: "what kind of food do i like" — BEFORE Pattern 2 (more specific)
        /what\s+(?:kind|type|sort)\s+of\s+(.+?)\s+(?:do|did|does|would)\s+i\s+(?:like|prefer|love|enjoy)(?:\?|$)/,
        // Pattern 2: "what car do i like"
        /what\s+(.+?)\s+(?:do|did|does|would)\s+i\s+(?:like|prefer|love|enjoy|use)(?:\?|$)/,
        // Pattern 3: "tell me my favorite car" / "remind me about my preferred food"
        /(?:tell|remind)\s+me\s+(?:about\s+)?my\s+(?:favorite|favourite|preferred|go-to)\s+(.+?)(?:\?|$)/,
        // Pattern 4: "do i like Python" (value-based)
        /(?:do|did|does)\s+i\s+(?:like|prefer|love|enjoy)\s+(.+?)(?:\?|$)/,
        // Pattern 5: "which car is my favorite"
        /which\s+(.+?)\s+(?:is|are|was|were)\s+my\s+(?:favorite|favourite|preferred|go-to)(?:\?|$)/,
    ];

    for (const pattern of patterns) {
        const match = q.match(pattern);
        if (match && match[1]) {
            // Clean up the extracted category
            const category = match[1]
                .replace(/[?.!,]/g, '')
                .trim();
            if (category.length > 0 && category.length < 50) {
                return category;
            }
        }
    }

    return null;
}

/**
 * Look up user preferences and convert to CandidateWithScore format.
 * Synthesizes content from preference fields — the table is the source of truth.
 */
async function lookupPreferencesAsCandidates(
    supabase: any,
    userId: string,
    category: string,
    requestId?: string,
    profileId?: string,
    projectId?: string
): Promise<CandidateWithScore[]> {
    const { data, error } = await supabase
        .rpc("lookup_user_preferences", {
            p_user_id: userId,
            p_category: category,
            p_limit: 10,
            p_profile_id: profileId,
            p_project_id: projectId || null
        });

    if (error) {
        Logger.warn("Preference lookup RPC failed", { requestId, error: error.message });
        return [];
    }

    if (!data || data.length === 0) return [];

    Logger.info(`Preference router: ${data.length} preferences found for "${category}"`, { requestId });

    return data.map((pref: any) => {
        // Synthesize content from structured preference data
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
            rerank_score: pref.confidence * 0.9,  // 0.8 * 0.9 = 0.72 (above 0.40 threshold)
            preference_match: true,
        } as CandidateWithScore;
    });
}

/**
 * Detect CONCEPT/ANALOGY/THEME entities matching the query via text search.
 * Short-circuits the embedding similarity problem: "walking analogy" maps directly
 * to a CONCEPT/ANALOGY entity via trigram matching, bypassing vector distance.
 */
async function detectConceptEntities(
    supabase: any,
    query: string,
    userId: string,
    requestId?: string,
    profileId?: string,
    projectId?: string
): Promise<string[]> {
    const conceptTypes = new Set(["CONCEPT", "ANALOGY", "THEME", "TOPIC"]);

    try {
        const { data: textEntities, error } = await supabase
            .rpc("search_entities_by_text", {
                p_query_text: query,
                p_user_id: userId,
                p_match_count: 10,  // Fetch more, filter to concepts
                p_profile_id: profileId,
                p_project_id: projectId || null
            });

        if (error) {
            Logger.warn("Concept detection text search failed", { requestId, error: error.message });
            return [];
        }

        if (!textEntities || textEntities.length === 0) return [];

        // Filter to CONCEPT/ANALOGY/THEME types only
        const conceptEntities = textEntities.filter((e: any) => conceptTypes.has(e.entity_type));

        if (conceptEntities.length > 0) {
            Logger.info(`Concept detection: found ${conceptEntities.length} concept entities`, {
                requestId,
                concepts: conceptEntities.map((e: any) => `${e.canonical_name} (${e.entity_type})`).join(", ")
            });
        }

        return conceptEntities.map((e: any) => e.id);
    } catch (e) {
        Logger.warn(`Concept detection error: ${(e as Error).message}`, { requestId });
        return [];
    }
}

/**
 * Retrieve relevant memories for a query.
 *
 * Implements Hybrid HyDE: generates hypothetical document + uses raw query,
 * searches with both, merges results via Reciprocal Rank Fusion.
 *
 * @param query - Search query
 * @param userId - User ID for RLS
 * @param options - Search options (topK, useHyde, hydeWeight)
 * @param requestId - Request ID for tracing
 */
export async function getRelevantMemories(
    queryInput: string,
    userId: string,
    optionsOrTopK: SearchOptions | number = {},
    requestId?: string,
    profileId?: string,
    projectId?: string
): Promise<CandidateWithScore[]> {
    // Handle legacy signature (topK as number)
    const options: SearchOptions = typeof optionsOrTopK === "number"
        ? { topK: optionsOrTopK }
        : optionsOrTopK;

    const {
        topK = 20,
        useHyde = true,
        hydeWeight = 0.6,
        fast = false,
        confidenceThreshold,
        mmrLambda = 0.5,
        recentTopics,
        conversationWindow,
        edgeFunction,
    } = options;

    // Build cost attribution context once, pass to all clients
    const costContext: ClientContext = { userId, edgeFunction };

    // MVP: profileId = userId (1:1). Future: multi-profile adds junction table.
    const resolvedProfileId = profileId || userId;

    // Mutable query — may be enriched by coreference resolution
    let query = queryInput;

    // Vector search retrieval pool — always fetch at least 20 candidates for reranking,
    // even if client requests fewer items back. More candidates = better reranking quality.
    const vectorSearchCount = Math.max(topK, 20);

    // Initialize clients lazily
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const hfApiKey = Deno.env.get("HUGGINGFACE_API_KEY")!;
    const anthropicApiKey = Deno.env.get("ANTHROPIC_API_KEY");  // Optional for HyDE

    if (!supabaseUrl || !supabaseServiceKey || !hfApiKey) {
        throw new Error("Missing required environment variables");
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey);
    const hfClient = new HuggingFaceClient(hfApiKey, costContext);

    // ========================================================================
    // STEP 0: Preference Query Router (0ms regex, before any embedding)
    // Short-circuits the entire vector pipeline for "what is my favorite X?"
    // ========================================================================
    const prefCategory = detectPreferenceQuery(query);
    if (prefCategory) {
        Logger.info(`Preference router activated: category="${prefCategory}"`, { requestId });
        const prefResults = await lookupPreferencesAsCandidates(supabase, userId, prefCategory, requestId, resolvedProfileId, projectId);
        if (prefResults.length > 0) {
            Logger.info(`Preference router: returning ${prefResults.length} results (short-circuit)`, { requestId });
            return prefResults;
        }
        Logger.info("Preference router: no preferences found, falling through to vector pipeline", { requestId });
    }

    // ========================================================================
    // STEP 0.3: Coreference Resolution (implicit query enrichment)
    // Resolves "it", "that", "the other one" using conversation window.
    // ========================================================================
    if (conversationWindow && conversationWindow.length > 0 && anthropicApiKey && !fast) {
        const corefStart = performance.now();
        const resolvedQuery = await resolveImplicitQuery(query, conversationWindow, anthropicApiKey, requestId, costContext);
        const corefMs = Math.round(performance.now() - corefStart);
        Logger.info(`Coreference resolution: ${corefMs}ms`, { requestId });
        if (resolvedQuery) {
            query = resolvedQuery;
        }
    }

    Logger.info("Starting memory retrieval", {
        requestId,
        queryLength: query.length,
        useHyde,
        hydeWeight
    });

    // ========================================================================
    // STEP 0.5: Query Decomposition (multi-hop/compound queries)
    // If the query contains comparison/multi-hop signals, decompose into
    // sub-queries, run parallel retrievals, and merge results.
    // ========================================================================
    if (!fast && anthropicApiKey && !(options as any)._skipDecomposition) {
        const decompStart = performance.now();
        const decomposition = await decomposeQuery(query, anthropicApiKey, requestId, costContext);
        const decompMs = Math.round(performance.now() - decompStart);
        Logger.info(`Query decomposition: ${decompMs}ms`, { requestId });
        if (decomposition && decomposition.subQueries.length >= 2) {
            // Run parallel retrievals for each sub-query (without decomposition to avoid recursion)
            const subOptions: SearchOptions = {
                topK: Math.max(topK, 10),
                useHyde,
                hydeWeight,
                fast: false,
                confidenceThreshold,
                mmrLambda,
                // No recentTopics or decomposition for sub-queries
            };

            const subResults = await Promise.all(
                decomposition.subQueries.map(sq =>
                    getRelevantMemories(sq, userId, { ...subOptions, _skipDecomposition: true } as any, requestId, profileId)
                )
            );

            // Merge sub-query results via RRF
            const rankedLists = subResults
                .filter(r => r.length > 0)
                .map((results, i) => ({
                    results: results as Candidate[],
                    weight: 1.0 / decomposition.subQueries.length,
                }));

            if (rankedLists.length > 0) {
                const fused = reciprocalRankFusion(rankedLists, 60, topK * 2);
                const merged: CandidateWithScore[] = fused.map(fr => ({
                    ...(fr.item as CandidateWithScore),
                    rrf_score: fr.rrf_score,
                    rerank_score: (fr.item as CandidateWithScore).rerank_score ?? fr.rrf_score,
                }));

                // Dedup, apply platform penalty, slice to topK
                const deduped = deduplicateByContent(merged);
                applyPlatformPenalty(query, deduped, confidenceThreshold, requestId);
                const final = deduped.slice(0, topK);

                Logger.info(`Decomposition merge: ${subResults.map(r => r.length).join('+')} → ${final.length} results`, { requestId });
                return final;
            }
            // If all sub-queries returned empty, fall through to normal pipeline
            Logger.info("Decomposition returned no results, falling through to standard pipeline", { requestId });
        }
    }

    // ========================================================================
    // STEP 1: Generate raw query embedding (always needed)
    // ========================================================================
    const rawEmbedding = (await hfClient.generateEmbeddings(query, requestId))[0];

    // ========================================================================
    // FAST PATH: embed → single vector search → BM25 → confidence filter
    // Skips HyDE (2-4s), entity search (100-200ms), reranking (2-4s),
    // graph walk (100-200ms), entity enrichment (50-100ms).
    // Target: <300ms total.
    // ========================================================================
    if (fast) {
        Logger.info("Fast path activated", { requestId });

        const fastCandidates = await vectorSearch(
            supabase, rawEmbedding, userId, [],
            Math.max(topK, 10),
            requestId, resolvedProfileId, projectId
        );

        const echoFiltered = filterQueryEchoes(query, fastCandidates);

        const scored: CandidateWithScore[] = echoFiltered.map(c => ({
            ...c,
            rerank_score: c.gravity_score ?? 0.5,
        }));
        const boosted = applyBm25Boost(query, scored);

        // Apply quality penalties (fast path gets them too)
        const penalized = applyQualityPenalties(boosted, { query, requestId });

        const threshold = confidenceThreshold ?? 0.40;
        const filtered = penalized
            .filter(c => c.rerank_score >= threshold)
            .slice(0, topK);

        Logger.info("Fast path complete", {
            requestId,
            candidates: fastCandidates.length,
            returned: filtered.length,
            threshold,
        });

        return filtered;
    }

    // ========================================================================
    // STEP 2: PARALLEL - Entity search + HyDE generation + Concept detection
    // ========================================================================
    // Enrich entity search query with recent topics for vague/implicit queries
    const entitySearchQuery = recentTopics && recentTopics.length > 0
        ? query + ' ' + recentTopics.join(' ')
        : query;
    if (recentTopics && recentTopics.length > 0) {
        Logger.info(`Recent topic enrichment: "${query}" + [${recentTopics.join(', ')}]`, { requestId });
    }

    // Load dynamic synonyms from entity co-occurrences (parallel with other init)
    const dynamicSynonyms = await loadDynamicSynonyms(supabase, userId, requestId);

    const [entityResult, hydeResult, conceptEntityIds] = await Promise.all([
        searchEntities(supabase, rawEmbedding, userId, entitySearchQuery, requestId, resolvedProfileId, dynamicSynonyms, projectId),
        useHyde && anthropicApiKey
            ? generateHyDEWithFallback(query, anthropicApiKey, requestId, costContext)
            : Promise.resolve({ hydeDoc: null, usedHyde: false }),
        detectConceptEntities(supabase, query, userId, requestId, resolvedProfileId, projectId)
    ]);

    const { ids: embeddingEntityIds, entities } = entityResult;
    const { hydeDoc, usedHyde } = hydeResult;

    // Merge concept entity IDs into boost set (deduped)
    const boostEntityIdSet = new Set([...embeddingEntityIds, ...conceptEntityIds]);

    // When query mentions a platform name (e.g. "Gemini"), exclude entities whose
    // text matches the platform name — they're filters, not topics. Otherwise
    // "Gemini" entity (87 mentions, all claude-code dev talk) dominates the boost
    // and drowns out the actual topic entities like "Walter Payton".
    const queryTargetPlatform = extractPlatformMention(query);
    if (queryTargetPlatform) {
        const platformNames = new Set([queryTargetPlatform, queryTargetPlatform.replace('-', ' ')]);
        for (const entity of entities) {
            const entityText = ((entity as any).entity_text || '').toLowerCase();
            if (platformNames.has(entityText)) {
                boostEntityIdSet.delete(entity.id);
            }
        }
        if (boostEntityIdSet.size < embeddingEntityIds.length + conceptEntityIds.length) {
            Logger.info(`Excluded platform entity from boost (target="${queryTargetPlatform}")`, { requestId });
        }
    }

    const boostEntityIds = Array.from(boostEntityIdSet);

    // ========================================================================
    // STEP 2b: Graph Walk (if entities found)
    // Traverse entity_relationships to find conceptually related chat_turns
    // ========================================================================
    let graphResults: Candidate[] = [];
    if (boostEntityIds.length > 0) {
        try {
            const { data, error } = await supabase.rpc('graph_walk_from_entities', {
                p_entity_ids: boostEntityIds,
                p_user_id: userId,
                p_max_results: vectorSearchCount,
                p_max_depth: 3,
                p_max_intermediate: 20,
                p_profile_id: resolvedProfileId,
                p_project_id: projectId || null
            });
            if (error) {
                Logger.warn("Graph walk RPC failed", { requestId, error: error.message });
            } else if (data && data.length > 0) {
                graphResults = data.map((item: any) => ({
                    id: item.chat_turn_id,
                    content: item.content,
                    contextual_content: item.contextual_content || undefined,
                    gravity_score: item.relationship_strength,
                    entity_boost: true
                }));
                Logger.info(`Graph walk: ${graphResults.length} results from entity traversal`, { requestId });
            }
        } catch (e) {
            Logger.warn(`Graph walk error: ${(e as Error).message}`, { requestId });
        }
    }

    // ========================================================================
    // STEP 3: Adaptive Short-Circuit Check
    // If high-confidence entity match, skip HyDE and use raw query only
    // ========================================================================
    // Exclude platform-name entities from confidence check — they shouldn't
    // trigger the HyDE short-circuit (platform = filter, not topic)
    const platformNames = queryTargetPlatform
        ? new Set([queryTargetPlatform, queryTargetPlatform.replace('-', ' ')])
        : new Set<string>();
    const topicEntities = entities.filter((e: any) =>
        !platformNames.has(((e as any).entity_text || '').toLowerCase())
    );
    const entityConfidences = topicEntities.map((e: any) => ({
        confidence: e.similarity || 0,
        entity_type: e.entity_type
    }));

    if (shouldSkipHyDE(entityConfidences, 0.85)) {
        Logger.info("Short-circuiting HyDE: high-confidence entity match", {
            requestId,
            topEntityConfidence: entityConfidences[0]?.confidence
        });

        // Single vector search with raw query + graph results
        const vectorCandidates = await vectorSearch(
            supabase, rawEmbedding, userId, boostEntityIds, vectorSearchCount, requestId, resolvedProfileId, projectId
        );

        // Merge vector + graph candidates, dedup by id
        const seen = new Set<string>();
        const candidates: Candidate[] = [];
        for (const c of [...vectorCandidates, ...graphResults]) {
            if (!seen.has(c.id)) {
                seen.add(c.id);
                candidates.push(c);
            }
        }

        const scFiltered = filterQueryEchoes(query, candidates);
        let shortCircuitResults = await rerankAndFilter(query, scFiltered, hfClient, requestId, topK, confidenceThreshold ?? 0.4);

        // Apply quality penalties AFTER reranking, BEFORE MMR
        shortCircuitResults = applyQualityPenalties(shortCircuitResults, { query, requestId });

        // Content dedup → MMR → Keyword boost
        shortCircuitResults = deduplicateByContent(shortCircuitResults);
        if (shortCircuitResults.length > 1) {
            shortCircuitResults = applyServerMMR(shortCircuitResults, { lambda: mmrLambda, maxResults: topK, requestId });
            shortCircuitResults = applyPostMMRKeywordBoost(query, shortCircuitResults);
        }

        applyPlatformPenalty(query, shortCircuitResults, confidenceThreshold, requestId);

        // Platform-filtered rescue for short-circuit path
        if (shortCircuitResults.length === 0 && queryTargetPlatform) {
            Logger.info(`Platform rescue (SC): searching within "${queryTargetPlatform}" only`, { requestId });
            const { data: rescueData, error: rescueError } = await supabase
                .rpc("match_messages_with_gravity", {
                    query_embedding: rawEmbedding,
                    match_threshold: 0.35,
                    match_count: topK,
                    exclude_recent_seconds: 120,
                    p_user_id: userId,
                    boost_entity_ids: boostEntityIds,
                    p_profile_id: resolvedProfileId,
                    p_platform: queryTargetPlatform,
                    p_project_id: projectId || null,
                });
            if (!rescueError && rescueData && rescueData.length > 0) {
                const rescueCandidates = rescueData as Candidate[];
                const rescueFiltered = filterQueryEchoes(query, rescueCandidates);
                const rescueResults = await rerankAndFilter(query, rescueFiltered, hfClient, requestId, topK);
                shortCircuitResults.push(...rescueResults);
                Logger.info(`Platform rescue (SC): recovered ${rescueResults.length} items`, { requestId });
            }
        }

        await enrichWithEntities(supabase, shortCircuitResults, requestId);
        return shortCircuitResults;
    }

    // ========================================================================
    // STEP 4: PARALLEL Vector Search (HyDE + Raw)
    // ========================================================================
    let hydeEmbedding: number[] | null = null;

    if (usedHyde && hydeDoc) {
        // Generate HyDE embedding
        hydeEmbedding = (await hfClient.generateEmbeddings(hydeDoc, requestId))[0];

        // HyDE confidence gate: if HyDE embedding drifted too far from raw query,
        // discard it to prevent hallucination-driven retrieval.
        // Cosine similarity threshold: 0.3 (very lenient — only catches wild hallucinations)
        const dotProduct = rawEmbedding.reduce((sum, v, i) => sum + v * (hydeEmbedding![i] || 0), 0);
        const magRaw = Math.sqrt(rawEmbedding.reduce((sum, v) => sum + v * v, 0));
        const magHyde = Math.sqrt(hydeEmbedding.reduce((sum, v) => sum + v * v, 0));
        const cosineSim = magRaw > 0 && magHyde > 0 ? dotProduct / (magRaw * magHyde) : 0;

        if (cosineSim < 0.3) {
            Logger.warn(`HyDE confidence gate: discarding HyDE (similarity=${cosineSim.toFixed(3)} < 0.3)`, { requestId });
            hydeEmbedding = null;
        } else {
            Logger.info(`HyDE confidence: similarity=${cosineSim.toFixed(3)} (OK)`, { requestId });
        }
    }

    // Parallel vector searches
    const searchPromises: Promise<Candidate[]>[] = [
        vectorSearch(supabase, rawEmbedding, userId, boostEntityIds, vectorSearchCount, requestId, resolvedProfileId, projectId)
    ];

    if (hydeEmbedding) {
        searchPromises.push(
            vectorSearch(supabase, hydeEmbedding, userId, boostEntityIds, vectorSearchCount, requestId, resolvedProfileId, projectId)
        );
    }

    const searchResults = await Promise.all(searchPromises);
    const rawResults = searchResults[0];
    const hydeResults = searchResults[1] || [];

    // ========================================================================
    // STEP 5: RRF Merge (HyDE + Raw + Graph)
    // ========================================================================
    let candidates: Candidate[];

    if (hydeResults.length > 0) {
        if (graphResults.length > 0) {
            // 3-way RRF merge via reciprocalRankFusion()
            // Weights: HyDE 0.48, Raw 0.32, Graph 0.20 (graph carves out 20%)
            const graphWeight = 0.2;
            const adjustedHydeWeight = hydeWeight * (1 - graphWeight);  // 0.6 * 0.8 = 0.48
            const adjustedRawWeight = (1 - hydeWeight) * (1 - graphWeight);  // 0.4 * 0.8 = 0.32

            // Sort graph results by gravity_score descending for proper RRF ranking
            const sortedGraph = [...graphResults].sort(
                (a, b) => (b.gravity_score ?? 0) - (a.gravity_score ?? 0)
            );

            const fusedResults = reciprocalRankFusion([
                { results: hydeResults, weight: adjustedHydeWeight },
                { results: rawResults, weight: adjustedRawWeight },
                { results: sortedGraph, weight: graphWeight },
            ], 60, vectorSearchCount);

            candidates = fusedResults.map(fr => ({
                ...fr.item,
                rrf_score: fr.rrf_score,
            }));

            Logger.info("3-way RRF merge: HyDE + Raw + Graph", {
                requestId,
                hydeCount: hydeResults.length,
                rawCount: rawResults.length,
                graphCount: graphResults.length,
                mergedCount: candidates.length
            });
        } else {
            candidates = mergeHydeAndRawResults(hydeResults, rawResults, hydeWeight, requestId);
            Logger.info("Merged HyDE and raw results", {
                requestId,
                hydeCount: hydeResults.length,
                rawCount: rawResults.length,
                mergedCount: candidates.length
            });
        }
    } else {
        candidates = fallbackToRawResults(rawResults, requestId);

        // Even without HyDE, 2-way RRF with graph results
        if (graphResults.length > 0) {
            const sortedGraph = [...graphResults].sort(
                (a, b) => (b.gravity_score ?? 0) - (a.gravity_score ?? 0)
            );
            const fusedResults = reciprocalRankFusion([
                { results: candidates, weight: 0.8 },
                { results: sortedGraph, weight: 0.2 },
            ], 60, vectorSearchCount);
            candidates = fusedResults.map(fr => ({
                ...fr.item,
                rrf_score: fr.rrf_score,
            }));
            Logger.info("2-way RRF merge: Raw + Graph", {
                requestId,
                rawCount: rawResults.length,
                graphCount: graphResults.length,
                mergedCount: candidates.length
            });
        }
    }

    // ========================================================================
    // STEP 5b: Entity Timeline Guarantee
    // For each entity in the results, ensure the newest chat_turn mentioning it
    // is in the candidate pool. Prevents semantic search bias toward rich/long
    // content from hiding short factual corrections (the "Jerry problem").
    // ========================================================================
    if (boostEntityIds.length > 0) {
        try {
            const existingTurnIds = candidates.map(c => c.id).filter(Boolean);
            const { data: newestTurns, error: timelineError } = await supabase
                .rpc("get_newest_turns_for_entities", {
                    p_entity_ids: boostEntityIds,
                    p_user_id: userId,
                    p_exclude_turn_ids: existingTurnIds,
                    p_max_per_entity: 1,
                    p_profile_id: resolvedProfileId,
                    p_project_id: projectId || null
                });

            if (timelineError) {
                Logger.warn("Entity timeline guarantee RPC failed", {
                    requestId,
                    error: timelineError.message
                });
            } else if (newestTurns && newestTurns.length > 0) {
                // Add newest entity mentions as candidates with entity_boost flag
                const seenIds = new Set(candidates.map(c => c.id));
                let injected = 0;
                for (const turn of newestTurns) {
                    if (!seenIds.has(turn.chat_turn_id)) {
                        seenIds.add(turn.chat_turn_id);
                        candidates.push({
                            id: turn.chat_turn_id,
                            content: turn.content,
                            contextual_content: turn.contextual_content || undefined,
                            entity_boost: true,
                            // Tag with entity data for client-side recency resolution
                            entity_timeline: {
                                entity_id: turn.entity_id,
                                canonical_name: turn.canonical_name,
                                entity_type: turn.entity_type,
                                created_at: turn.created_at
                            }
                        } as any);
                        injected++;
                    }
                }
                if (injected > 0) {
                    Logger.info(`Entity timeline: injected ${injected} newest mentions into candidate pool`, {
                        requestId,
                        entities: newestTurns.map((t: any) => t.canonical_name).join(", ")
                    });
                }
            }
        } catch (e) {
            Logger.warn(`Entity timeline guarantee error: ${(e as Error).message}`, { requestId });
        }
    }

    // ========================================================================
    // STEP 5c: Filter self-referential query echoes
    // Short content that just repeats the search query provides no new info
    // ========================================================================
    const echoFiltered = filterQueryEchoes(query, candidates);
    if (echoFiltered.length < candidates.length) {
        Logger.info(`Query echo filter: removed ${candidates.length - echoFiltered.length} echo candidates`, { requestId });
    }

    // ========================================================================
    // STEP 6: Rerank, BM25 Boost, Confidence Filter
    // ========================================================================
    let results = await rerankAndFilter(query, echoFiltered, hfClient, requestId, topK, confidenceThreshold ?? 0.4);

    // ========================================================================
    // STEP 6b: Quality penalties — AFTER reranking, BEFORE platform penalty
    // Deflection, meta-conversation, diagnostic, echo, bare question,
    // recursion guard, recency multiplier
    // ========================================================================
    results = applyQualityPenalties(results, { query, requestId });

    // ========================================================================
    // STEP 6c: Content dedup → MMR → Keyword boost
    // ========================================================================
    results = deduplicateByContent(results);
    if (results.length > 1) {
        results = applyServerMMR(results, { lambda: mmrLambda, maxResults: topK, requestId });
        results = applyPostMMRKeywordBoost(query, results);
    }

    // ========================================================================
    // STEP 6d: Platform-mismatch penalty (Gap 3) — AFTER MMR
    // ========================================================================
    applyPlatformPenalty(query, results, confidenceThreshold, requestId);

    // ========================================================================
    // STEP 6d: Platform-filtered rescue search
    // When penalty killed all results but user explicitly asked about a platform,
    // do a second vector search filtered to that platform only.
    // ========================================================================
    if (results.length === 0 && queryTargetPlatform) {
        Logger.info(`Platform rescue: penalty killed all results, searching within "${queryTargetPlatform}" only`, { requestId });
        const { data: rescueData, error: rescueError } = await supabase
            .rpc("match_messages_with_gravity", {
                query_embedding: rawEmbedding,
                match_threshold: 0.35,  // Lower threshold for rescue
                match_count: topK,
                exclude_recent_seconds: 120,
                p_user_id: userId,
                boost_entity_ids: boostEntityIds,
                p_profile_id: resolvedProfileId,
                p_platform: queryTargetPlatform,
                p_project_id: projectId || null,
            });
        if (!rescueError && rescueData && rescueData.length > 0) {
            const rescueCandidates = rescueData as Candidate[];
            const rescueFiltered = filterQueryEchoes(query, rescueCandidates);
            const rescueResults = await rerankAndFilter(query, rescueFiltered, hfClient, requestId, topK);
            results.push(...rescueResults);
            Logger.info(`Platform rescue: recovered ${rescueResults.length} items from "${queryTargetPlatform}"`, { requestId });
        }
    }

    // ========================================================================
    // STEP 7: Enrich results with entity canonical names
    // Enables client-side recency resolution to use server entity data
    // instead of fragile regex extraction.
    // ========================================================================
    await enrichWithEntities(supabase, results, requestId);

    return results;
}

/**
 * Enrich results with entity canonical names from entity_mentions.
 * Adds an `entities` array to each result for client-side recency resolution.
 * Mutates results in-place.
 */
async function enrichWithEntities(
    supabase: any,
    results: CandidateWithScore[],
    requestId?: string
): Promise<void> {
    if (results.length === 0) return;

    const turnIds = results.map(r => r.id).filter(Boolean);
    if (turnIds.length === 0) return;

    try {
        // Batch query: get all entity mentions for these chat_turns
        const { data: mentions, error } = await supabase
            .from("entity_mentions")
            .select("chat_turn_id, entity_id, entities!inner(canonical_name, entity_type)")
            .in("chat_turn_id", turnIds);

        if (error) {
            Logger.warn("Entity enrichment query failed", { requestId, error: error.message });
            return;
        }

        if (!mentions || mentions.length === 0) return;

        // Build lookup: chat_turn_id -> [{canonical_name, entity_type}]
        const entityMap = new Map<string, Array<{canonical_name: string; entity_type: string}>>();
        for (const m of mentions) {
            const turnId = m.chat_turn_id;
            if (!entityMap.has(turnId)) entityMap.set(turnId, []);
            const entityData = m.entities;
            if (entityData) {
                entityMap.get(turnId)!.push({
                    canonical_name: entityData.canonical_name,
                    entity_type: entityData.entity_type
                });
            }
        }

        // Attach to results (also check entity_timeline from B1 injection)
        let enriched = 0;
        for (const result of results) {
            const entities = entityMap.get(result.id) || [];
            // Also include entity_timeline data from B1 injection if present
            const timeline = (result as any).entity_timeline;
            if (timeline?.canonical_name) {
                const already = entities.some(e => e.canonical_name === timeline.canonical_name);
                if (!already) {
                    entities.push({
                        canonical_name: timeline.canonical_name,
                        entity_type: timeline.entity_type
                    });
                }
            }
            if (entities.length > 0) {
                (result as any).entities = entities;
                enriched++;
            }
        }

        if (enriched > 0) {
            Logger.info(`Entity enrichment: ${enriched}/${results.length} results tagged with entities`, { requestId });
        }
    } catch (e) {
        Logger.warn(`Entity enrichment error: ${(e as Error).message}`, { requestId });
    }
}

/**
 * Rerank candidates and apply final filtering
 */
async function rerankAndFilter(
    query: string,
    candidates: Candidate[],
    hfClient: HuggingFaceClient,
    requestId?: string,
    returnCount: number = 5,
    confidenceThreshold: number = 0.4
): Promise<CandidateWithScore[]> {
    if (candidates.length === 0) {
        return [];
    }

    // Use contextual_content for reranking when available — richer text
    // gives the cross-encoder more signal for relevance scoring
    const docs = candidates.map((c) => (c as any).contextual_content || c.content);

    // Rerank with graceful fallback
    let ordered: CandidateWithScore[];
    try {
        const rerankResult: HFRerankResponse[] = await hfClient.rerank(query, docs, requestId);
        ordered = rerankResult
            .sort((a, b) => b.score - a.score)
            .map((r) => ({ ...candidates[r.index], rerank_score: r.score }));
    } catch (e) {
        Logger.warn(`Rerank failed, falling back to gravity order: ${e.message}`, { requestId });
        ordered = candidates.map((c) => ({
            ...c,
            rerank_score: c.gravity_score ?? c.rrf_score ?? 0.5,
        }));
    }

    // Apply BM25 + Entity Boost
    const boosted = applyBm25Boost(query, ordered);

    // Confidence filter — uses param (default 0.40, overridable via intent classification)
    const filtered = boosted.filter((c) => c.rerank_score >= confidenceThreshold);

    Logger.info("Retrieval complete", {
        requestId,
        candidateCount: candidates.length,
        afterRerank: ordered.length,
        afterFilter: filtered.length,
        returning: Math.min(filtered.length, returnCount)
    });

    return filtered.slice(0, returnCount);
}

/**
 * Simple platform-filtered recency query for temporal+platform fallback.
 * Returns the N most recent chat_turns for a given platform, ordered by created_at DESC.
 * No embeddings, no reranking — pure recency.
 */
export async function getRecentByPlatform(
    platform: string,
    userId: string,
    limit: number = 3,
    profileId?: string
): Promise<CandidateWithScore[]> {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const { data, error } = await supabase
        .from('chat_turns')
        .select('id, content, contextual_content, platform, speakers, created_at, conversation_id')
        .eq('platform', platform)
        .eq('user_id', userId)
        .not('content', 'is', null)
        .order('created_at', { ascending: false })
        .limit(limit);

    if (error) throw new Error(`getRecentByPlatform: ${error.message}`);

    Logger.info(`getRecentByPlatform: ${(data || []).length} rows for platform="${platform}"`, {});

    return (data || []).map((row: any, i: number) => ({
        id: row.id,
        content: row.content,
        contextual_content: row.contextual_content,
        platform: row.platform,
        source: row.platform,
        created_at: row.created_at,
        speakers: row.speakers,
        conversation_id: row.conversation_id,
        // Synthetic scores: pass default 0.40 threshold, don't overpower semantic results
        weighted_score: 0.50 - (i * 0.05),
        rrf_score: 0.50 - (i * 0.05),
        rerank_score: 0.50 - (i * 0.05),
        temporal_recency_hit: true,
    }));
}
