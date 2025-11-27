// supabase/functions/_shared/get_relevant_memories.ts

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { HuggingFaceClient, HFRerankResponse } from "./huggingface-client.ts";

// Module-level HF client (key from Supabase env)
const hfClient = new HuggingFaceClient(Deno.env.get("HUGGINGFACE_API_KEY")!);

// Initialize Supabase client
const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabase = createClient(supabaseUrl, supabaseServiceKey);

type Candidate = {
    id: string;
    content: string;
    gravity_score?: number;
    entity_boost?: boolean; // New field from RPC
};
export type CandidateWithScore = Candidate & { rerank_score: number };

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
 * Retrieve relevant memories for a query.
 * Steps: 
 * 1. Entity Search (find entities in query)
 * 2. Vector Search (with gravity + entity boost)
 * 3. Rerank (fallback)
 * 4. BM25 + Entity Boost
 * 5. Confidence Filter -> Top-5
 */
export async function getRelevantMemories(
    query: string,
    userId: string,
    topK = 20,
): Promise<CandidateWithScore[]> {
    // 1. Generate Query Embedding
    const queryEmbedding = await hfClient.generateEmbeddings(query);

    // 2. Search for Entities in the Query
    // We use the query embedding to find relevant entities in the 'entities' table
    // Note: This RPC must exist in the DB (added via migration)
    const { data: entities } = await supabase
        .rpc("search_entities_by_embedding", {
            query_embedding: queryEmbedding[0],
            match_threshold: 0.8, // High threshold for entity matching
            match_count: 5,
            p_user_id: userId
        });

    const boostEntityIds = entities?.map((e: any) => e.id) || [];
    if (boostEntityIds.length > 0) {
        console.log(`[DEBUG] Found relevant entities: ${boostEntityIds.length}`);
    }

    // 3. Vector Search (RPC)
    // Pass boost_entity_ids to the RPC
    const { data: raw, error: rpcError } = await supabase
        .rpc("match_messages_with_gravity", {
            query_embedding: queryEmbedding[0],
            match_threshold: 0.7,
            match_count: topK,
            exclude_recent_seconds: 0,
            p_user_id: userId,
            boost_entity_ids: boostEntityIds // Pass found entities
        });
    // Note: .select() removed to avoid "structure mismatch" error

    if (rpcError) {
        console.error("RPC Error:", rpcError);
        throw new Error(`RPC Error: ${rpcError.message}`);
    }

    const candidates: Candidate[] = (raw as Candidate[]) || [];

    if (candidates.length === 0) {
        return [];  // No memories found
    }
    const docs = candidates.map((c) => c.content);

    // 4. Rerank with graceful fallback
    let ordered: CandidateWithScore[];
    try {
        const rerankResult: HFRerankResponse[] = await hfClient.rerank(query, docs);
        ordered = rerankResult
            .sort((a, b) => b.score - a.score)
            .map((r) => ({ ...candidates[r.index], rerank_score: r.score }));
    } catch (e) {
        console.warn(`Rerank failed, falling back to vector order: ${e.message}`);
        ordered = candidates.map((c) => ({
            ...c,
            rerank_score: c.gravity_score ?? 0.5,
        }));
    }

    // 5. Apply BM25 + Entity Boost
    const boosted = applyBm25Boost(query, ordered);

    // 6. Confidence filter (>= 0.70)
    const filtered = boosted.filter((c) => c.rerank_score >= 0.7);

    // 7. Return top 5 (or fewer)
    return filtered.slice(0, 5);
}
