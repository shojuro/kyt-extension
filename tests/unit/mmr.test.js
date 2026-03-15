import { describe, it, expect } from 'vitest';
import { applyMMR, extractEntities, MMR_PRESETS } from '../../src/mmr.js';

// Helper: create a simple normalized embedding vector
function makeEmbedding(dims, offset = 0) {
  const vec = new Array(dims).fill(0).map((_, i) => Math.sin(i + offset));
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  return vec.map(v => v / norm);
}

const dims = 8;
const candidates = [
  { content: 'Jennifer is my sister',     distance: 0.2,  embedding: makeEmbedding(dims, 0)   },
  { content: 'Jennifer likes cats',       distance: 0.25, embedding: makeEmbedding(dims, 0.1) }, // similar to first
  { content: 'Jenn the dog plays fetch',  distance: 0.3,  embedding: makeEmbedding(dims, 5)   }, // different
  { content: 'Weather is sunny today',    distance: 0.5,  embedding: makeEmbedding(dims, 10)  }, // very different
  { content: 'Jennifer went shopping',    distance: 0.35, embedding: makeEmbedding(dims, 0.2) }, // similar to first
];

describe('applyMMR', () => {
  it('test 1: lambda=1.0 returns items in pure relevance order (distance ascending)', () => {
    const result = applyMMR(candidates, 4, 1.0);
    expect(result.length).toBe(4);
    // With lambda=1.0 diversity term is zero, so MMR score = relevance only
    // → order should be strictly ascending by distance
    for (let i = 1; i < result.length; i++) {
      expect(result[i].distance).toBeGreaterThanOrEqual(result[i - 1].distance);
    }
  });

  it('test 2: lambda=0.0 maximises diversity (dissimilar items preferred after first)', () => {
    const result = applyMMR(candidates, 3, 0.0);
    expect(result.length).toBe(3);
    // With lambda=0 we should see the most dissimilar items selected after the first.
    // 'Weather is sunny today' (offset 10) is the most dissimilar — it should appear
    // in the top-3 results even though its distance (0.5) is poor.
    const contents = result.map(r => r.content);
    expect(contents).toContain('Weather is sunny today');
  });

  it('test 3: lambda=0.5 balances relevance and diversity', () => {
    const result = applyMMR(candidates, 3, 0.5);
    expect(result.length).toBe(3);
    // First item must be most relevant
    expect(result[0].content).toBe('Jennifer is my sister');
    // Result count is correct
    expect(result.length).toBeLessThanOrEqual(3);
  });

  it('test 4: first item always has lowest distance (most relevant)', () => {
    const result = applyMMR(candidates, 3, 0.5);
    const minDistance = Math.min(...candidates.map(c => c.distance));
    expect(result[0].distance).toBe(minDistance);
  });

  it('test 5: near-duplicate items (similar embeddings) are penalised in later positions', () => {
    // "Jennifer is my sister" (offset 0) and "Jennifer likes cats" (offset 0.1) have
    // very similar embeddings. With lambda=0.5 the second Jennifer item should not be
    // selected before the clearly different "Jenn the dog" item.
    const result = applyMMR(candidates, 3, 0.5);
    const positions = {};
    result.forEach((item, idx) => { positions[item.content] = idx; });

    // "Jenn the dog plays fetch" (diverse) should appear before or instead of
    // the second near-duplicate Jennifer entry in top-3
    const jenn = positions['Jenn the dog plays fetch'];
    const jenniferCats = positions['Jennifer likes cats'];
    // jenn should appear AND should rank ahead of the near-duplicate (or near-dup absent)
    expect(jenn).toBeDefined();
    if (jenniferCats !== undefined) {
      expect(jenn).toBeLessThan(jenniferCats);
    }
  });

  it('test 6: maxResults limits output count', () => {
    expect(applyMMR(candidates, 2, 0.5).length).toBe(2);
    expect(applyMMR(candidates, 1, 0.5).length).toBe(1);
    expect(applyMMR(candidates, 5, 0.5).length).toBe(5);
  });

  it('test 7: empty input returns empty array', () => {
    expect(applyMMR([], 3)).toEqual([]);
    expect(applyMMR(null, 3)).toEqual([]);
    expect(applyMMR(undefined, 3)).toEqual([]);
  });

  it('test 8: single-item input returns that item', () => {
    const single = [{ content: 'only one', distance: 0.1, embedding: makeEmbedding(4) }];
    const result = applyMMR(single, 5);
    expect(result.length).toBe(1);
    expect(result[0].content).toBe('only one');
  });

  it('test 12: two similar items not both in top-3 with lambda=0.5', () => {
    // "Jennifer is my sister" and "Jennifer likes cats" share near-identical embeddings.
    // With lambda=0.5 at least one of them should be displaced by a diverse item.
    const result = applyMMR(candidates, 3, 0.5);
    const contents = result.map(r => r.content);
    const bothPresent =
      contents.includes('Jennifer is my sister') &&
      contents.includes('Jennifer likes cats');
    // They should NOT both appear — diversity should push one out
    expect(bothPresent).toBe(false);
  });

  it('test 13: items without embeddings fall back to distance order', () => {
    const noEmbCandidates = [
      { content: 'alpha', distance: 0.4 },
      { content: 'beta',  distance: 0.1 },
      { content: 'gamma', distance: 0.3 },
    ];
    const result = applyMMR(noEmbCandidates, 3, 0.5, { fallbackToRelevance: true });
    expect(result.length).toBe(3);
    expect(result[0].content).toBe('beta');   // lowest distance
    expect(result[1].content).toBe('gamma');
    expect(result[2].content).toBe('alpha');
  });

  it('test 14: 100 candidates completes without timeout', () => {
    const large = Array.from({ length: 100 }, (_, i) => ({
      content: `Item ${i}`,
      distance: Math.random(),
      embedding: makeEmbedding(dims, i * 0.1),
    }));
    const start = Date.now();
    const result = applyMMR(large, 10, 0.5);
    const elapsed = Date.now() - start;
    expect(result.length).toBe(10);
    expect(elapsed).toBeLessThan(1000); // should complete well within 1 second
  });
});

describe('extractEntities', () => {
  it('test 9: uses explicit entity field when present', () => {
    const item = { entity: 'Jennifer', content: 'irrelevant content' };
    const entities = extractEntities(item);
    expect(entities.has('jennifer')).toBe(true);
    expect(entities.size).toBe(1);
  });

  it('test 10: extracts proper nouns from content when no entity field', () => {
    const item = { content: 'Jennifer is my sister and Sarah is her friend' };
    const entities = extractEntities(item);
    expect(entities.has('jennifer')).toBe(true);
    expect(entities.has('sarah')).toBe(true);
  });

  it('test 10b: filters ENTITY_STOP_WORDS from extracted proper nouns', () => {
    // "The" and "This" are stop words and should be filtered even when capitalised
    const item = { content: 'The system is broken. This is wrong.' };
    const entities = extractEntities(item);
    expect(entities.has('the')).toBe(false);
    expect(entities.has('this')).toBe(false);
  });
});

describe('MMR_PRESETS', () => {
  it('test 11: exports expected preset configurations', () => {
    expect(MMR_PRESETS.BALANCED).toEqual({ lambda: 0.5, maxResults: 3 });
    expect(MMR_PRESETS.PRECISION).toEqual({ lambda: 0.3, maxResults: 3 });
    expect(MMR_PRESETS.RELEVANCE).toEqual({ lambda: 0.7, maxResults: 5 });
    expect(MMR_PRESETS.CONSERVATIVE).toEqual({ lambda: 0.2, maxResults: 2 });
  });
});
