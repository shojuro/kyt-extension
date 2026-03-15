/**
 * Unit tests for pure/semi-pure function exports from src/context-retrieval.js
 *
 * Tests: extractPlatformMention, withTimeout, stripInjectionPrefix,
 *        detectIsQuestion, detectPreferenceQuery, synthesizePreferenceItems,
 *        and the getContextForInjection pipeline (error path + edge routing).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setupChromeMocks, resetAllMocks } from '../setup.js';

// ============================================================
// ALL vi.mock() calls MUST come before any module imports
// ============================================================

vi.mock('../../src/browser-search.js', () => ({
  searchHybrid: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../src/query-transformer.js', () => ({
  transformQuery: vi.fn().mockResolvedValue({ success: false, transformed: false }),
  fetchRecentTopicsFromSupabase: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../kyt-memory-injection-builder.js', () => ({
  buildMemoryInjection: vi.fn().mockReturnValue('injected context'),
  buildErrorInjection: vi.fn().mockReturnValue('error context'),
}));

vi.mock('../../src/confidence-filter.js', () => ({
  filterByConfidence: vi.fn((items) => items),
}));

vi.mock('../../src/edge-search.js', () => ({
  searchViaEdgeFunction: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../src/intent-classifier.js', () => ({
  classifyIntent: vi.fn(),
  scoreTemporalReference: vi.fn(() => ({ score: 0 })),
  scoreSynthesisIntent: vi.fn(() => ({ score: 0 })),
}));

vi.mock('../../src/hyde-search-generator.js', () => ({
  transformQuery: vi.fn(),
  hydeCB: { isOpen: vi.fn().mockResolvedValue({ open: false }) },
}));

vi.mock('../../src/embedding-circuit-breaker.js', () => ({
  isEmbeddingCircuitOpen: vi.fn().mockResolvedValue({ open: false }),
}));

vi.mock('../../src/supabase-config.js', () => ({
  SUPABASE_URL: 'https://test.supabase.co',
  SUPABASE_ANON_KEY: 'test-anon-key',
}));

vi.mock('../../src/auth-config.js', () => ({
  getApiConfig: vi.fn().mockResolvedValue({
    userId: 'test-user-id',
    accessToken: 'test-token',
    disableQueryTransformation: true,
  }),
  getRoutingMode: vi.fn().mockResolvedValue('legacy'),
}));

vi.mock('../../src/auth/auth-service.js', () => ({
  getAccessToken: vi.fn(),
  AUTH_SESSION_KEY: 'auth_session',
}));

vi.mock('../../src/profile-manager.js', () => ({
  getActiveProfileId: vi.fn().mockResolvedValue('test-profile-id'),
}));

vi.mock('../../src/project-manager.js', () => ({
  getActiveProject: vi.fn().mockResolvedValue({ id: null }),
}));

vi.mock('../../src/recent-topic-cache.js', () => ({
  fetchRecentTopicsFromSupabase: vi.fn().mockResolvedValue([]),
  getRecentTopics: vi.fn().mockResolvedValue([]),
}));

// ============================================================
// NOW import the module under test
// ============================================================

import {
  extractPlatformMention,
  withTimeout,
  stripInjectionPrefix,
  detectIsQuestion,
  detectPreferenceQuery,
  synthesizePreferenceItems,
  getContextForInjection,
  INTERROGATIVE_RE,
} from '../../src/context-retrieval.js';

// Pull in the mocked modules we need to configure per-test
import { searchViaEdgeFunction } from '../../src/edge-search.js';
import { getApiConfig, getRoutingMode } from '../../src/auth-config.js';
import { buildMemoryInjection } from '../../kyt-memory-injection-builder.js';

// ============================================================
// Test setup
// ============================================================

let chromeMocks;

beforeEach(() => {
  chromeMocks = setupChromeMocks();
  resetAllMocks();
  chromeMocks = setupChromeMocks();

  // Reset module-level mocks to safe defaults
  vi.mocked(getApiConfig).mockResolvedValue({
    userId: 'test-user-id',
    accessToken: 'test-token',
    disableQueryTransformation: true,
  });
  vi.mocked(getRoutingMode).mockResolvedValue('legacy');
  vi.mocked(searchViaEdgeFunction).mockResolvedValue([]);
  vi.mocked(buildMemoryInjection).mockReturnValue('injected context');
});

// ============================================================
// extractPlatformMention — 3 tests
// ============================================================

describe('extractPlatformMention', () => {
  it('test 1: detects "Gemini" and normalises to lowercase', () => {
    expect(extractPlatformMention('Tell me about Gemini')).toBe('gemini');
  });

  it('test 2: detects "Claude Code" and normalises to claude-code', () => {
    expect(extractPlatformMention('Claude Code session details')).toBe('claude-code');
  });

  it('test 3: returns null when no platform is mentioned', () => {
    expect(extractPlatformMention('how are you today')).toBeNull();
  });
});

// ============================================================
// withTimeout — 2 tests
// ============================================================

describe('withTimeout', () => {
  it('test 4: resolves with the promise value when faster than the timeout', async () => {
    const fast = Promise.resolve(42);
    const result = await withTimeout(fast, 1000, 'fast-op');
    expect(result).toBe(42);
  });

  it('test 5: resolves with undefined when promise exceeds timeout', async () => {
    const slow = new Promise(resolve => setTimeout(() => resolve('late'), 500));
    const result = await withTimeout(slow, 10, 'slow-op');
    expect(result).toBeUndefined();
  });
});

// ============================================================
// stripInjectionPrefix — 3 tests
// ============================================================

describe('stripInjectionPrefix', () => {
  it('test 6: strips K.Y.T. injection prefix and sets hadInjection=true', () => {
    const input = 'K.Y.T. context block here\n---\n\nActual user content';
    const result = stripInjectionPrefix(input);
    expect(result.hadInjection).toBe(true);
    expect(result.content).toBe('Actual user content');
  });

  it('test 7: leaves plain content unchanged and sets hadInjection=false', () => {
    const result = stripInjectionPrefix('Hello world');
    expect(result.hadInjection).toBe(false);
    expect(result.content).toBe('Hello world');
  });

  it('test 8: handles null input gracefully', () => {
    const result = stripInjectionPrefix(null);
    expect(result.hadInjection).toBe(false);
    // content should be falsy / null / empty string
    expect(result.content == null || result.content === '').toBe(true);
  });
});

// ============================================================
// detectIsQuestion — 3 tests
// ============================================================

describe('detectIsQuestion', () => {
  it('test 9: treats "What is my name?" as a question (user role)', () => {
    expect(detectIsQuestion('What is my name?', 'user')).toBe(true);
  });

  it('test 10: always returns false for non-user roles', () => {
    expect(detectIsQuestion('Sure, here you go', 'assistant')).toBe(false);
  });

  it('test 11: short user content without period or exclamation is treated as question', () => {
    // "Thanks" — 6 chars, no period, no exclamation, user role → true
    expect(detectIsQuestion('Thanks', 'user')).toBe(true);
  });
});

// ============================================================
// detectPreferenceQuery — 3 tests
// ============================================================

describe('detectPreferenceQuery', () => {
  it('test 12: extracts category from "what is my favorite movie"', () => {
    expect(detectPreferenceQuery('what is my favorite movie')).toBe('movie');
  });

  it('test 13: returns null for a non-preference query', () => {
    expect(detectPreferenceQuery('how are you')).toBeNull();
  });

  it('test 14: strips superlative qualifiers — "of all time and why" → "movie"', () => {
    expect(detectPreferenceQuery('what is my favorite movie of all time and why')).toBe('movie');
  });
});

// ============================================================
// synthesizePreferenceItems — 2 tests
// ============================================================

describe('synthesizePreferenceItems', () => {
  it('test 15: maps a single preference row to an injection-ready item', () => {
    const rows = [{
      id: 'pref-1',
      source_turn_id: null,
      sentiment: 'positive',
      category: 'movie',
      value: 'Inception',
      confidence: 0.9,
      updated_at: '2025-01-01T00:00:00Z',
      created_at: '2025-01-01T00:00:00Z',
    }];

    const items = synthesizePreferenceItems(rows);

    expect(items).toHaveLength(1);
    const item = items[0];
    expect(item.source_type).toBe('user_preference');
    expect(item.preference_match).toBe(true);
    expect(item.platform).toBe('kyt');
    // similarity is confidence * 0.9
    expect(item.similarity).toBeCloseTo(0.9 * 0.9);
    // content should reference the category and value
    expect(item.content).toContain('movie');
    expect(item.content).toContain('Inception');
  });

  it('test 16: returns empty array for empty input', () => {
    expect(synthesizePreferenceItems([])).toEqual([]);
  });
});

// ============================================================
// getContextForInjection pipeline — 4 tests
// ============================================================

describe('getContextForInjection pipeline', () => {
  it('test 17: preference short-circuit returns items without calling vector search', async () => {
    // Provide userId so preference router can proceed
    vi.mocked(getApiConfig).mockResolvedValue({
      userId: 'test-user-id',
      accessToken: 'test-token',
      disableQueryTransformation: true,
    });

    // Mock getActiveProject + getActiveProfileId are already mocked globally.
    // Mock global fetch so lookupPreferencesViaREST returns a preference row.
    const fakeRow = {
      id: 'pref-1',
      source_turn_id: null,
      sentiment: 'positive',
      category: 'movie',
      value: 'The Matrix',
      confidence: 0.85,
      updated_at: '2025-06-01T00:00:00Z',
      created_at: '2025-06-01T00:00:00Z',
    };

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [fakeRow],
      text: async () => JSON.stringify([fakeRow]),
    });

    const result = await getContextForInjection(
      'what is my favorite movie',
      { disableQueryTransformation: true },
      {}
    );

    expect(result.success).toBe(true);
    expect(result.diagnostics.preferenceRouted).toBe(true);
    // searchViaEdgeFunction should NOT have been called (short-circuit)
    expect(searchViaEdgeFunction).not.toHaveBeenCalled();
  });

  it('test 18: returns {success:false} when getApiConfig rejects (error path)', async () => {
    vi.mocked(getApiConfig).mockRejectedValueOnce(new Error('Auth failure'));

    const result = await getContextForInjection(
      'what did we talk about?',
      {},
      {}
    );

    // Pipeline should catch the error and return a failed result
    expect(result.success).toBe(false);
  });

  it('test 19: edge routing calls searchViaEdgeFunction', async () => {
    vi.mocked(getRoutingMode).mockResolvedValue('edge');
    vi.mocked(getApiConfig).mockResolvedValue({
      userId: 'test-user-id',
      accessToken: 'test-token',
      disableQueryTransformation: true,
    });

    const fakeItems = [{
      id: 'item-1',
      content: 'some memory',
      similarity: 0.8,
      platform: 'claude-code',
      rerank_score: 0.8,
    }];
    vi.mocked(searchViaEdgeFunction).mockResolvedValue(fakeItems);

    // No preference match — plain query
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [],
      text: async () => '[]',
    });

    await getContextForInjection(
      'what do I know about distributed systems',
      { disableQueryTransformation: true },
      {}
    );

    expect(searchViaEdgeFunction).toHaveBeenCalled();
  });

  it('test 20: successful pipeline result contains a diagnostics object', async () => {
    vi.mocked(getApiConfig).mockResolvedValue({
      userId: 'test-user-id',
      accessToken: 'test-token',
      disableQueryTransformation: true,
    });

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [],
      text: async () => '[]',
    });

    const result = await getContextForInjection(
      'what did I say about TypeScript',
      { disableQueryTransformation: true },
      {}
    );

    expect(result).toHaveProperty('diagnostics');
    expect(typeof result.diagnostics).toBe('object');
  });
});
