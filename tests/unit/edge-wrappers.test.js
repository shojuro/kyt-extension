/**
 * Unit Tests for src/edge-search.js and src/edge-sync.js
 *
 * Tests the two edge-function wrapper modules:
 *   - searchViaEdgeFunction (6 tests)
 *   - syncViaEdgeFunction   (6 tests)
 *
 * Follows CLAUDE.md Anti-Theater Rules - Real tests that can fail.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setupChromeMocks, resetAllMocks } from '../setup.js';

// ---------------------------------------------------------------------------
// Module mocks — declared before any import of the modules under test
// ---------------------------------------------------------------------------

vi.mock('../../src/api-client.js', () => ({
  callEdgeFunction: vi.fn(),
}));

// Import after mocks are declared
import { callEdgeFunction } from '../../src/api-client.js';
import { searchViaEdgeFunction } from '../../src/edge-search.js';
import { syncViaEdgeFunction } from '../../src/edge-sync.js';

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

const MOCK_USER_ID = 'test-user-uuid-1234';
const MOCK_AUTH_SESSION = { user: { id: MOCK_USER_ID } };

beforeEach(() => {
  setupChromeMocks();
  vi.clearAllMocks();
  // Pre-populate storage with auth_session so userId resolves
  chrome.storage.local.set({ auth_session: MOCK_AUTH_SESSION });
});

afterEach(() => {
  resetAllMocks();
});

// ---------------------------------------------------------------------------
// searchViaEdgeFunction tests
// ---------------------------------------------------------------------------

describe('searchViaEdgeFunction', () => {

  // 1. Calls callEdgeFunction with 'search_memories' as the function name
  it('1. passes "search_memories" as function name to callEdgeFunction', async () => {
    callEdgeFunction.mockResolvedValue({
      success: true,
      results: [],
    });

    await searchViaEdgeFunction('test query');

    expect(callEdgeFunction).toHaveBeenCalledOnce();
    const [fnName] = callEdgeFunction.mock.calls[0];
    expect(fnName).toBe('search_memories');
  });

  // 2. Forwards topK, useHyde, hydeWeight options in the request body
  it('2. forwards topK, useHyde, hydeWeight options in body', async () => {
    callEdgeFunction.mockResolvedValue({
      success: true,
      results: [],
    });

    await searchViaEdgeFunction('my query', {
      topK: 10,
      useHyde: false,
      hydeWeight: 0.4,
    });

    const [, body] = callEdgeFunction.mock.calls[0];
    expect(body.topK).toBe(10);
    expect(body.useHyde).toBe(false);
    expect(body.hydeWeight).toBe(0.4);
  });

  // 3. Returns an array of mapped result objects
  it('3. returns array of results mapped from raw response', async () => {
    const rawResults = [
      {
        id: 'msg-1',
        content: 'Walter Payton ran for 1977 yards.',
        platform: 'chatgpt',
        created_at: '2025-01-01T00:00:00Z',
        cross_encoder_score: 0.87,
        rrf_score: 0.72,
      },
    ];
    callEdgeFunction.mockResolvedValue({ success: true, results: rawResults });

    const results = await searchViaEdgeFunction('Walter Payton');

    expect(Array.isArray(results)).toBe(true);
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('msg-1');
    expect(results[0].content).toBe('Walter Payton ran for 1977 yards.');
    expect(results[0].platform).toBe('chatgpt');
    expect(results[0].cross_encoder_score).toBe(0.87);
    expect(results[0].rrf_score).toBe(0.72);
  });

  // 4. Empty results array in response → returns empty array
  it('4. empty response results → returns empty results array', async () => {
    callEdgeFunction.mockResolvedValue({ success: true, results: [] });

    const results = await searchViaEdgeFunction('some query');

    expect(Array.isArray(results)).toBe(true);
    expect(results).toHaveLength(0);
  });

  // 5. Passes timeoutMs through to callEdgeFunction options
  it('5. passes timeoutMs through to callEdgeFunction options', async () => {
    callEdgeFunction.mockResolvedValue({ success: true, results: [] });

    await searchViaEdgeFunction('query', { timeoutMs: 5000 });

    const [, , options] = callEdgeFunction.mock.calls[0];
    expect(options.timeoutMs).toBe(5000);
  });

  // 6. Optional params are forwarded in body when provided
  it('6. forwards optional params (recentByPlatform, fast, confidenceThreshold, mmrLambda) when provided', async () => {
    callEdgeFunction.mockResolvedValue({ success: true, results: [] });

    await searchViaEdgeFunction('query', {
      recentByPlatform: 'claude',
      fast: true,
      confidenceThreshold: 0.7,
      mmrLambda: 0.5,
      recentTopics: ['sports', 'nfl'],
      conversationWindow: ['turn-1', 'turn-2'],
      projectId: 'proj-abc',
    });

    const [, body] = callEdgeFunction.mock.calls[0];
    expect(body.recentByPlatform).toBe('claude');
    expect(body.fast).toBe(true);
    expect(body.confidenceThreshold).toBe(0.7);
    expect(body.mmrLambda).toBe(0.5);
    expect(body.recentTopics).toEqual(['sports', 'nfl']);
    expect(body.conversationWindow).toEqual(['turn-1', 'turn-2']);
    expect(body.projectId).toBe('proj-abc');
  });

});

// ---------------------------------------------------------------------------
// syncViaEdgeFunction tests
// ---------------------------------------------------------------------------

describe('syncViaEdgeFunction', () => {

  // 7. Empty messages array → returns success without calling callEdgeFunction
  it('7. empty messages → returns { success: true, synced: 0 } without calling edge function', async () => {
    const result = await syncViaEdgeFunction([]);

    expect(result).toEqual({ success: true, synced: 0, duplicates: 0, errors: 0 });
    expect(callEdgeFunction).not.toHaveBeenCalled();
  });

  // 8. No authenticated user → throws
  it('8. no authenticated user (no auth_session, no user_id) → throws', async () => {
    // Clear the auth session set in beforeEach
    chrome.storage._setInternalStorage({});

    const messages = [{ content: 'hello', role: 'user', platform: 'chatgpt' }];

    await expect(syncViaEdgeFunction(messages))
      .rejects.toThrow('No authenticated user for edge sync');

    expect(callEdgeFunction).not.toHaveBeenCalled();
  });

  // 9. More than 50 messages are split into 2 batches → 2 callEdgeFunction calls
  it('9. batches >50 messages into 2 callEdgeFunction calls', async () => {
    callEdgeFunction.mockResolvedValue({
      success: true,
      inserted: 25,
      duplicates_skipped: 0,
      errors: 0,
    });

    // 51 messages → 2 batches: first 50, then 1
    const messages = Array.from({ length: 51 }, (_, i) => ({
      content: `Message ${i}`,
      role: 'user',
      platform: 'chatgpt',
    }));

    await syncViaEdgeFunction(messages);

    expect(callEdgeFunction).toHaveBeenCalledTimes(2);
    const [, firstBatchBody] = callEdgeFunction.mock.calls[0];
    const [, secondBatchBody] = callEdgeFunction.mock.calls[1];
    expect(firstBatchBody.turns).toHaveLength(50);
    expect(secondBatchBody.turns).toHaveLength(1);
  });

  // 10. Totals are aggregated across batches
  it('10. aggregates synced/duplicates/errors totals across multiple batches', async () => {
    callEdgeFunction
      .mockResolvedValueOnce({ success: true, inserted: 30, duplicates_skipped: 10, errors: 5 })
      .mockResolvedValueOnce({ success: true, inserted: 20, duplicates_skipped: 5, errors: 2 });

    const messages = Array.from({ length: 72 }, (_, i) => ({
      content: `Message ${i}`,
      role: 'user',
      platform: 'chatgpt',
    }));

    const result = await syncViaEdgeFunction(messages);

    expect(result.synced).toBe(50);       // 30 + 20
    expect(result.duplicates).toBe(15);   // 10 + 5
    expect(result.errors).toBe(7);        // 5 + 2
    expect(result.success).toBe(false);   // errors > 0
  });

  // 11. A single batch failure does not stop remaining batches (continues, counts errors)
  it('11. batch failure does not stop remaining batches — continues and counts errors', async () => {
    // First batch throws a generic error (not rate-limit / timeout)
    callEdgeFunction
      .mockRejectedValueOnce(new Error('Internal server error'))
      .mockResolvedValueOnce({ success: true, inserted: 1, duplicates_skipped: 0, errors: 0 });

    const messages = Array.from({ length: 51 }, (_, i) => ({
      content: `Message ${i}`,
      role: 'user',
      platform: 'chatgpt',
    }));

    const result = await syncViaEdgeFunction(messages);

    // Both batches attempted
    expect(callEdgeFunction).toHaveBeenCalledTimes(2);
    // First batch had 50 messages, all counted as errors
    expect(result.errors).toBe(50);
    // Second batch succeeded
    expect(result.synced).toBe(1);
    expect(result.success).toBe(false);
  });

  // 12. skipAiProcessing is passed through in request body
  it('12. passes skipAiProcessing through as skip_ai_processing in request body', async () => {
    callEdgeFunction.mockResolvedValue({
      success: true,
      inserted: 1,
      duplicates_skipped: 0,
      errors: 0,
    });

    const messages = [{ content: 'hello', role: 'user', platform: 'chatgpt' }];

    await syncViaEdgeFunction(messages, { skipAiProcessing: true });

    const [fnName, body] = callEdgeFunction.mock.calls[0];
    expect(fnName).toBe('save_chat_turn_batch');
    expect(body.skip_ai_processing).toBe(true);
  });

});
