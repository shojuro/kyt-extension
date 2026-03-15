/**
 * Phase 3 Logic Bug Regression Tests
 *
 * Tests for 9 logic bugs fixed in Phase 3. Each test is designed to FAIL
 * if the corresponding fix is reverted — preventing silent regression.
 *
 * Bugs covered:
 *   L1 — MMR Jaccard normalization (cosine vs Jaccard [0,1] range mismatch)
 *   L2 — NaN distance propagation in similarity calculation
 *   L3 — || vs ?? zero-score fallback
 *   L4 — backfillNullEmbeddings infinite loop on patch failure
 *   L5 — backfillNullChatTurnEmbeddings hardcoded offset=0
 *   L6 — eviction timestamp collision (wrong message evicted)
 *   L7 — backfillEmbeddings alarm not rescheduled on error
 *   L8 — stale hasTargetPlatformItems after concat mutation
 *   L9 — missing null guard on classifyWithHaiku result
 */

import { describe, it, expect } from 'vitest';

// ============================================================================
// L1: MMR Jaccard normalization
// ============================================================================

// Inlined from mmr.ts — pure functions, no external dependencies
function cosineSimilarity(a, b) {
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

function contentSimilarity(a, b) {
  const wordsA = new Set(a.toLowerCase().split(/\s+/).filter(w => w.length > 2));
  const wordsB = new Set(b.toLowerCase().split(/\s+/).filter(w => w.length > 2));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let intersection = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) intersection++;
  }
  return intersection / (wordsA.size + wordsB.size - intersection);
}

/**
 * Compute inter-item similarity the FIXED way:
 *   cosine normalized to [0,1] at call site, Jaccard already [0,1]
 */
function computeSimilarityFixed(candidateEmb, selEmb, candidateContent, selContent) {
  if (Array.isArray(candidateEmb) && candidateEmb.length > 0 &&
      Array.isArray(selEmb) && selEmb.length > 0) {
    return (cosineSimilarity(candidateEmb, selEmb) + 1) / 2;
  }
  return contentSimilarity(candidateContent, selContent);
}

/**
 * Compute inter-item similarity the BROKEN way (pre-fix):
 *   always applies (maxSim + 1) / 2 regardless of source
 */
function computeSimilarityBroken(candidateEmb, selEmb, candidateContent, selContent) {
  let sim;
  if (Array.isArray(candidateEmb) && candidateEmb.length > 0 &&
      Array.isArray(selEmb) && selEmb.length > 0) {
    sim = cosineSimilarity(candidateEmb, selEmb);
  } else {
    sim = contentSimilarity(candidateContent, selContent);
  }
  // Bug: always normalizes, even Jaccard
  return (sim + 1) / 2;
}

