import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  extractKeywords,
  scoreByTitle,
  scoreByEntityGraph,
  mergeAndRank,
  getCachedNotebooks,
  clearNotebookCache,
} from '../src/lib/notebook-discovery.js';

// ============================================================================
// extractKeywords Tests
// ============================================================================

describe('extractKeywords', () => {
  test('extracts meaningful words', () => {
    const kws = extractKeywords('What is the role of NATO in Ukraine?');
    assert.ok(kws.includes('role'));
    assert.ok(kws.includes('nato'));
    assert.ok(kws.includes('ukraine'));
  });

  test('strips stopwords', () => {
    const kws = extractKeywords('What is the best way to learn');
    assert.ok(!kws.includes('what'));
    assert.ok(!kws.includes('is'));
    assert.ok(!kws.includes('the'));
    assert.ok(!kws.includes('to'));
    assert.ok(kws.includes('best'));
    assert.ok(kws.includes('way'));
    assert.ok(kws.includes('learn'));
  });

  test('lowercases everything', () => {
    const kws = extractKeywords('NATO Ukraine WASHINGTON');
    assert.deepEqual(kws, ['nato', 'ukraine', 'washington']);
  });

  test('strips punctuation', () => {
    const kws = extractKeywords('Hello, world! How are you?');
    assert.ok(!kws.some(k => k.includes(',')));
    assert.ok(!kws.some(k => k.includes('!')));
    assert.ok(!kws.some(k => k.includes('?')));
  });

  test('strips emoji', () => {
    const kws = extractKeywords('🌸 The Book Room 📚');
    assert.ok(kws.includes('book'));
    assert.ok(kws.includes('room'));
    assert.ok(!kws.some(k => k.includes('🌸')));
  });

  test('handles empty/null input', () => {
    assert.deepEqual(extractKeywords(''), []);
    assert.deepEqual(extractKeywords(null), []);
    assert.deepEqual(extractKeywords(undefined), []);
  });

  test('filters single-char words', () => {
    const kws = extractKeywords('I a go x NATO');
    assert.ok(!kws.includes('x'));
    assert.ok(kws.includes('nato'));
  });

  test('preserves hyphens in words', () => {
    const kws = extractKeywords('anti-war sentiment');
    assert.ok(kws.includes('anti-war'));
    assert.ok(kws.includes('sentiment'));
  });
});

// ============================================================================
// scoreByTitle Tests
// ============================================================================

const MOCK_NOTEBOOKS = [
  { id: 'nb1', title: 'Provoked: Washington\'s Role in the Ukraine Catastrophe', sourceCount: 191 },
  { id: 'nb2', title: 'Predictive History', sourceCount: 125 },
  { id: 'nb3', title: 'The School of Life', sourceCount: 298 },
  { id: 'nb4', title: 'NATO Enlargement and Its Consequences', sourceCount: 5 },
  { id: 'nb5', title: '🌸🔰The Book Room', sourceCount: 187 },
  { id: 'nb6', title: '', sourceCount: 0 },
  { id: 'nb7', title: 'Academy of Ideas', sourceCount: 228 },
];

