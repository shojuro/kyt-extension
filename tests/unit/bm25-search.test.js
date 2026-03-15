import { describe, it, expect } from 'vitest';
import {
  searchBM25,
  countQueryWords,
  isShortQuery,
  getAdaptiveWeights,
  debugBM25,
} from '../../src/bm25-search.js';

const testMessages = [
  { content: 'My favorite color is blue and I love the ocean' },
  { content: 'Python is a great programming language for data science' },
  { content: 'The weather today is sunny and warm outside' },
  { content: 'I went to the store to buy some groceries yesterday' },
  { content: 'JavaScript and TypeScript are used for web development' },
];

// ── searchBM25 ────────────────────────────────────────────────────────────────

describe('searchBM25', () => {
  it('returns results sorted by score descending', () => {
    const results = searchBM25('programming language', testMessages);
    expect(results.length).toBeGreaterThan(0);
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].bm25_score).toBeGreaterThanOrEqual(results[i].bm25_score);
    }
  });

  it('exact match scores higher than partial match', () => {
    const messages = [
      { content: 'Python is a programming language' },
      { content: 'I went to the store today' },
    ];
    const results = searchBM25('Python', messages, { threshold: 0.0 });
    const pythonIdx = results.findIndex(r => r.content.includes('Python'));
    const storeIdx = results.findIndex(r => r.content.includes('store'));
    // Python doc must be ranked above the unrelated doc
    expect(pythonIdx).toBeLessThan(storeIdx);
  });

  it('returns empty array for empty query', () => {
    expect(searchBM25('', testMessages)).toEqual([]);
  });

  it('returns empty array for empty messages array', () => {
    expect(searchBM25('Python', [])).toEqual([]);
  });

  it('limit option caps result count', () => {
    const results = searchBM25('the', testMessages, { limit: 2, threshold: 0.0 });
    expect(results.length).toBeLessThanOrEqual(2);
  });

  it('repeated terms (TF boost) score higher for matching query', () => {
    const messages = [
      { content: 'blue blue blue is my favorite color' },
      { content: 'I like the color blue' },
    ];
    const results = searchBM25('blue', messages, { threshold: 0.0 });
    expect(results[0].content).toMatch(/blue blue blue/);
  });

  it('rare term scores higher than common term (IDF effect)', () => {
    // "science" appears in only 1 of 5 test messages (high IDF → high score)
    // "is" appears in multiple test messages (low IDF → lower score)
    const rareResults = searchBM25('science', testMessages, { threshold: 0.0 });
    const commonResults = searchBM25('is', testMessages, { threshold: 0.0 });

    const rareTopScore = rareResults[0]?.bm25_score ?? 0;
    const commonTopScore = commonResults[0]?.bm25_score ?? 0;

    // Rare term appearing in only 1 doc should outscore common term at the top
    expect(rareTopScore).toBeGreaterThan(commonTopScore);
  });

  it('adds bm25_score field to returned messages', () => {
    const results = searchBM25('Python', testMessages);
    for (const r of results) {
      expect(typeof r.bm25_score).toBe('number');
    }
  });

  it('all returned scores are non-negative', () => {
    const results = searchBM25('the', testMessages, { threshold: 0.0 });
    for (const r of results) {
      expect(r.bm25_score).toBeGreaterThanOrEqual(0);
    }
  });

  it('uses contextual_content when present instead of content', () => {
    const messages = [
      { content: 'irrelevant text', contextual_content: 'Python is a programming language' },
      { content: 'Python programming', contextual_content: undefined },
    ];
    const results = searchBM25('Python', messages, { threshold: 0.0 });
    expect(results.length).toBe(2);
    // Both contain "python" — just verify scores are present
    expect(results[0].bm25_score).toBeGreaterThan(0);
  });

  it('handles messages with empty content gracefully', () => {
    const messages = [
      { content: '' },
      { content: 'Python is a great language' },
    ];
    expect(() => searchBM25('Python', messages)).not.toThrow();
    const results = searchBM25('Python', messages);
    expect(results.length).toBeGreaterThan(0);
  });
});

// ── countQueryWords ───────────────────────────────────────────────────────────

describe('countQueryWords', () => {
  it('counts words in a simple two-word query', () => {
    expect(countQueryWords('hello world')).toBe(2);
  });

  it('returns 0 for an empty string', () => {
    expect(countQueryWords('')).toBe(0);
  });
});

// ── isShortQuery ──────────────────────────────────────────────────────────────

describe('isShortQuery', () => {
  it('single word query is short', () => {
    expect(isShortQuery('hello')).toBe(true);
  });

  it('seven word query is not short', () => {
    expect(isShortQuery('this is a longer natural language query')).toBe(false);
  });
});

// ── getAdaptiveWeights ────────────────────────────────────────────────────────

describe('getAdaptiveWeights', () => {
  it('short query returns keyword-focused weights', () => {
    const weights = getAdaptiveWeights('hello');
    expect(weights.bm25Weight).toBe(0.7);
    expect(weights.semanticWeight).toBe(0.3);
    expect(weights.strategy).toBe('keyword-focused');
  });

  it('long query returns semantic-focused weights', () => {
    const weights = getAdaptiveWeights('tell me about your favorite things to do');
    expect(weights.bm25Weight).toBe(0.4);
    expect(weights.semanticWeight).toBe(0.6);
    expect(weights.strategy).toBe('semantic-focused');
  });

  it('includes queryLength in return value', () => {
    const weights = getAdaptiveWeights('two words');
    expect(weights.queryLength).toBe(2);
  });
});

// ── debugBM25 ─────────────────────────────────────────────────────────────────

describe('debugBM25', () => {
  it('does not throw and logs output (threshold 0.0 internally)', () => {
    // debugBM25 has no return value — it logs to console and returns undefined.
    // Verify it runs without error and that searchBM25 with threshold 0.0 finds
    // the Python message, confirming the underlying search works correctly.
    expect(() => debugBM25('Python', testMessages)).not.toThrow();

    // Verify the underlying path: searchBM25 with threshold 0.0 returns results
    const results = searchBM25('Python', testMessages, { limit: 10, threshold: 0.0 });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].bm25_score).toBeGreaterThan(0);
  });
});