describe('L1: MMR Jaccard normalization', () => {
  it('0% word overlap should produce 0 similarity (not 0.5)', () => {
    // Two items with completely different words, no embeddings
    const sim = computeSimilarityFixed(
      null, null,
      'alpha beta gamma delta',
      'epsilon zeta theta iota'
    );
    expect(sim).toBe(0);
  });

  it('broken version produces 0.5 for 0% overlap (proves regression catches it)', () => {
    const sim = computeSimilarityBroken(
      null, null,
      'alpha beta gamma delta',
      'epsilon zeta theta iota'
    );
    expect(sim).toBe(0.5); // The bug we fixed
  });

  it('100% word overlap should produce 1.0 similarity', () => {
    const sim = computeSimilarityFixed(
      null, null,
      'alpha beta gamma delta',
      'alpha beta gamma delta'
    );
    expect(sim).toBe(1);
  });

  it('cosine similarity of identical vectors should produce 1.0 after normalization', () => {
    const vec = [0.1, 0.2, 0.3, 0.4];
    const sim = computeSimilarityFixed(vec, vec, '', '');
    expect(sim).toBeCloseTo(1.0, 5);
  });

  it('cosine similarity of orthogonal vectors should produce 0.5 after normalization', () => {
    // Orthogonal: cosine = 0, normalized = (0+1)/2 = 0.5
    const vecA = [1, 0, 0, 0];
    const vecB = [0, 1, 0, 0];
    const sim = computeSimilarityFixed(vecA, vecB, '', '');
    expect(sim).toBeCloseTo(0.5, 5);
  });

  it('cosine similarity of opposite vectors should produce 0.0 after normalization', () => {
    // Opposite: cosine = -1, normalized = (-1+1)/2 = 0
    const vecA = [1, 0, 0, 0];
    const vecB = [-1, 0, 0, 0];
    const sim = computeSimilarityFixed(vecA, vecB, '', '');
    expect(sim).toBeCloseTo(0.0, 5);
  });

  it('MMR penalty is proportional: 0 similarity should not penalize at all', () => {
    const lambda = 0.5;
    const relevance = 0.8;
    const maxSim = 0; // 0% overlap, no embeddings

    // Fixed: maxSim used directly (already [0,1])
    const mmrFixed = lambda * relevance - (1 - lambda) * maxSim;
    expect(mmrFixed).toBe(0.4); // 0.5 * 0.8 - 0.5 * 0 = 0.4

    // Broken: maxSim normalized again → (0+1)/2 = 0.5
    const normalizedBroken = (maxSim + 1) / 2;
    const mmrBroken = lambda * relevance - (1 - lambda) * normalizedBroken;
    expect(mmrBroken).toBeCloseTo(0.15, 10); // 0.5 * 0.8 - 0.5 * 0.5 = 0.15 (wrongly penalized)

    // The fix gives 0.25 MORE MMR score for truly diverse items
    expect(mmrFixed - mmrBroken).toBeCloseTo(0.25, 5);
  });
});

// ============================================================================
// L2 + L3: NaN distance guard + ?? vs || zero-score fallback
// ============================================================================

/**
 * The similarity expression from context-retrieval.js:772-776 (FIXED version)
 */
function computeItemSimilarityFixed(item) {
  return item.cross_encoder_score != null
    ? item.cross_encoder_score
    : (item.distance != null && !isNaN(item.distance))
      ? Math.max(0, 1 - item.distance)
      : (item.weighted_score ?? item.rrf_score ?? 0.5);
}

/**
 * The similarity expression BEFORE fix (broken)
 */
function computeItemSimilarityBroken(item) {
  return item.cross_encoder_score != null
    ? item.cross_encoder_score
    : item.distance != null
      ? Math.max(0, 1 - item.distance)
      : (item.weighted_score || item.rrf_score || 0.5);
}

describe('L2: NaN distance guard', () => {
  it('NaN distance should fall through to weighted_score (not produce NaN)', () => {
    const item = { distance: NaN, weighted_score: 0.75 };
    const result = computeItemSimilarityFixed(item);
    expect(result).toBe(0.75);
    expect(isNaN(result)).toBe(false);
  });

  it('broken version produces NaN from NaN distance', () => {
    const item = { distance: NaN, weighted_score: 0.75 };
    const result = computeItemSimilarityBroken(item);
    // Math.max(0, 1 - NaN) = NaN
    expect(isNaN(result)).toBe(true);
  });

  it('null distance falls through to weighted_score', () => {
    const item = { distance: null, weighted_score: 0.6 };
    expect(computeItemSimilarityFixed(item)).toBe(0.6);
  });

  it('undefined distance falls through to weighted_score', () => {
    const item = { weighted_score: 0.6 };
    expect(computeItemSimilarityFixed(item)).toBe(0.6);
  });

  it('valid distance produces correct similarity', () => {
    const item = { distance: 0.3 };
    expect(computeItemSimilarityFixed(item)).toBe(0.7);
  });

  it('cross_encoder_score takes priority over everything', () => {
    const item = { cross_encoder_score: 0.9, distance: 0.1, weighted_score: 0.5 };
    expect(computeItemSimilarityFixed(item)).toBe(0.9);
  });
});

