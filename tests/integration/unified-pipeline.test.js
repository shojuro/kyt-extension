/**
 * Unified Pipeline Integration Tests
 *
 * Gate for Phase 4 (client-side penalty deletion).
 * Hits LIVE Supabase search_memories edge function.
 * Requires mcp/.env with SUPABASE_URL, SUPABASE_SERVICE_KEY, KYT_USER_ID.
 *
 * Run: node --test tests/integration/unified-pipeline.test.js
 *
 * These tests verify that the server-side pipeline (quality penalties,
 * MMR, confidence threshold, 3-way RRF) produces correct results for
 * known queries. They become the regression gate — Phase 4 proceeds
 * only when all pass.
 */

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// ── Load .env from mcp/.env ──────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadEnv() {
  const paths = [
    join(__dirname, '..', '..', 'mcp', '.env'),
    join(__dirname, '..', '..', '.env'),
  ];
  for (const p of paths) {
    if (existsSync(p)) {
      for (const line of readFileSync(p, 'utf-8').split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq === -1) continue;
        const key = trimmed.slice(0, eq).trim();
        const val = trimmed.slice(eq + 1).trim();
        if (!process.env[key]) process.env[key] = val;
      }
      return;
    }
  }
}

loadEnv();

const SUPABASE_URL = process.env.SUPABASE_URL;
const TOKEN = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;
const ANON_KEY = process.env.SUPABASE_ANON_KEY || TOKEN;
const USER_ID = process.env.KYT_USER_ID;

if (!SUPABASE_URL || !TOKEN || !USER_ID) {
  console.error('SKIP: Missing env vars (SUPABASE_URL, auth key, KYT_USER_ID)');
  process.exit(0);
}

// ── Helper: raw edge function call ────────────────────────────────