describe('scoreByTitle', () => {
  test('exact word matches score higher than substrings', () => {
    const results = scoreByTitle(MOCK_NOTEBOOKS, ['nato']);
    const nb4 = results.find(r => r.notebookId === 'nb4');
    assert.ok(nb4);
    assert.ok(nb4.titleScore > 0);
    assert.ok(nb4.matchedTerms.includes('nato'));
  });

  test('matches multiple keywords', () => {
    const results = scoreByTitle(MOCK_NOTEBOOKS, ['washington', 'ukraine']);
    const nb1 = results.find(r => r.notebookId === 'nb1');
    assert.ok(nb1);
    assert.ok(nb1.matchedTerms.length >= 2);
  });

  test('returns empty for no matches', () => {
    const results = scoreByTitle(MOCK_NOTEBOOKS, ['quantum', 'physics']);
    assert.equal(results.length, 0);
  });

  test('returns empty for empty keywords', () => {
    assert.deepEqual(scoreByTitle(MOCK_NOTEBOOKS, []), []);
  });

  test('returns empty for empty notebooks', () => {
    assert.deepEqual(scoreByTitle([], ['nato']), []);
  });

  test('skips notebooks with empty titles', () => {
    const results = scoreByTitle(MOCK_NOTEBOOKS, ['book']);
    assert.ok(!results.find(r => r.notebookId === 'nb6'));
  });

  test('handles emoji in titles', () => {
    const results = scoreByTitle(MOCK_NOTEBOOKS, ['book', 'room']);
    const nb5 = results.find(r => r.notebookId === 'nb5');
    assert.ok(nb5);
    assert.ok(nb5.titleScore > 0);
  });

  test('results sorted by score descending', () => {
    const results = scoreByTitle(MOCK_NOTEBOOKS, ['history']);
    for (let i = 1; i < results.length; i++) {
      assert.ok(results[i - 1].titleScore >= results[i].titleScore);
    }
  });

  test('score capped at 1.0', () => {
    const results = scoreByTitle(MOCK_NOTEBOOKS, ['provoked', 'washington', 'role', 'ukraine', 'catastrophe']);
    for (const r of results) {
      assert.ok(r.titleScore <= 1.0);
    }
  });

  test('sourceCount bonus applied for non-empty notebooks', () => {
    // Use multiple keywords where only one matches (substring) to keep base score < 1.0
    const notebooks = [
      { id: 'a', title: 'introduction to topics', sourceCount: 100 },
      { id: 'b', title: 'introduction to topics', sourceCount: 0 },
    ];
    // 'intro' is a substring match (0.8), 'xyz' doesn't match → score = 0.8/2 = 0.4
    const results = scoreByTitle(notebooks, ['intro', 'xyz']);
    const a = results.find(r => r.notebookId === 'a');
    const b = results.find(r => r.notebookId === 'b');
    assert.ok(a);
    assert.ok(b);
    assert.ok(a.titleScore > b.titleScore, `expected ${a.titleScore} > ${b.titleScore}`);
  });
});

// ============================================================================
// scoreByEntityGraph Tests
// ============================================================================

describe('scoreByEntityGraph', () => {
  test('maps entity project_ids to notebooks', () => {
    const entities = [{ entity_text: 'NATO', mention_count: 50 }];
    const projectIds = [
      { project_id: 'proj1' },
      { project_id: 'proj1' },
      { project_id: 'proj2' },
    ];
    const map = new Map([['proj1', 'nb1'], ['proj2', 'nb2']]);

    const results = scoreByEntityGraph(entities, projectIds, map);
    assert.equal(results.length, 2);
    assert.equal(results[0].notebookId, 'nb1'); // Higher count
    assert.ok(results[0].entityScore > results[1].entityScore);
  });

  test('returns empty for no entities', () => {
    assert.deepEqual(scoreByEntityGraph([], [{ project_id: 'p1' }], new Map([['p1', 'nb1']])), []);
  });

  test('returns empty for no project mappings', () => {
    const entities = [{ entity_text: 'NATO', mention_count: 5 }];
    assert.deepEqual(scoreByEntityGraph(entities, [{ project_id: 'p1' }], new Map()), []);
  });

  test('skips null project_ids', () => {
    const entities = [{ entity_text: 'test', mention_count: 1 }];
    const projectIds = [{ project_id: null }, { project_id: 'p1' }];
    const map = new Map([['p1', 'nb1']]);
    const results = scoreByEntityGraph(entities, projectIds, map);
    assert.equal(results.length, 1);
  });

  test('skips unmapped project_ids', () => {
    const entities = [{ entity_text: 'test', mention_count: 1 }];
    const projectIds = [{ project_id: 'unmapped' }];
    const map = new Map([['p1', 'nb1']]);
    const results = scoreByEntityGraph(entities, projectIds, map);
    assert.equal(results.length, 0);
  });

  test('includes entity names in results', () => {
    const entities = [
      { entity_text: 'NATO', mention_count: 50 },
      { entity_text: 'Ukraine', mention_count: 30 },
    ];
    const projectIds = [{ project_id: 'p1' }];
    const map = new Map([['p1', 'nb1']]);
    const results = scoreByEntityGraph(entities, projectIds, map);
    assert.ok(results[0].matchedEntities.includes('NATO'));
    assert.ok(results[0].matchedEntities.includes('Ukraine'));
  });
});

// ============================================================================
// mergeAndRank Tests
// ============================================================================