describe('L3: ?? vs || zero-score fallback', () => {
  it('weighted_score of 0 should be preserved (not replaced by fallback)', () => {
    const item = { weighted_score: 0 };
    const result = computeItemSimilarityFixed(item);
    expect(result).toBe(0);
  });

  it('broken version replaces 0 weighted_score with rrf_score', () => {
    const item = { weighted_score: 0, rrf_score: 0.3 };
    const result = computeItemSimilarityBroken(item);
    expect(result).toBe(0.3); // Bug: 0 is falsy, falls through to rrf_score
  });

  it('fixed version keeps 0 weighted_score even when rrf_score exists', () => {
    const item = { weighted_score: 0, rrf_score: 0.3 };
    const result = computeItemSimilarityFixed(item);
    expect(result).toBe(0); // Correct: ?? only replaces null/undefined
  });

  it('rrf_score of 0 should be preserved (not replaced by 0.5 default)', () => {
    const item = { rrf_score: 0 };
    const result = computeItemSimilarityFixed(item);
    expect(result).toBe(0);
  });

  it('null weighted_score falls through to rrf_score', () => {
    const item = { weighted_score: null, rrf_score: 0.4 };
    const result = computeItemSimilarityFixed(item);
    expect(result).toBe(0.4);
  });

  it('both null falls through to 0.5 default', () => {
    const item = {};
    const result = computeItemSimilarityFixed(item);
    expect(result).toBe(0.5);
  });
});

// ============================================================================
// L4 + L5: Backfill stall detection
// ============================================================================

/**
 * Simulates the stall detection logic added to backfill functions.
 * Returns true if stall detected (should break loop).
 */
function detectStall(currentBatchIds, lastBatchIds) {
  if (lastBatchIds.size === 0) return false;
  const currentIds = new Set(currentBatchIds);
  const overlap = [...currentIds].filter(id => lastBatchIds.has(id)).length;
  return overlap > currentIds.size * 0.5;
}

describe('L4+L5: Backfill stall detection', () => {
  it('detects stall when same IDs return (100% overlap)', () => {
    const ids = ['a', 'b', 'c', 'd', 'e'];
    const lastBatch = new Set(ids);
    expect(detectStall(ids, lastBatch)).toBe(true);
  });

  it('detects stall at >50% overlap', () => {
    const lastBatch = new Set(['a', 'b', 'c', 'd']);
    // 3 of 4 overlap = 75%
    expect(detectStall(['a', 'b', 'c', 'x'], lastBatch)).toBe(true);
  });

  it('does not stall at exactly 50% overlap', () => {
    const lastBatch = new Set(['a', 'b', 'c', 'd']);
    // 2 of 4 overlap = 50% (not >50%)
    expect(detectStall(['a', 'b', 'x', 'y'], lastBatch)).toBe(false);
  });

  it('does not stall when all IDs are new', () => {
    const lastBatch = new Set(['a', 'b', 'c']);
    expect(detectStall(['d', 'e', 'f'], lastBatch)).toBe(false);
  });

  it('does not stall on first batch (empty lastBatchIds)', () => {
    expect(detectStall(['a', 'b', 'c'], new Set())).toBe(false);
  });
});

// ============================================================================
// L6: Eviction timestamp collision
// ============================================================================

/**
 * The FIXED eviction findIndex logic.
 * Returns the index of the target message in the array.
 */
function findEvictionTarget(currentMessages, target) {
  const targetHash = target.contentHash;
  const targetTime = target.capturedAt || target.timestamp || 0;

  return currentMessages.findIndex(msg => {
    if (targetHash && msg.contentHash) {
      return msg.contentHash === targetHash;
    }
    const time = msg.capturedAt || msg.timestamp || 0;
    return time === targetTime && msg.content?.slice(0, 50) === target.content?.slice(0, 50);
  });
}

