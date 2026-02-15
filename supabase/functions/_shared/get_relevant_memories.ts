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

/** Simple BM25-style keyword boost (max 30% of score) */
function applyBm25Boost(query: string, items: CandidateWithScore[]): CandidateWithScore[] {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return items;

    const bm25Scores = items.map((item) => {
        const txt = item.content.toLowerCase();
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
            match_threshold: 0.7,
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
    requestId?: string
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
                p_max_results: topK,
                p_max_depth: 2,
                p_max_intermediate: 20
            });
            if (error) {
                Logger.warn("Graph walk RPC failed", { requestId, error: error.message });
            } else if (data && data.length > 0) {
                graphResults = data.map((item: any) => ({
                    id: item.chat_turn_id,
                    content: item.content,
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
            supabase, rawEmbedding, userId, boostEntityIds, topK, requestId
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

        return await rerankAndFilter(query, candidates, hfClient, requestId);
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
        vectorSearch(supabase, rawEmbedding, userId, boostEntityIds, topK, requestId)
    ];

    if (hydeEmbedding) {
        searchPromises.push(
            vectorSearch(supabase, hydeEmbedding, userId, boostEntityIds, topK, requestId)
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
    // STEP 6: Rerank, BM25 Boost, Confidence Filter
    // ========================================================================
    return await rerankAndFilter(query, candidates, hfClient, requestId);
}

/**
 * Rerank candidates and apply final filtering
 */
async function rerankAndFilter(
    query: string,
    candidates: Candidate[],
    hfClient: HuggingFaceClient,
    requestId?: string
): Promise<CandidateWithScore[]> {
    if (candidates.length === 0) {
        return [];
    }

    const docs = candidates.map((c) => c.content);

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
        returning: Math.min(filtered.length, 5)
    });

    // Return top 5
    return filtered.slice(0, 5);
}