describe('mergeAndRank', () => {
  test('combines title and entity scores', () => {
    const titleScored = [
      { notebookId: 'nb1', title: 'Provoked', sourceCount: 10, titleScore: 0.8, matchedTerms: ['washington'] },
    ];
    const entityScored = [
      { notebookId: 'nb1', entityScore: 0.9, matchedEntities: ['NATO'] },
    ];

    const results = mergeAndRank(titleScored, entityScored);
    assert.equal(results.length, 1);
    assert.equal(results[0].notebookId, 'nb1');
    // combinedScore = 0.8*0.6 + 0.9*0.4 = 0.48 + 0.36 = 0.84
    assert.ok(Math.abs(results[0].combinedScore - 0.84) < 0.01);
    assert.ok(results[0].reason.includes('title'));
    assert.ok(results[0].reason.includes('entities'));
  });

  test('title-only notebooks included', () => {
    const titleScored = [
      { notebookId: 'nb1', title: 'Test', sourceCount: 5, titleScore: 0.7, matchedTerms: ['test'] },
    ];
    const results = mergeAndRank(titleScored, []);
    assert.equal(results.length, 1);
    // combinedScore = 0.7*0.6 = 0.42
    assert.ok(Math.abs(results[0].combinedScore - 0.42) < 0.01);
  });

  test('entity-only notebooks included', () => {
    const entityScored = [
      { notebookId: 'nb2', entityScore: 0.6, matchedEntities: ['NATO'] },
    ];
    const results = mergeAndRank([], entityScored);
    assert.equal(results.length, 1);
    // combinedScore = 0.6*0.4 = 0.24
    assert.ok(Math.abs(results[0].combinedScore - 0.24) < 0.01);
  });

  test('deduplicates by notebookId', () => {
    const titleScored = [
      { notebookId: 'nb1', title: 'Test', sourceCount: 5, titleScore: 0.5, matchedTerms: ['test'] },
    ];
    const entityScored = [
      { notebookId: 'nb1', entityScore: 0.5, matchedEntities: ['entity'] },
    ];
    const results = mergeAndRank(titleScored, entityScored);
    assert.equal(results.length, 1);
  });

  test('sorted by combinedScore descending', () => {
    const titleScored = [
      { notebookId: 'nb1', title: 'A', sourceCount: 1, titleScore: 0.3, matchedTerms: ['a'] },
      { notebookId: 'nb2', title: 'B', sourceCount: 1, titleScore: 0.9, matchedTerms: ['b'] },
    ];
    const results = mergeAndRank(titleScored, []);
    assert.equal(results[0].notebookId, 'nb2');
    assert.equal(results[1].notebookId, 'nb1');
  });

  test('handles empty inputs', () => {
    assert.deepEqual(mergeAndRank([], []), []);
  });

  test('reason string contains matched terms and entities', () => {
    const titleScored = [
      { notebookId: 'nb1', title: 'X', sourceCount: 1, titleScore: 0.5, matchedTerms: ['nato', 'war'] },
    ];
    const entityScored = [
      { notebookId: 'nb1', entityScore: 0.5, matchedEntities: ['Ukraine', 'Russia'] },
    ];
    const results = mergeAndRank(titleScored, entityScored);
    assert.ok(results[0].reason.includes('nato'));
    assert.ok(results[0].reason.includes('Ukraine'));
  });
});

// ============================================================================
// getCachedNotebooks Tests
// ============================================================================

describe('getCachedNotebooks', () => {
  test('calls listFn on first call', async () => {
    clearNotebookCache();
    let called = 0;
    const mockList = async () => { called++; return [{ id: 'nb1' }]; };
    const result = await getCachedNotebooks(mockList);
    assert.equal(called, 1);
    assert.deepEqual(result, [{ id: 'nb1' }]);
  });

  test('returns cached on second call', async () => {
    let called = 0;
    const mockList = async () => { called++; return [{ id: 'nb2' }]; };
    // Cache should still be warm from previous test
    const result = await getCachedNotebooks(mockList);
    assert.equal(called, 0); // Not called again
    assert.deepEqual(result, [{ id: 'nb1' }]); // Returns cached value
  });

  test('refresh bypasses cache', async () => {
    let called = 0;
    const mockList = async () => { called++; return [{ id: 'nb3' }]; };
    const result = await getCachedNotebooks(mockList, true);
    assert.equal(called, 1);
    assert.deepEqual(result, [{ id: 'nb3' }]);
  });

  test('clearNotebookCache forces re-fetch', async () => {
    clearNotebookCache();
    let called = 0;
    const mockList = async () => { called++; return [{ id: 'nb4' }]; };
    const result = await getCachedNotebooks(mockList);
    assert.equal(called, 1);
    assert.deepEqual(result, [{ id: 'nb4' }]);
  });
});
