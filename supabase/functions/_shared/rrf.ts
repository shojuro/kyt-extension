/**
 * Reciprocal Rank Fusion (RRF)
 *
 * Merges results from multiple ranking lists into a single fused ranking.
 * RRF is robust to outliers and works well for combining different retrieval methods.
 *
 * Formula: RRF(d) = Σ (weight_i / (k + rank_i(d)))
 * where k is a smoothing constant (default: 60)
 *
 * Reference: https://plg.uwaterloo.ca/~gvcormac/cormacksigir09-rrf.pdf
 */

import { Logger } from "./utils.ts";

export interface RankedItem {
    id: string;
    [key: string]: any;
}

export interface RankingList<T extends RankedItem> {
    results: T[];
    weight: number;  // Weight for this ranking list (0-1)
}

export interface FusedResult<T extends RankedItem> {
    item: T;
    rrf_score: number;
    source_ranks: { [source: string]: number };
}

/**
 * Reciprocal Rank Fusion for multiple ranking lists
 *
 * @param rankings - Array of ranking lists with weights
 * @param k - Smoothing constant (default: 60, standard value from RRF paper)
 * @param maxResults - Maximum results to return
 * @returns Fused results sorted by RRF score
 *
 * @example
 * const fused = reciprocalRankFusion([
 *   { results: hydeResults, weight: 0.6 },
 *   { results: rawResults, weight: 0.4 }
 * ]);
 */
export function reciprocalRankFusion<T extends RankedItem>(
    rankings: RankingList<T>[],
    k = 60,
    maxResults = 20
): FusedResult<T>[] {
    // Map to accumulate scores: id -> { item, score, ranks }
    const scoreMap = new Map<string, {
        item: T;
        score: number;
        ranks: { [source: string]: number };
    }>();

    // Process each ranking list
    rankings.forEach((ranking, listIndex) => {
        const sourceName = `list_${listIndex}`;

        ranking.results.forEach((item, rank) => {
            const id = item.id;
            const rrfContribution = ranking.weight / (k + rank + 1);  // rank is 0-indexed

            if (scoreMap.has(id)) {
                const existing = scoreMap.get(id)!;
                existing.score += rrfContribution;
                existing.ranks[sourceName] = rank + 1;  // Store 1-indexed rank
            } else {
                scoreMap.set(id, {
                    item,
                    score: rrfContribution,
                    ranks: { [sourceName]: rank + 1 }
                });
            }
        });
    });

    // Convert to array and sort by RRF score
    const fusedResults: FusedResult<T>[] = Array.from(scoreMap.values())
        .map(entry => ({
            item: entry.item,
            rrf_score: entry.score,
            source_ranks: entry.ranks
        }))
        .sort((a, b) => b.rrf_score - a.rrf_score)
        .slice(0, maxResults);

    return fusedResults;
}

/**
 * Merge HyDE and raw query results with weighted RRF
 *
 * Convenience function for the common case of merging HyDE + raw results.
 *
 * @param hydeResults - Results from HyDE embedding search
 * @param rawResults - Results from raw query embedding search
 * @param hydeWeight - Weight for HyDE results (default: 0.6)
 * @param requestId - Request ID for logging
 * @returns Merged results with RRF scores
 */
export function mergeHydeAndRawResults<T extends RankedItem>(
    hydeResults: T[],
    rawResults: T[],
    hydeWeight = 0.6,
    requestId?: string
): T[] {
    const rawWeight = 1 - hydeWeight;

    const fusedResults = reciprocalRankFusion([
        { results: hydeResults, weight: hydeWeight },
        { results: rawResults, weight: rawWeight }
    ]);

    Logger.info("RRF merge completed", {
        requestId,
        hydeResultCount: hydeResults.length,
        rawResultCount: rawResults.length,
        fusedResultCount: fusedResults.length,
        hydeWeight,
        rawWeight
    });

    // Return just the items (unwrap from FusedResult)
    return fusedResults.map(fr => ({
        ...fr.item,
        rrf_score: fr.rrf_score  // Preserve RRF score for debugging
    }));
}

/**
 * Merge results when HyDE failed (raw only)
 *
 * Fallback path when HyDE generation fails.
 * Simply returns raw results with normalized scores.
 *
 * @param rawResults - Results from raw query embedding search
 * @param requestId - Request ID for logging
 * @returns Raw results (unchanged)
 */
export function fallbackToRawResults<T extends RankedItem>(
    rawResults: T[],
    requestId?: string
): T[] {
    Logger.info("Using raw results only (HyDE fallback)", {
        requestId,
        resultCount: rawResults.length
    });

    return rawResults;
}
