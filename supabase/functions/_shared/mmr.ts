/**
 * MMR (Maximal Marginal Relevance) — Server-side implementation
 *
 * Ported from src/mmr.js. Balances relevance and diversity in search results.
 * Uses embeddings when available, falls back to score-only ranking.
 *
 * Algorithm:
 * 1. Start with highest-scored item
 * 2. For each subsequent item: score = λ * relevance - (1-λ) * max_similarity_to_selected
 * 3. Select item with highest MMR score
 *
 * Reference: Carbonell & Goldstein (1998)
 */

import { Logger } from "./utils.ts";
import type { CandidateWithScore } from "./get_relevant_memories.ts";

// ============================================================================
// Similarity Functions
// ============================================================================

/**
 * Cosine similarity between two embedding vectors.
 * Returns value in [-1, 1] range.
 */
function cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) return 0;

    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }

    if (normA === 0 || normB === 0) return 0;
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Content-based similarity fallback when embeddings unavailable.
 * Uses Jaccard similarity on word sets.
 */
function contentSimilarity(a: string, b: string): number {
    const wordsA = new Set(a.toLowerCase().split(/\s+/).filter(w => w.length > 2));
    const wordsB = new Set(b.toLowerCase().split(/\s+/).filter(w => w.length > 2));
    if (wordsA.size === 0 || wordsB.size === 0) return 0;

    let intersection = 0;
    for (const w of wordsA) {
        if (wordsB.has(w)) intersection++;
    }
    return intersection / (wordsA.size + wordsB.size - intersection);
}

// ============================================================================
// Content Deduplication
// ============================================================================

/**
 * Deduplicate candidates by content hash (normalized lowercase trim).
 * Keeps the first (highest-scored) occurrence.
 */
export function deduplicateByContent<T extends { content: string }>(items: T[]): T[] {
    const seen = new Set<string>();
    return items.filter(item => {
        const key = item.content.trim().toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

// ============================================================================
// MMR Algorithm
// ============================================================================

export interface MMROptions {
    /** Trade-off: 1.0 = pure relevance, 0.0 = pure diversity. Default: 0.5 */
    lambda?: number;
    /** Maximum results to return. Default: 5 */
    maxResults?: number;
    /** Request ID for logging */
    requestId?: string;
}

/**
 * Apply MMR reranking to scored candidates.
 *
 * Uses embeddings for inter-item similarity when available (returned by
 * match_messages_with_gravity RPC). Falls back to content-based Jaccard
 * similarity when embeddings are missing.
 *
 * Items must already have `rerank_score` set (by cross-encoder or fallback).
 */
export function applyServerMMR(
    candidates: CandidateWithScore[],
    options: MMROptions = {},
): CandidateWithScore[] {
    const {
        lambda = 0.5,
        maxResults = 5,
        requestId,
    } = options;

    if (candidates.length <= 1 || maxResults <= 0) {
        return candidates.slice(0, maxResults);
    }

    // Normalize rerank_scores to [0, 1] for MMR relevance component
    const maxScore = Math.max(...candidates.map(c => c.rerank_score));
    const minScore = Math.min(...candidates.map(c => c.rerank_score));
    const scoreRange = maxScore - minScore || 1;

    const selected: CandidateWithScore[] = [];
    const remaining = [...candidates];

    // Sort by rerank_score descending, pick the best first
    remaining.sort((a, b) => b.rerank_score - a.rerank_score);
    selected.push(remaining.shift()!);

    while (selected.length < maxResults && remaining.length > 0) {
        let bestMMR = -Infinity;
        let bestIdx = -1;

        for (let i = 0; i < remaining.length; i++) {
            const candidate = remaining[i];

            // Relevance: normalized rerank_score
            const relevance = (candidate.rerank_score - minScore) / scoreRange;

            // Diversity: max similarity to any already-selected item
            // Per-pair hybrid: use cosine when both have embeddings, else content similarity
            let maxSim = -Infinity;
            for (const sel of selected) {
                let sim: number;
                const candidateEmb = (candidate as any).embedding;
                const selEmb = (sel as any).embedding;
                if (Array.isArray(candidateEmb) && candidateEmb.length > 0 &&
                    Array.isArray(selEmb) && selEmb.length > 0) {
                    // Normalize cosine [-1,1] to [0,1] at the source
                    sim = (cosineSimilarity(candidateEmb, selEmb) + 1) / 2;
                } else {
                    // Jaccard contentSimilarity already returns [0,1]
                    sim = contentSimilarity(candidate.content, sel.content);
                }
                if (sim > maxSim) maxSim = sim;
            }

            // MMR score: λ * relevance - (1-λ) * max_similarity
            // maxSim is already in [0,1] (cosine normalized at call site, Jaccard native)
            const mmrScore = lambda * relevance - (1 - lambda) * maxSim;

            if (mmrScore > bestMMR) {
                bestMMR = mmrScore;
                bestIdx = i;
            }
        }

        if (bestIdx === -1) break;
        selected.push(remaining.splice(bestIdx, 1)[0]);
    }

    Logger.info(`MMR: selected ${selected.length}/${candidates.length} items (λ=${lambda}, embeddings=per-pair)`, { requestId });

    return selected;
}

// ============================================================================
// Keyword Boost (post-MMR)
// ============================================================================

/**
 * Boost items that contain query keywords.
 * Applied after MMR to reward topically relevant items in the final set.
 * Max boost: 15% of current score.
 */
export function applyKeywordBoost(
    query: string,
    items: CandidateWithScore[],
): CandidateWithScore[] {
    const terms = query.toLowerCase().split(/\s+/).filter(t => t.length > 2);
    if (terms.length === 0 || items.length === 0) return items;

    const scores = items.map(item => {
        const txt = ((item as any).contextual_content || item.content).toLowerCase();
        let hits = 0;
        for (const term of terms) {
            if (txt.includes(term)) hits++;
        }
        return hits;
    });

    const maxHits = Math.max(...scores, 1);

    return items.map((item, i) => ({
        ...item,
        rerank_score: item.rerank_score + (0.15 * scores[i] / maxHits) * item.rerank_score,
    }));
}
