import { describe, it, expect } from 'vitest';

// ============================================================================
// JS port of supabase/functions/_shared/quality-penalties.ts :: applyRecencyMultiplier
// (deno is not available under vitest, so the repo tests JS ports — see
//  quality-filters.test.js). Keep this port in sync with the deployed function.
//
// `now` is injected for determinism (the deployed code uses Date.now()).
// ============================================================================

const HALF_LIFE_DAYS = 30;
const DAY_MS = 86400000;

// NEW (deployed) — additive recency: can reorder items.
function applyRecencyAdditive(items, now) {
    if (items.length <= 1) return items;
    const RECENCY_WEIGHT = 0.15;
    const RELEVANCE_WEIGHT = 1 - RECENCY_WEIGHT;
    for (const item of items) {
        const ts = item.created_at;
        if (!ts) continue;
        const itemTime = new Date(ts).getTime();
        if (isNaN(itemTime)) continue;
        const daysSince = Math.max(0, (now - itemTime) / DAY_MS);
        const recency = Math.exp(-daysSince / HALF_LIFE_DAYS);
        item.rerank_score = item.rerank_score * RELEVANCE_WEIGHT + recency * RECENCY_WEIGHT;
    }
    return items;
}

// OLD (pre-fix) — multiplicative: factor in [0.85,1.0], can NEVER reorder.
// Kept here only to prove the fix is load-bearing.
function applyRecencyMultiplicativeOld(items, now) {
    if (items.length <= 1) return items;
    for (const item of items) {
        const ts = item.created_at;
        if (!ts) continue;
        const itemTime = new Date(ts).getTime();
        if (isNaN(itemTime)) continue;
        const daysSince = Math.max(0, (now - itemTime) / DAY_MS);
        const m = Math.exp(-daysSince / HALF_LIFE_DAYS);
        item.rerank_score = item.rerank_score * 0.85 + item.rerank_score * m * 0.15;
    }
    return items;
}

const NOW = new Date('2026-06-16T00:00:00Z').getTime();
const daysAgo = (d) => new Date(NOW - d * DAY_MS).toISOString();
const topId = (items) => [...items].sort((a, b) => b.rerank_score - a.rerank_score)[0].id;

describe('recency resolution — additive boost lets a newer fact win (knowledge-update)', () => {
    it('flips a fresh lower-base item above a stale higher-base item when the gap is small', () => {
        // The classic LongMemEval knowledge-update case: an older, richer statement
        // ("I am vegetarian", base 0.80, 120d old) vs a newer correction
        // ("I started eating chicken", base 0.70, 1d old).
        const items = [
            { id: 'stale',  rerank_score: 0.80, created_at: daysAgo(120) },
            { id: 'update', rerank_score: 0.70, created_at: daysAgo(1) },
        ];
        applyRecencyAdditive(items, NOW);
        expect(topId(items)).toBe('update');
    });

    it('does NOT flip when the relevance gap is larger than the recency weight', () => {
        // Guard against pure-recency dominance: a much more relevant old item must win.
        const items = [
            { id: 'stale',  rerank_score: 0.95, created_at: daysAgo(120) },
            { id: 'update', rerank_score: 0.60, created_at: daysAgo(1) },
        ];
        applyRecencyAdditive(items, NOW);
        expect(topId(items)).toBe('stale');
    });

    it('beats the old multiplicative form for low-scoring recent corrections (magnitude-independent)', () => {
        // A terse recent correction ("I eat chicken now") often has a LOW absolute
        // rerank score. The old multiplicative boost is proportional to the score,
        // so it shrinks and cannot lift the correction over a higher-scoring stale
        // item; the additive boost is fixed (magnitude-independent) and can.
        const mk = () => ([
            { id: 'stale',  rerank_score: 0.34, created_at: daysAgo(120) },
            { id: 'update', rerank_score: 0.20, created_at: daysAgo(1) },
        ]);
        const additive = applyRecencyAdditive(mk(), NOW);
        expect(topId(additive)).toBe('update'); // additive flips the low-score case
        const old = applyRecencyMultiplicativeOld(mk(), NOW);
        expect(topId(old)).toBe('stale');        // old proportional form does not
    });

    it('can lift a recent correct item across the 0.40 confidence gate', () => {
        // Multiplicative leaves a 0.30 recent item below threshold (0.30*~0.995≈0.298);
        // additive raises it to ~0.405, crossing the gate so it is no longer abstained.
        const recent = [
            { id: 'a', rerank_score: 0.30, created_at: daysAgo(0) },
            { id: 'b', rerank_score: 0.30, created_at: daysAgo(0) },
        ];
        applyRecencyAdditive(recent, NOW);
        expect(recent[0].rerank_score).toBeGreaterThan(0.40);

        const recentOld = [
            { id: 'a', rerank_score: 0.30, created_at: daysAgo(0) },
            { id: 'b', rerank_score: 0.30, created_at: daysAgo(0) },
        ];
        applyRecencyMultiplicativeOld(recentOld, NOW);
        expect(recentOld[0].rerank_score).toBeLessThan(0.40);
    });

    it('is a no-op for a single item and skips items with missing/invalid timestamps', () => {
        const single = [{ id: 'a', rerank_score: 0.5, created_at: daysAgo(1) }];
        applyRecencyAdditive(single, NOW);
        expect(single[0].rerank_score).toBe(0.5); // length<=1 → untouched

        const items = [
            { id: 'good', rerank_score: 0.5, created_at: daysAgo(0) },
            { id: 'nots', rerank_score: 0.5, created_at: null },
            { id: 'bad',  rerank_score: 0.5, created_at: 'not-a-date' },
        ];
        applyRecencyAdditive(items, NOW);
        expect(items[1].rerank_score).toBe(0.5); // missing ts untouched
        expect(items[2].rerank_score).toBe(0.5); // invalid ts untouched
        expect(items[0].rerank_score).toBeCloseTo(0.5 * 0.85 + 1.0 * 0.15, 6); // today → +0.15
    });
});
