import { describe, it, expect } from 'vitest';

// Extract the HyDE confidence gate math from get_relevant_memories.ts
// Pure cosine similarity: dot(a,b) / (|a| * |b|)
function hydeConfidenceGate(rawEmbedding, hydeEmbedding, threshold = 0.3) {
  const dotProduct = rawEmbedding.reduce((sum, v, i) => sum + v * (hydeEmbedding[i] || 0), 0);
  const magRaw = Math.sqrt(rawEmbedding.reduce((sum, v) => sum + v * v, 0));
  const magHyde = Math.sqrt(hydeEmbedding.reduce((sum, v) => sum + v * v, 0));
  const cosineSim = magRaw > 0 && magHyde > 0 ? dotProduct / (magRaw * magHyde) : 0;
  return { cosineSim, keep: cosineSim >= threshold };
}

describe('HyDE confidence gate', () => {
  it('keeps HyDE when vectors are similar (cosine >= 0.3)', () => {
    // Nearly identical vectors → cosine ≈ 1.0
    const raw  = [1, 0, 0, 0];
    const hyde = [0.9, 0.1, 0, 0];
    const result = hydeConfidenceGate(raw, hyde);
    expect(result.keep).toBe(true);
    expect(result.cosineSim).toBeGreaterThan(0.9);
  });

  it('discards HyDE when vectors are orthogonal (cosine ≈ 0)', () => {
    const raw  = [1, 0, 0, 0];
    const hyde = [0, 0, 0, 1];
    const result = hydeConfidenceGate(raw, hyde);
    expect(result.keep).toBe(false);
    expect(result.cosineSim).toBeCloseTo(0, 5);
  });

  it('discards HyDE when vectors oppose (cosine < 0)', () => {
    const raw  = [1, 0, 0];
    const hyde = [-1, 0, 0];
    const result = hydeConfidenceGate(raw, hyde);
    expect(result.keep).toBe(false);
    expect(result.cosineSim).toBeCloseTo(-1, 5);
  });

  it('handles zero-magnitude raw vector gracefully', () => {
    const raw  = [0, 0, 0];
    const hyde = [1, 2, 3];
    const result = hydeConfidenceGate(raw, hyde);
    expect(result.keep).toBe(false);
    expect(result.cosineSim).toBe(0);
  });

  it('handles zero-magnitude HyDE vector gracefully', () => {
    const raw  = [1, 2, 3];
    const hyde = [0, 0, 0];
    const result = hydeConfidenceGate(raw, hyde);
    expect(result.keep).toBe(false);
    expect(result.cosineSim).toBe(0);
  });

  it('correctly identifies the 0.3 boundary', () => {
    // Construct vectors with cosine similarity just above and below 0.3
    // cos(θ) = 0.3 → θ ≈ 72.5° → raw=[1,0], hyde=[0.3, sin(acos(0.3))]
    const sinVal = Math.sqrt(1 - 0.3 * 0.3); // ≈ 0.9539
    const raw  = [1, 0];
    const hydeAbove = [0.31, sinVal];
    const hydeBelow = [0.29, sinVal];

    const above = hydeConfidenceGate(raw, hydeAbove);
    const below = hydeConfidenceGate(raw, hydeBelow);

    expect(above.keep).toBe(true);
    expect(below.keep).toBe(false);
  });
});
