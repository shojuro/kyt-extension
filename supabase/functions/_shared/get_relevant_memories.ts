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
import { Logger } from "./utils.ts";
import { generateHyDEWithFallback, shouldSkipHyDE } from "./hyde-generator.ts";
import { mergeHydeAndRawResults, fallbackToRawResults } from "./rrf.ts";

type Candidate = {
    id: string;
    content: string;
    contextual_content?: string;  // Contextual retrieval: LLM-generated context prefix + raw content
    gravity_score?: number;
    entity_boost?: boolean;
    rrf_score?: number;  // Added by RRF merge
};
export type CandidateWithScore = Candidate & { rerank_score: number };

export interface SearchOptions {
    topK?: number;
    useHyde?: boolean;  // Default: true
    hydeWeight?: number;  // Default: 0.6
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
        // Only filter very short content that's likely just a user prompt
        if (contentNorm.length < 80) {
            const contentWords = new Set(contentNorm.split(/\s+/).filter(w => w.length > 2 && !ECHO_STOP.has(w)));
            const overlap = [...queryWords].filter(w => contentWords.has(w)).length;
            const overlapRatio = overlap / Math.max(queryWords.size, 1);
            if (overlapRatio > 0.7) return false; // >70% word overlap with query = echo
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
    requestId?: string
): Promise<Candidate[]> {
    const { data, error } = await supabase
        .rpc("match_messages_with_gravity", {
            query_embedding: embedding,
            match_threshold: 0.5,
            match_count: topK,
            exclude_recent_seconds: 0,
            p_user_id: userId,
            boost_entity_ids: boostEntityIds
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
async function searchEntities(
    supabase: any,
    embedding: number[],
    userId: string,
    queryText: string,
    requestId?: string
): Promise<{ ids: string[]; entities: any[] }> {
    const { data: entities, error } = await supabase
        .rpc("search_entities_by_embedding", {
            query_embedding: embedding,
            match_threshold: 0.8,
            match_count: 5,
            p_user_id: userId
        });

    if (error) {
        Logger.warn("Entity search failed, continuing without entity boost", {
            requestId,
            error: error.message
        });
        // Fall through to text search below
    }

    const embeddingResults = entities || [];

    // If embedding search found results, return them
    if (embeddingResults.length > 0) {
        const ids = embeddingResults.map((e: any) => e.id);
        Logger.info(`Found ${ids.length} relevant entities via embedding`, { requestId });
        return { ids, entities: embeddingResults };
    }

    // Fallback: text-based entity search (trigram + keyword)
    Logger.info("Entity embedding search returned 0, falling back to text search", { requestId });
    const { data: textEntities, error: textError } = await supabase
        .rpc("search_entities_by_text", {
            p_query_text: queryText,
            p_user_id: userId,
            p_match_count: 5
        });

    if (textError) {
        Logger.warn("Entity text search also failed", { requestId, error: textError.message });
        return { ids: [], entities: [] };
    }

    const textResults = textEntities || [];
    const ids = textResults.map((e: any) => e.id);
    if (ids.length > 0) {
        Logger.info(`Found ${ids.length} entities via text fallback`, { requestId });
    }

    return { ids, entities: textResults };
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
    requestId?: string
): Promise<CandidateWithScore[]> {
    const { data, error } = await supabase
        .rpc("lookup_user_preferences", {
            p_user_id: userId,
            p_category: category,
            p_limit: 10
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
    requestId?: string
): Promise<string[]> {
    const conceptTypes = new Set(["CONCEPT", "ANALOGY", "THEME"]);

    try {
        const { data: textEntities, error } = await supabase
            .rpc("search_entities_by_text", {
                p_query_text: query,
                p_user_id: userId,
                p_match_count: 10  // Fetch more, filter to concepts
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
    query: string,
    userId: string,
    optionsOrTopK: SearchOptions | number = {},
    requestId?: string,
    profileId?: string
): Promise<CandidateWithScore[]> {
    // Handle legacy signature (topK as number)
    const options: SearchOptions = typeof optionsOrTopK === "number"
        ? { topK: optionsOrTopK }
        : optionsOrTopK;

    const {
        topK = 20,
        useHyde = true,
        hydeWeight = 0.6
    } = options;

    // MVP: profileId = userId (1:1). Future: pass to RPC calls for multi-profile isolation.
    const _profileId = profileId || userId;

    // Vector search retrieval pool — always fetch at least 20 candidates for reranking,
    // even if client requests fewer items back. More candidates = better reranking quality.
    const vectorSearchCount = Math.max(topK, 20);

    // Initialize clients lazily
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const hfApiKey = Deno.env.get("HUGGINGFACE_API_KEY")!;
    const openaiApiKey = Deno.env.get("OPENAI_API_KEY");  // Optional for HyDE

    if (!supabaseUrl || !supabaseServiceKey || !hfApiKey) {
        throw new Error("Missing required environment variables");
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey);
    const hfClient = new HuggingFaceClient(hfApiKey);

    // ========================================================================
    // STEP 0: Preference Query Router (0ms regex, before any embedding)
    // Short-circuits the entire vector pipeline for "what is my favorite X?"
    // ========================================================================
    const prefCategory = detectPreferenceQuery(query);
    if (prefCategory) {
        Logger.info(`Preference router activated: category="${prefCategory}"`, { requestId });
        const prefResults = await lookupPreferencesAsCandidates(supabase, userId, prefCategory, requestId);
        if (prefResults.length > 0) {
            Logger.info(`Preference router: returning ${prefResults.length} results (short-circuit)`, { requestId });
            return prefResults;
        }
        Logger.info("Preference router: no preferences found, falling through to vector pipeline", { requestId });
    }

    Logger.info("Starting memory retrieval", {
        requestId,
        queryLength: query.length,
        useHyde,
        hydeWeight
    });

    // ========================================================================
    // STEP 1: Generate raw query embedding (always needed)
    // ========================================================================
    const rawEmbedding = (await hfClient.generateEmbeddings(query, requestId))[0];

    // ========================================================================
    // STEP 2: PARALLEL - Entity search + HyDE generation + Concept detection
    // ========================================================================
    const [entityResult, hydeResult, conceptEntityIds] = await Promise.all([
        searchEntities(supabase, rawEmbedding, userId, query, requestId),
        useHyde && openaiApiKey
            ? generateHyDEWithFallback(query, openaiApiKey, requestId)
            : Promise.resolve({ hydeDoc: null, usedHyde: false }),
        detectConceptEntities(supabase, query, userId, requestId)
    ]);

    const { ids: embeddingEntityIds, entities } = entityResult;
    const { hydeDoc, usedHyde } = hydeResult;

    // Merge concept entity IDs into boost set (deduped)
    const boostEntityIdSet = new Set([...embeddingEntityIds, ...conceptEntityIds]);
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
                p_max_depth: 2,
                p_max_intermediate: 20
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
    const entityConfidences = entities.map((e: any) => ({
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
            supabase, rawEmbedding, userId, boostEntityIds, vectorSearchCount, requestId
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
        const shortCircuitResults = await rerankAndFilter(query, scFiltered, hfClient, requestId, topK);
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
    }

    // Parallel vector searches
    const searchPromises: Promise<Candidate[]>[] = [
        vectorSearch(supabase, rawEmbedding, userId, boostEntityIds, vectorSearchCount, requestId)
    ];

    if (hydeEmbedding) {
        searchPromises.push(
            vectorSearch(supabase, hydeEmbedding, userId, boostEntityIds, vectorSearchCount, requestId)
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
            // 3-way merge: reduce HyDE/raw weights to make room for graph
            // Graph results provide conceptual connections vector search misses
            const graphWeight = 0.2;
            const adjustedHydeWeight = hydeWeight * (1 - graphWeight);  // 0.6 * 0.8 = 0.48
            const adjustedRawWeight = (1 - hydeWeight) * (1 - graphWeight);  // 0.4 * 0.8 = 0.32

            // Use existing RRF merge for HyDE+raw, then add graph results
            candidates = mergeHydeAndRawResults(hydeResults, rawResults, adjustedHydeWeight / (adjustedHydeWeight + adjustedRawWeight), requestId);

            // Add graph results with dedup
            const seenIds = new Set(candidates.map(c => c.id));
            for (const g of graphResults) {
                if (!seenIds.has(g.id)) {
                    seenIds.add(g.id);
                    candidates.push({
                        ...g,
                        rrf_score: graphWeight * (g.gravity_score || 0.5)
                    });
                } else {
                    // Boost existing candidate's score with graph signal
                    const existing = candidates.find(c => c.id === g.id);
                    if (existing && existing.rrf_score != null) {
                        existing.rrf_score += graphWeight * (g.gravity_score || 0.5);
                    }
                }
            }

            Logger.info("3-way merge: HyDE + Raw + Graph", {
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

        // Even without HyDE, graph results can contribute
        if (graphResults.length > 0) {
            const seenIds = new Set(candidates.map(c => c.id));
            for (const g of graphResults) {
                if (!seenIds.has(g.id)) {
                    seenIds.add(g.id);
                    candidates.push(g);
                }
            }
            Logger.info("Added graph results to raw fallback", {
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
                    p_max_per_entity: 1
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
    const results = await rerankAndFilter(query, echoFiltered, hfClient, requestId, topK);

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
    returnCount: number = 5
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

    // Confidence filter (>= 0.40) — lowered from 0.70 to let client-side
    // adaptive filter handle the final threshold decision. The client has more
    // context (semantic availability, Jina status) for threshold selection.
    const filtered = boosted.filter((c) => c.rerank_score >= 0.4);

    Logger.info("Retrieval complete", {
        requestId,
        candidateCount: candidates.length,
        afterRerank: ordered.length,
        afterFilter: filtered.length,
        returning: Math.min(filtered.length, returnCount)
    });

    return filtered.slice(0, returnCount);
}