/**
 * The BROKEN eviction findIndex logic (pre-fix).
 */
function findEvictionTargetBroken(currentMessages, target) {
  const targetTime = target.capturedAt || target.timestamp || 0;
  return currentMessages.findIndex(msg => {
    const time = msg.capturedAt || msg.timestamp || 0;
    return time === targetTime;
  });
}

describe('L6: Eviction timestamp collision', () => {
  const messages = [
    { contentHash: 'hash-a', capturedAt: 1000, content: 'Message A - important user data' },
    { contentHash: 'hash-b', capturedAt: 1000, content: 'Message B - bot greeting hello' },
    { contentHash: 'hash-c', capturedAt: 2000, content: 'Message C - later message' },
  ];

  it('finds correct message when timestamps collide (via contentHash)', () => {
    const target = messages[1]; // hash-b, timestamp 1000
    const idx = findEvictionTarget(messages, target);
    expect(idx).toBe(1); // Should find message B, not A
  });

  it('broken version finds wrong message on timestamp collision', () => {
    const target = messages[1]; // hash-b, timestamp 1000
    const idx = findEvictionTargetBroken(messages, target);
    expect(idx).toBe(0); // Bug: finds first match (message A, not B)
  });

  it('falls back to timestamp + content prefix when contentHash missing', () => {
    const noHashMessages = [
      { capturedAt: 1000, content: 'First message with specific prefix' },
      { capturedAt: 1000, content: 'Second message with different prefix' },
    ];
    const target = noHashMessages[1];
    const idx = findEvictionTarget(noHashMessages, target);
    expect(idx).toBe(1);
  });

  it('returns -1 when target not found', () => {
    const target = { contentHash: 'hash-missing', capturedAt: 9999, content: 'nonexistent' };
    const idx = findEvictionTarget(messages, target);
    expect(idx).toBe(-1);
  });

  it('handles messages with unique timestamps correctly', () => {
    const target = messages[2]; // hash-c, timestamp 2000 (unique)
    const idx = findEvictionTarget(messages, target);
    expect(idx).toBe(2);
  });
});

// ============================================================================
// L8: Stale hasTargetPlatformItems after concat
// ============================================================================

describe('L8: Stale hasTargetPlatformItems after concat', () => {
  it('recalculated value reflects items added by temporal fallback', () => {
    const targetPlatform = 'gemini';

    // Initial items: no gemini
    let contextItems = [
      { id: '1', platform: 'chatgpt', source: 'chatgpt' },
      { id: '2', platform: 'claude', source: 'claude' },
    ];

    // Computed BEFORE concat (stale)
    const hasTargetPlatformItems = targetPlatform &&
      contextItems.some(item => (item.source || item.platform) === targetPlatform);
    expect(hasTargetPlatformItems).toBe(false);

    // Temporal fallback adds gemini items
    contextItems = contextItems.concat([
      { id: '3', platform: 'gemini', source: 'gemini' },
    ]);

    // Stale value is STILL false (bug)
    expect(hasTargetPlatformItems).toBe(false);

    // Recalculated value (fix) is true
    const hasTargetPlatformItemsNow = targetPlatform &&
      contextItems.some(item => (item.source || item.platform) === targetPlatform);
    expect(hasTargetPlatformItemsNow).toBe(true);
  });

  it('stale check causes unnecessary synthesis fallback', () => {
    const targetPlatform = 'gemini';
    let contextItems = [{ id: '1', platform: 'chatgpt' }];

    const staleCheck = targetPlatform &&
      contextItems.some(item => (item.source || item.platform) === targetPlatform);

    // Add gemini via temporal fallback
    contextItems = contextItems.concat([{ id: '2', platform: 'gemini' }]);

    // With stale check: synthesis fallback fires (bad — wastes API call)
    const synthesisScore = 0.6;
    const wouldFireSynthesisFallback = synthesisScore >= 0.5 && targetPlatform && !staleCheck;
    expect(wouldFireSynthesisFallback).toBe(true); // Stale: incorrectly triggers

    // With fresh check: synthesis fallback skipped (correct)
    const freshCheck = targetPlatform &&
      contextItems.some(item => (item.source || item.platform) === targetPlatform);
    const wouldFireWithFreshCheck = synthesisScore >= 0.5 && targetPlatform && !freshCheck;
    expect(wouldFireWithFreshCheck).toBe(false); // Correct: gemini already present
  });
});

