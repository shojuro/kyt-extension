// Relevance bar for the fast search path. Pure module:
// tests/unit/fast-threshold.test.js.
//
// The extension's intent classifier sends a bar between 0.40 and 0.65. Those
// numbers were tuned for reranked scores, which spread over 0 to 1. The fast
// path (the one the extension uses) does not rerank: its scores sit lower,
// and a good match typically lands between 0.15 and 0.40. Applied as sent,
// the classifier's bar removed almost everything, including the right answer.
//
// 2026-11-14, production: for "which two projects do I want to marry
// together, and why", the statement that answers it scored 0.396 and was
// dropped by a bar of 0.45; the next candidates scored 0.245 and 0.201. For
// "What is K.Y.T.?" the best candidates (other short questions) scored 0.228
// and 0.170. A scale of 0.65 keeps the first and still drops the second.
// It rests on those two searches, so re-check it as test questions are added.

/** Bar used when the caller sends none. */
export const FAST_DEFAULT_THRESHOLD = 0.15;

/** Fast-path scores relative to reranked scores. */
export const FAST_SCORE_SCALE = 0.65;

/** The bar to apply to fast-path scores for a caller's (rerank-scale) bar. */
export function fastPathThreshold(callerThreshold: number | null | undefined): number {
    if (typeof callerThreshold !== "number" || !Number.isFinite(callerThreshold) || callerThreshold <= 0) {
        return FAST_DEFAULT_THRESHOLD;
    }
    return Math.round(callerThreshold * FAST_SCORE_SCALE * 1000) / 1000;
}