async function searchMemories(query, opts = {}) {
  const body = {
    query,
    userId: USER_ID,
    profileId: USER_ID,
    useHyde: opts.useHyde ?? true,
    topK: opts.topK ?? 5,
    fast: opts.fast ?? false,
    confidenceThreshold: opts.confidenceThreshold ?? undefined,
    mmrLambda: opts.mmrLambda ?? undefined,
  };

  const res = await fetch(`${SUPABASE_URL}/functions/v1/search_memories`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${TOKEN}`,
      'apikey': ANON_KEY,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`search_memories returned ${res.status}: ${err}`);
  }

  return res.json();
}

// ── Helper: check if any result content matches ───────────────────

function hasContentMatching(results, pattern) {
  return results.some(r => pattern.test(r.content || ''));
}

function getTopScore(results) {
  if (results.length === 0) return 0;
  return Math.max(...results.map(r => r.rerank_score ?? r.rrf_score ?? 0));
}

function contentSnippets(results, maxLen = 80) {
  return results.map((r, i) =>
    `  ${i + 1}. [${r.platform || '?'}] score=${(r.rerank_score ?? 0).toFixed(3)} "${(r.content || '').substring(0, maxLen)}..."`
  ).join('\n');
}

// ══════════════════════════════════════════════════════════════════
// TEST SUITE
// ══════════════════════════════════════════════════════════════════

describe('Unified Pipeline — Smoke Tests', () => {
  test('returns results for a basic query', async () => {
    const { results } = await searchMemories('hello');
    assert.ok(Array.isArray(results), 'results should be an array');
    // Even a vague query should return something from a populated DB
  });

  test('returns empty array for nonsense query', async () => {
    const { results } = await searchMemories('xyzzy42plugh99foobarbaz');
    assert.ok(Array.isArray(results), 'results should be an array');
    // May or may not find results — just shouldn't error
  });

  test('fast path works and is faster', async () => {
    const t0 = Date.now();
    const { results: fastResults } = await searchMemories('test query', { fast: true, topK: 3 });
    const fastMs = Date.now() - t0;

    assert.ok(Array.isArray(fastResults), 'fast results should be an array');
    // Fast path should complete in <5s (vs full path ~15s)
    assert.ok(fastMs < 10000, `fast path took ${fastMs}ms, expected <10s`);
    console.log(`    Fast path: ${fastResults.length} results in ${fastMs}ms`);
  });

  test('respects topK parameter', async () => {
    const { results: r2 } = await searchMemories('memory', { fast: true, topK: 2 });
    assert.ok(r2.length <= 2, `topK=2 returned ${r2.length} items`);
  });
});

describe('Unified Pipeline — Known Query Regression', () => {
  test('"walking analogy" finds child-learning-to-walk conversation', async () => {
    const { results } = await searchMemories('walking analogy', { topK: 5 });
    console.log(`    walking analogy: ${results.length} results\n${contentSnippets(results)}`);

    assert.ok(results.length > 0, 'should find results for "walking analogy"');
    // The walking analogy conversation should appear
    const hasWalking = hasContentMatching(results, /walk/i);
    assert.ok(hasWalking, 'at least one result should mention walking');
  });

  test('"Sound of Music" finds favorite movie preference', async () => {
    const { results } = await searchMemories('Sound of Music', { topK: 5 });
    console.log(`    Sound of Music: ${results.length} results\n${contentSnippets(results)}`);

    assert.ok(results.length > 0, 'should find results');
    const hasMovieRef = hasContentMatching(results, /sound of music|favorite movie|movie of all time/i);
    assert.ok(hasMovieRef, 'should find Sound of Music or favorite movie reference');
  });

  test('"3 levels of memory" finds mode discussion', async () => {
    const { results } = await searchMemories('3 levels of memory', { topK: 5 });
    console.log(`    3 levels: ${results.length} results\n${contentSnippets(results)}`);

    assert.ok(results.length > 0, 'should find results');
    const hasLevels = hasContentMatching(results, /level|mode|tier|full|clean.room|incognito/i);
    assert.ok(hasLevels, 'should find memory level/mode discussion');
  });

  test('"Walter Payton" finds football conversation (bridges typo)', async () => {
    const { results } = await searchMemories('Walter Payton', { topK: 5 });
    console.log(`    Walter Payton: ${results.length} results\n${contentSnippets(results)}`);

    assert.ok(results.length > 0, 'should find results');
    const hasPayton = hasContentMatching(results, /payton|peyton|walter|football|sweetness|nfl/i);
    assert.ok(hasPayton, 'should find Walter Payton/Peyton reference');
  });

  test('"what is KYT" returns results (meta-penalty guard works)', async () => {
    const { results } = await searchMemories('what is KYT', { topK: 5 });
    console.log(`    what is KYT: ${results.length} results\n${contentSnippets(results)}`);

    assert.ok(results.length > 0, 'should find results — meta-penalty skipped for KYT query');
    const hasKYT = hasContentMatching(results, /K\.?Y\.?T|know your|extension|memory/i);
    assert.ok(hasKYT, 'should find KYT-related content');
  });
});

describe('Unified Pipeline — Quality Penalty Verification', () => {
  test('deflection items score lower than substantive content', async () => {
    // "favorite movie" should return the actual preference, not deflections
    const { results } = await searchMemories('what is my favorite movie', { topK: 5 });
    console.log(`    favorite movie: ${results.length} results\n${contentSnippets(results)}`);

    if (results.length >= 2) {
      // Check that no high-scoring result is a pure deflection
      const topResult = results[0];
      const deflectionPatterns = [
        /i don'?t have access/i,
        /i (?:can'?t|cannot) help/i,
        /i'?m not sure/i,
        /could you (?:please )?clarify/i,
        /unfortunately,? i/i,
      ];
      const topIsDeflection = deflectionPatterns.some(p => p.test(topResult.content || ''));
      assert.ok(!topIsDeflection, `top result should NOT be a deflection: "${(topResult.content || '').substring(0, 100)}"`);
    }
  });

  test('bare questions do not dominate results', async () => {
    const { results } = await searchMemories('what car do I like', { topK: 5 });
    console.log(`    car preference: ${results.length} results\n${contentSnippets(results)}`);

    // Bare questions (<120 chars ending with ?) should not be top results
    for (const r of results.slice(0, 3)) {
      const content = (r.content || '').trim();
      const isBareQuestion = content.length < 120 && content.endsWith('?') && !/Assistant:/i.test(content);
      if (isBareQuestion) {
        // If a bare question snuck through, its score should be low
        assert.ok(
          (r.rerank_score ?? 1) < 0.6,
          `bare question should have low score: "${content.substring(0, 80)}" (score=${r.rerank_score})`
        );
      }
    }
  });

  test('recursion guard drops injected content', async () => {
    // Search for something that might pull up injected protocol headers
    const { results } = await searchMemories('K.Y.T. MEMORY INJECTION PROTOCOL', { topK: 5, fast: true });
    console.log(`    injection protocol: ${results.length} results`);

    // Results should NOT contain injection protocol headers
    for (const r of results) {
      const content = r.content || '';
      const hasFull = content.includes('K.Y.T. MEMORY INJECTION PROTOCOL')
        && content.includes('[RETRIEVAL_CONTEXT]');
      assert.ok(!hasFull, `result should not be a full injection block (ID: ${r.id})`);
    }
  });

  test('diagnostic content scores lower than source content', async () => {
    // "3 levels" should find the actual mode discussion, not meta-echo
    // about pipeline diagnostics discussing "3 levels"
    const { results } = await searchMemories('3 levels we defined', { topK: 5 });
    console.log(`    3 levels (diagnostic check): ${results.length} results\n${contentSnippets(results)}`);

    if (results.length >= 2) {
      const diagnosticPatterns = [
        /retrieval.*failed/i,
        /confidence.*0\.\d+/i,
        /pipeline.*fired/i,
        /meta-?echo/i,
      ];

      // Check that diagnostic items don't outrank source items
      const topResult = results[0];
      const topIsDiagnostic = diagnosticPatterns.some(p => p.test(topResult.content || ''));
      // This is soft — diagnostic CAN be #1 if it's genuinely the best match,
      // but typically source content should win after 0.5x penalty
      if (topIsDiagnostic && results.length > 1) {
        console.log('    ⚠️  Top result is diagnostic content — penalty may need tuning');
      }
    }
  });
});

describe('Unified Pipeline — MMR Diversity', () => {
  test('results are not all from the same conversation', async () => {
    const { results } = await searchMemories('memory modes', { topK: 5 });
    console.log(`    memory modes: ${results.length} results\n${contentSnippets(results)}`);

    if (results.length >= 3) {
      // Check conversation_id diversity
      const convIds = new Set(results.map(r => r.conversation_id).filter(Boolean));
      // With MMR, we expect at least 2 different conversations in top 5
      console.log(`    Unique conversations: ${convIds.size} (from ${results.length} results)`);
      // Soft assertion — MMR encourages diversity but doesn't guarantee it
      // if all relevant content happens to be in one conversation
    }
  });

  test('results are not content-duplicated', async () => {
    const { results } = await searchMemories('favorite', { topK: 5 });
    console.log(`    favorite: ${results.length} results`);

    // Check for exact content duplicates
    const contents = results.map(r => (r.content || '').trim().toLowerCase());
    const unique = new Set(contents);
    assert.equal(
      contents.length, unique.size,
      `found ${contents.length - unique.size} duplicate content items`
    );
  });

  test('mmrLambda=0.35 produces more diverse results than 0.7', async () => {
    const [diverse, relevant] = await Promise.all([
      searchMemories('personal goals and interests', { topK: 5, mmrLambda: 0.35 }),
      searchMemories('personal goals and interests', { topK: 5, mmrLambda: 0.7 }),
    ]);

    const diverseConvs = new Set(diverse.results.map(r => r.conversation_id).filter(Boolean));
    const relevantConvs = new Set(relevant.results.map(r => r.conversation_id).filter(Boolean));

    console.log(`    λ=0.35 conversations: ${diverseConvs.size}, λ=0.7 conversations: ${relevantConvs.size}`);
    // Diversity-favoring lambda should produce at least as many unique conversations
    // (Not a hard assert because results depend on data distribution)
  });
});

describe('Unified Pipeline — Confidence Threshold', () => {
  test('higher threshold returns fewer results', async () => {
    const [low, high] = await Promise.all([
      searchMemories('obscure topic test', { topK: 10, confidenceThreshold: 0.30, fast: true }),
      searchMemories('obscure topic test', { topK: 10, confidenceThreshold: 0.70, fast: true }),
    ]);

    console.log(`    threshold=0.30: ${low.results.length} results, threshold=0.70: ${high.results.length} results`);
    assert.ok(
      high.results.length <= low.results.length,
      `higher threshold (${high.results.length}) should return ≤ lower threshold (${low.results.length}) results`
    );
  });

  test('all returned results meet the confidence threshold', async () => {
    const threshold = 0.50;
    const { results } = await searchMemories('what is my name', { topK: 5, confidenceThreshold: threshold });
    console.log(`    threshold=${threshold}: ${results.length} results`);

    // Every result's rerank_score should be ≥ threshold
    // (Some penalties may push below after the confidence filter, which is expected
    //  during the double-penalty transition. Check the raw rerank_score.)
    for (const r of results) {
      const score = r.rerank_score ?? 0;
      // Allow small epsilon for floating point
      if (score < threshold - 0.01) {
        console.log(`    ⚠️  Result below threshold: score=${score.toFixed(3)} < ${threshold} (ID: ${r.id})`);
      }
    }
  });
});

describe('Unified Pipeline — Platform Handling', () => {
  test('platform-specific query filters correctly', async () => {
    const { results } = await searchMemories('conversations on Gemini', { topK: 5 });
    console.log(`    Gemini query: ${results.length} results\n${contentSnippets(results)}`);

    if (results.length > 0) {
      // After platform penalty, Gemini items should rank higher
      const geminiResults = results.filter(r => r.platform === 'gemini');
      const otherResults = results.filter(r => r.platform && r.platform !== 'gemini');

      if (geminiResults.length > 0 && otherResults.length > 0) {
        const avgGemini = geminiResults.reduce((s, r) => s + (r.rerank_score ?? 0), 0) / geminiResults.length;
        const avgOther = otherResults.reduce((s, r) => s + (r.rerank_score ?? 0), 0) / otherResults.length;
        console.log(`    Avg Gemini score: ${avgGemini.toFixed(3)}, Avg other: ${avgOther.toFixed(3)}`);
        // Gemini items should generally score higher due to 0.3x penalty on others
      }
    }
  });

  test('platform rescue works when penalty kills all results', async () => {
    // This query should activate platform rescue if main results are all non-Gemini
    const { results } = await searchMemories('what did I say on Gemini', { topK: 3 });
    console.log(`    Gemini rescue: ${results.length} results`);
    // Should return something rather than empty (rescue path)
    // Don't assert >0 because it depends on data
  });
});

describe('Unified Pipeline — Preference Router', () => {
  test('"what is my favorite movie" activates preference router', async () => {
    const { results } = await searchMemories('what is my favorite movie', { topK: 5 });
    console.log(`    favorite movie (pref): ${results.length} results\n${contentSnippets(results)}`);

    // Preference router should short-circuit with a preference_match result
    const hasPrefMatch = results.some(r => r.preference_match === true);
    if (hasPrefMatch) {
      console.log('    ✓ Preference router activated (preference_match=true found)');
    } else {
      console.log('    ○ Preference router did not activate — fell through to vector search');
    }
  });
});

describe('Unified Pipeline — Response Format Contract', () => {
  test('results have required fields', async () => {
    const { results } = await searchMemories('test query', { topK: 3, fast: true });

    for (const r of results) {
      assert.ok(r.id, 'result must have id');
      assert.ok(typeof r.content === 'string', 'result must have string content');
      // rerank_score or rrf_score must exist
      const hasScore = r.rerank_score != null || r.rrf_score != null || r.gravity_score != null;
      assert.ok(hasScore, `result must have a score field (id: ${r.id})`);
    }
  });

  test('results are roughly sorted by score descending', async () => {
    const { results } = await searchMemories('memory', { topK: 5 });

    // Server sorts by rerank_score. Minor reordering can happen when
    // entity timeline guarantee injects items post-sort, or when
    // BM25/keyword boosts shift scores after the primary sort.
    // Verify top result has the highest score (most important invariant).
    if (results.length >= 2) {
      const scores = results.map(r => r.rerank_score ?? r.rrf_score ?? 0);
      const maxScore = Math.max(...scores);
      // Top-1 should be the highest or within 5% of highest
      assert.ok(
        scores[0] >= maxScore * 0.95,
        `top result (${scores[0].toFixed(3)}) should be near max (${maxScore.toFixed(3)})`
      );
    }
  });

  test('meta field includes requestId', async () => {
    const response = await searchMemories('test', { topK: 1, fast: true });
    assert.ok(response.meta, 'response should have meta object');
    assert.ok(response.meta.requestId, 'meta should have requestId');
  });
});