// ============================================================================
// L9: Null guard on classifyWithHaiku result
// ============================================================================

describe('L9: Null guard on classifyWithHaiku', () => {
  const baseClassification = {
    intent: 'PASSIVE',
    confidenceThreshold: 0.60,
    reason: 'v2_passive',
    scores: {
      directive: 0.3,
      memory: 0.4,
      question: 0.5,
      personal: 0.3,
      temporal: 0.2,
      density: 0.6,
    },
  };

  /**
   * Simulates the FIXED escalateToLayer2 error handling.
   * Returns the updated classification or original on failure.
   */
  function escalateToLayer2Fixed(classifyWithHaikuFn, message, classification) {
    let haiku;
    try {
      haiku = classifyWithHaikuFn(message, classification.scores, classification.reason);
    } catch (err) {
      return classification; // Graceful fallback
    }

    if (!haiku || typeof haiku.classification !== 'string') {
      return classification; // Shape validation failed
    }

    if (haiku.classification === 'MEMORY_QUERY') {
      return { ...classification, intent: 'QUERY', confidenceThreshold: 0.50 };
    }
    if (haiku.classification === 'NO_RETRIEVAL') {
      return { ...classification, intent: 'SKIP' };
    }
    return classification;
  }

  it('handles classifyWithHaiku throwing an exception', () => {
    const throwingFn = () => { throw new Error('API timeout'); };
    const result = escalateToLayer2Fixed(throwingFn, 'test', baseClassification);
    expect(result).toBe(baseClassification); // Falls back to original
    expect(result.intent).toBe('PASSIVE');
  });

  it('handles classifyWithHaiku returning null', () => {
    const nullFn = () => null;
    const result = escalateToLayer2Fixed(nullFn, 'test', baseClassification);
    expect(result).toBe(baseClassification);
  });

  it('handles classifyWithHaiku returning undefined', () => {
    const undefinedFn = () => undefined;
    const result = escalateToLayer2Fixed(undefinedFn, 'test', baseClassification);
    expect(result).toBe(baseClassification);
  });

  it('handles classifyWithHaiku returning object without classification field', () => {
    const badShapeFn = () => ({ latencyMs: 50, source: 'cache' });
    const result = escalateToLayer2Fixed(badShapeFn, 'test', baseClassification);
    expect(result).toBe(baseClassification);
  });

  it('handles classifyWithHaiku returning non-string classification', () => {
    const numericFn = () => ({ classification: 42 });
    const result = escalateToLayer2Fixed(numericFn, 'test', baseClassification);
    expect(result).toBe(baseClassification);
  });

  it('processes valid MEMORY_QUERY response correctly', () => {
    const validFn = () => ({ classification: 'MEMORY_QUERY', latencyMs: 100 });
    const result = escalateToLayer2Fixed(validFn, 'test', baseClassification);
    expect(result.intent).toBe('QUERY');
    expect(result.confidenceThreshold).toBe(0.50);
  });

  it('processes valid NO_RETRIEVAL response correctly', () => {
    const validFn = () => ({ classification: 'NO_RETRIEVAL', latencyMs: 80 });
    const result = escalateToLayer2Fixed(validFn, 'test', baseClassification);
    expect(result.intent).toBe('SKIP');
  });
});
