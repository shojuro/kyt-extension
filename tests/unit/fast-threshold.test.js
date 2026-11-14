/**
 * Relevance bar on the fast search path (supabase/functions/_shared/fast-threshold.ts).
 *
 * Regression for 2026-11-14: the extension sent a bar of 0.45 (tuned for
 * reranked scores) to the fast path, whose scores sit lower. The one stored
 * statement that answers "which two projects do I want to marry together"
 * scored 0.396 and was thrown away, so nothing was injected.
 */
import { describe, it, expect } from 'vitest';
import { fastPathThreshold, FAST_DEFAULT_THRESHOLD } from '../../supabase/functions/_shared/fast-threshold.ts';

describe('fastPathThreshold', () => {
  it('keeps the statement that scored 0.396 under a caller bar of 0.45', () => {
    expect(fastPathThreshold(0.45)).toBeLessThan(0.396);
  });

  it('still drops the weak candidates seen for "What is K.Y.T.?" (0.228, 0.170)', () => {
    expect(fastPathThreshold(0.45)).toBeGreaterThan(0.228);
    expect(fastPathThreshold(0.40)).toBeGreaterThan(0.228);
  });

  it('stays in order: a stricter caller bar gives a stricter fast bar', () => {
    const bars = [0.40, 0.45, 0.50, 0.55, 0.60, 0.65].map(fastPathThreshold);
    expect([...bars].sort((a, b) => a - b)).toEqual(bars);
    expect(bars[bars.length - 1]).toBeLessThan(0.65);
  });

  it('uses the default when the caller sends no usable bar', () => {
    for (const v of [undefined, null, NaN, 0, -1, '0.4']) expect(fastPathThreshold(v)).toBe(FAST_DEFAULT_THRESHOLD);
  });
});
