import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { scoreMemorability, filterForMemorability, MEMORABILITY_THRESHOLD } from '../src/lib/memorability-filter.js';

describe('memorability-filter', () => {

  // ── Unmemorable cases ──────────────────────────────────────

  test('short directives are unmemorable', () => {
    assert.ok(scoreMemorability({ role: 'user', content: 'ok' }) < MEMORABILITY_THRESHOLD);
    assert.ok(scoreMemorability({ role: 'user', content: 'yes' }) < MEMORABILITY_THRESHOLD);
    assert.ok(scoreMemorability({ role: 'user', content: 'continue' }) < MEMORABILITY_THRESHOLD);
    assert.ok(scoreMemorability({ role: 'user', content: 'thanks!' }) < MEMORABILITY_THRESHOLD);
    assert.ok(scoreMemorability({ role: 'user', content: "let's do it" }) < MEMORABILITY_THRESHOLD);
  });

  test('line-reference fixes are unmemorable', () => {
    assert.ok(scoreMemorability({ role: 'user', content: 'fix the typo on line 42' }) < MEMORABILITY_THRESHOLD);
    assert.ok(scoreMemorability({ role: 'user', content: 'fix the error on line 123' }) < MEMORABILITY_THRESHOLD);
  });

  test('file-path-only references are unmemorable', () => {
    assert.ok(scoreMemorability({ role: 'user', content: 'look at src/foo.js:23' }) < MEMORABILITY_THRESHOLD);
    assert.ok(scoreMemorability({ role: 'user', content: 'check src/utils/helper.ts' }) < MEMORABILITY_THRESHOLD);
  });

  test('assistant acks are unmemorable', () => {
    assert.ok(scoreMemorability({ role: 'assistant', content: 'Done.' }) < MEMORABILITY_THRESHOLD);
    assert.ok(scoreMemorability({ role: 'assistant', content: 'Fixed.' }) < MEMORABILITY_THRESHOLD);
    assert.ok(scoreMemorability({ role: 'assistant', content: 'Got it.' }) < MEMORABILITY_THRESHOLD);
    assert.ok(scoreMemorability({ role: 'assistant', content: 'Ok.' }) < MEMORABILITY_THRESHOLD);
  });

  test('very short content is unmemorable', () => {
    assert.ok(scoreMemorability({ role: 'user', content: 'hi' }) < MEMORABILITY_THRESHOLD);
    assert.ok(scoreMemorability({ role: 'user', content: 'thanks' }) < MEMORABILITY_THRESHOLD);
  });

  test('code-only blocks are unmemorable', () => {
    const code = '```\nfunction foo() { return 1; }\n```';
    assert.ok(scoreMemorability({ role: 'user', content: code }) < MEMORABILITY_THRESHOLD);
  });

  // ── Memorable cases ────────────────────────────────────────

  test('architectural decisions are memorable', () => {
    const score = scoreMemorability({
      role: 'user',
      content: 'We decided to use stdio transport because it avoids port conflicts and CORS complexity.',
    });
    assert.ok(score >= MEMORABILITY_THRESHOLD, `score ${score} should be >= ${MEMORABILITY_THRESHOLD}`);
  });

  test('personal context is memorable', () => {
    const score = scoreMemorability({
      role: 'user',
      content: 'My project uses Supabase for the backend with RLS policies on all tables.',
    });
    assert.ok(score >= MEMORABILITY_THRESHOLD, `score ${score} should be >= ${MEMORABILITY_THRESHOLD}`);
  });

  test('definition/convention statements are memorable', () => {
    const score = scoreMemorability({
      role: 'user',
      content: 'The pattern we defined is: each MCP tool exports a schema object and an async handler function.',
    });
    assert.ok(score >= MEMORABILITY_THRESHOLD, `score ${score} should be >= ${MEMORABILITY_THRESHOLD}`);
  });

  test('substantive assistant responses are memorable', () => {
    const longResponse = 'The retrieval pipeline has three stages: embedding generation, vector search, and reranking. ' +
      'Each stage has different latency characteristics. The embedding step is the fastest at 80-100ms. ' +
      'Vector search depends on the index type and query complexity, typically 80-100ms with HNSW. ' +
      'Reranking with a cross-encoder is the most expensive at 2-4 seconds.';
    const score = scoreMemorability({ role: 'assistant', content: longResponse });
    assert.ok(score >= MEMORABILITY_THRESHOLD, `score ${score} should be >= ${MEMORABILITY_THRESHOLD}`);
  });

  test('temporal references are memorable', () => {
    const score = scoreMemorability({
      role: 'user',
      content: 'Yesterday we discussed the entity graph walk approach for improving retrieval quality.',
    });
    assert.ok(score >= MEMORABILITY_THRESHOLD, `score ${score} should be >= ${MEMORABILITY_THRESHOLD}`);
  });

  // ── filterForMemorability ──────────────────────────────────

  test('filterForMemorability returns correct counts', () => {
    const turns = [
      { role: 'user', content: 'ok' },
      { role: 'user', content: 'We decided to use the graph walk approach for entity relationships.' },
      { role: 'assistant', content: 'Done.' },
      { role: 'assistant', content: 'The graph walk traverses entity_relationships up to depth 2, finding conceptually related chat_turns that vector search misses. This helps surface content connected by entity relationships rather than just embedding similarity.' },
    ];
    const { kept, filtered } = filterForMemorability(turns);
    assert.equal(filtered, 2, 'should filter "ok" and "Done."');
    assert.equal(kept.length, 2, 'should keep the substantive turns');
  });

  test('filterForMemorability keeps all memorable turns', () => {
    const turns = [
      { role: 'user', content: 'My project uses a hybrid search pipeline combining vector search with BM25 keyword matching.' },
      { role: 'assistant', content: 'That approach gives you the best of both worlds. Vector search handles semantic similarity while BM25 catches exact keyword matches that embeddings might miss, especially for technical terms and names.' },
    ];
    const { kept, filtered } = filterForMemorability(turns);
    assert.equal(filtered, 0, 'should filter nothing');
    assert.equal(kept.length, 2, 'should keep both turns');
  });

  test('MEMORABILITY_THRESHOLD is 0.25', () => {
    assert.equal(MEMORABILITY_THRESHOLD, 0.25);
  });
});
