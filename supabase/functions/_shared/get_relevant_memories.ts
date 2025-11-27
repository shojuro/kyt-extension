// supabase/functions/_shared/get_relevant_memories.ts

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { HuggingFaceClient, HFRerankResponse } from "./huggingface-client.ts";

// Module-level HF client (key from Supabase env)
const hfClient = new HuggingFaceClient(Deno.env.get("HUGGINGFACE_API_KEY")!);

// Initialize Supabase client
const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabase = createClient(supabaseUrl, supabaseServiceKey);

type Candidate = { id: string; content: string; gravity_score?: number };
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
    return items.map((item, i) => ({
        ...item,
        rerank_score: item.rerank_score + (0.3 * bm25Scores[i]) / maxScore,
    }));
}

/**
 * Retrieve relevant memories for a query.
 * Steps: vector search -> rerank (fallback) -> BM25 boost -> confidence filter -> top-5 slice.
 */
export async function getRelevantMemories(
    query: string,
    userId: string,
    topK = 20,
): Promise<CandidateWithScore[]> {
    console.log(`[DEBUG] getRelevantMemories called for user ${userId} query="${query}"`);

    // 1. Vector search (gravity + embedding)
    const queryEmbedding = await hfClient.generateEmbeddings(query);

    // Call RPC with lowered threshold and NO temporal exclusion
    // Using correct function name: match_messages_with_gravity
    const { data: raw, error: rpcError } = await supabase
        .rpc("match_messages_with_gravity", {
            query_embedding: queryEmbedding[0],
            match_threshold: 0.01, // DEBUG: Very low threshold
            match_count: topK,
            exclude_recent_seconds: 0, // DEBUG: No exclusion
            p_user_id: userId
        })
    // .select("id, content, gravity_score"); // Removed to avoid structure mismatch error

    if (rpcError) {
        console.error("[DEBUG] RPC Error:", rpcError);
        throw new Error(`RPC Error: ${rpcError.message}`);
    }

    const candidates: Candidate[] = (raw as Candidate[]) || [];
    console.log(`[DEBUG] Vector search returned ${candidates.length} candidates`);

    if (candidates.length === 0) {
        return [];  // No memories found
    }
    const docs = candidates.map((c) => c.content);

    // 2. Rerank with graceful fallback
    let ordered: CandidateWithScore[];
    try {
        const rerankResult: HFRerankResponse[] = await hfClient.rerank(query, docs);
        console.log(`[DEBUG] Rerank scores:`, JSON.stringify(rerankResult));

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

    // 3. BM25 boost (after rerank)
    const boosted = applyBm25Boost(query, ordered);

    // 4. Confidence filter (DEBUG: Lowered to 0.01)
    const filtered = boosted.filter((c) => c.rerank_score >= 0.01);
    console.log(`[DEBUG] After filtering (>=0.01): ${filtered.length} results`);

    // 5. Return top 5 (or fewer)
    return filtered.slice(0, 5);
}
