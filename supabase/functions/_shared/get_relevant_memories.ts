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
 * Search for entities matching the query embedding
 */
async function searchEntities(
    supabase: any,
    embedding: number[],
    userId: string,
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
        return { ids: [], entities: [] };
    }

    const ids = entities?.map((e: any) => e.id) || [];
    if (ids.length > 0) {
        Logger.info(`Found ${ids.length} relevant entities`, { requestId });
    }

    return { ids, entities: entities || [] };
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
    // STEP 2: PARALLEL - Entity search + HyDE generation
    // ========================================================================
    const [entityResult, hydeResult] = await Promise.all([
        searchEntities(supabase, rawEmbedding, userId, requestId),
        useHyde && openaiApiKey
            ? generateHyDEWithFallback(query, openaiApiKey, requestId)
            : Promise.resolve({ hydeDoc: null, usedHyde: false })
    ]);

    const { ids: boostEntityIds, entities } = entityResult;
    const { hydeDoc, usedHyde } = hydeResult;

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

        // Single vector search with raw query
        const candidates = await vectorSearch(
            supabase, rawEmbedding, userId, boostEntityIds, topK, requestId
        );

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
    // STEP 5: RRF Merge (if HyDE was used)
    // ========================================================================
    let candidates: Candidate[];

    if (hydeResults.length > 0) {
        candidates = mergeHydeAndRawResults(hydeResults, rawResults, hydeWeight, requestId);
        Logger.info("Merged HyDE and raw results", {
            requestId,
            hydeCount: hydeResults.length,
            rawCount: rawResults.length,
            mergedCount: candidates.length
        });
    } else {
        candidates = fallbackToRawResults(rawResults, requestId);
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

    // Confidence filter (>= 0.70)
    const filtered = boosted.filter((c) => c.rerank_score >= 0.7);

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
