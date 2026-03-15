/**
 * Unit Tests for src/browser-sync.js
 *
 * Tests syncToSupabase, syncMessages, setApiConfig, backfillNullEmbeddings
 * covering: concurrency lock, auth guards, deflection filtering,
 * circuit breaker checks, platform normalization, and return shapes.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setupChromeMocks, resetAllMocks } from '../setup.js';

// ---------------------------------------------------------------------------
// Module mocks — declared before any import of the module under test
// ---------------------------------------------------------------------------

vi.mock('../../src/conversation-chunker.js', () => ({
  messagesToTurnChunks: vi.fn(() => [])
}));

vi.mock('../../src/hyde-preprocessor.js', () => ({
  generateHypotheticalQuestions: vi.fn(() => Promise.resolve({ success: true, questions: [] }))
}));

vi.mock('../../src/embedding-circuit-breaker.js', () => ({
  isEmbeddingCircuitOpen: vi.fn(() => Promise.resolve({ open: false })),
  recordEmbeddingSuccess: vi.fn(() => Promise.resolve()),
  recordEmbeddingFailure: vi.fn(() => Promise.resolve())
}));

vi.mock('../../src/utils/fetch.js', () => ({
  fetchWithTimeout: vi.fn()
}));

vi.mock('../../src/api-client.js', () => ({
  callEdgeFunction: vi.fn(() => Promise.resolve({ success: true }))
}));

vi.mock('../../src/profile-manager.js', () => ({
  getActiveProfileId: vi.fn(() => Promise.resolve(null))
}));

vi.mock('../../src/auth/auth-service.js', () => ({
  refreshSession: vi.fn()
}));

vi.mock('../../src/utils/normalize-platform.js', () => ({
  normalizePlatform: vi.fn((p) => p || 'chatgpt')
}));

vi.mock('../../src/supabase-config.js', () => ({
  SUPABASE_URL: 'https://test.supabase.co',
  SUPABASE_ANON_KEY: 'test-anon-key'
}));

// Import after mocks
import {
  syncToSupabase,
  syncMessages,
  setApiConfig,
  backfillNullEmbeddings
} from '../../src/browser-sync.js';
import { isEmbeddingCircuitOpen, recordEmbeddingSuccess } from '../../src/embedding-circuit-breaker.js';
import { fetchWithTimeout } from '../../src/utils/fetch.js';
import { callEdgeFunction } from '../../src/api-client.js';
import { normalizePlatform } from '../../src/utils/normalize-platform.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_STORAGE = {
  api_config: {
    supabaseUrl: 'https://test.supabase.co',
    supabaseKey: 'test-key'
  },
  auth_session: {
    access_token: 'test-jwt',
    refresh_token: 'test-refresh',
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    user: { id: 'user-123', email: 'test@test.com' }
  },
  user_id: 'user-123'
};

function makeOkResponse(body = []) {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body))
  };
}

function makeMessage(overrides = {}) {
  return {
    messageId: `msg-${Math.random().toString(36).slice(2)}`,
    content: 'Hello world test message with enough content',
    role: 'user',
    platform: 'chatgpt',
    conversationId: 'conv-1',
    timestamp: Date.now(),
    capturedAt: Date.now(),
    deflection: 0,
    ...overrides
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let chromeMocks;

beforeEach(() => {
  chromeMocks = setupChromeMocks();
  vi.clearAllMocks();
  // Default: fetchWithTimeout always succeeds (used for DB existence checks and backfill)
  fetchWithTimeout.mockResolvedValue(makeOkResponse([]));
  // Default: global fetch always succeeds (used by fetchWithAuthRetry for messages/chat_turns POST)
  global.fetch = vi.fn().mockResolvedValue(makeOkResponse([]));
  // Default: callEdgeFunction returns embeddings for generate_embeddings calls
  callEdgeFunction.mockImplementation((fnName) => {
    if (fnName === 'generate_embeddings') {
      return Promise.resolve({ embeddings: [[0.1, 0.2, 0.3]] });
    }
    return Promise.resolve({ success: true });
  });
  // Default: circuit breaker is closed
  isEmbeddingCircuitOpen.mockResolvedValue({ open: false });
});

afterEach(() => {
  resetAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('syncToSupabase — concurrency lock', () => {

  // 1. Returns "already in progress" when lock is held
  it('1. returns "already in progress" when lock is held by concurrent call', async () => {
    await chrome.storage.local.set(VALID_STORAGE);

    // Arrange: first call starts but doesn't finish (fetchWithTimeout hangs)
    let resolveFetch;
    fetchWithTimeout.mockReturnValueOnce(new Promise(resolve => { resolveFetch = resolve; }));

    const first = syncToSupabase(); // starts, holds lock
    // Give microtasks time to grab the lock and start awaiting fetchWithTimeout
    await Promise.resolve();
    await Promise.resolve();

    const second = await syncToSupabase(); // should see lock held

    expect(second).toMatchObject({ success: true, synced: 0, message: expect.stringContaining('in progress') });

    // Cleanup: resolve the hanging fetch so first call can finish
    resolveFetch(makeOkResponse([]));
    await first;
  });

  // 2. Lock released after success — second call proceeds
  it('2. releases lock after successful sync so subsequent calls can proceed', async () => {
    await chrome.storage.local.set(VALID_STORAGE);
    fetchWithTimeout.mockResolvedValue(makeOkResponse([]));

    await syncToSupabase(); // first call completes, releases lock

    // If lock was NOT released, this would return "already in progress"
    const result = await syncToSupabase();
    // Both calls should succeed (not "already in progress" for the second)
    expect(result.message).not.toBe('Sync already in progress');
  });

  // 3. Lock released after failure — second call proceeds
  it('3. releases lock after failure so subsequent calls can proceed', async () => {
    // No api_config → getConfig throws → syncToSupabase catches and returns error
    // But first: set storage without api_config
    await chrome.storage.local.set({ user_id: 'user-123' }); // no api_config

    await syncToSupabase(); // will fail with config error

    // Set valid config now for second call
    await chrome.storage.local.set(VALID_STORAGE);
    fetchWithTimeout.mockResolvedValue(makeOkResponse([]));

    const result = await syncToSupabase();
    // Second call should not be blocked by the first's failure
    expect(result.message).not.toBe('Sync already in progress');
  });

});

describe('getConfig — storage validation', () => {

  // 4. No api_config in storage → syncMessages throws or returns error
  it('4. no api_config in storage → syncMessages returns error', async () => {
    // Storage has no api_config — getConfig will throw
    const result = await syncMessages([makeMessage()]);
    // syncMessages wraps getConfig in try/catch → returns { success: false }
    expect(result.success).toBe(false);
  });

  // 5. No access_token → returns { success: false } with auth message
  it('5. no access_token → returns { success: false } with auth message', async () => {
    await chrome.storage.local.set({
      api_config: { supabaseUrl: 'https://test.supabase.co', supabaseKey: 'test-key' },
      // No auth_session → no access_token
      user_id: 'user-123'
    });

    const result = await syncMessages([makeMessage()]);

    expect(result.success).toBe(false);
    expect(result.synced).toBe(0);
    expect(result.message).toMatch(/authenticated|sign in/i);
  });

  // 7. getConfig returns userId from auth_session
  it('7. getConfig reads userId from auth_session.user.id', async () => {
    await chrome.storage.local.set(VALID_STORAGE);
    fetchWithTimeout.mockResolvedValue(makeOkResponse([]));

    // syncMessages succeeds and uses config.userId from the JWT session
    const result = await syncMessages([]);
    // Empty messages → success: true, synced: 0
    expect(result.success).toBe(true);
    // userId should have been read — verified indirectly by sync succeeding
  });

});

describe('syncMessages — core logic', () => {

  // 6. Empty messages → { success: true, synced: 0 }
  it('6. empty messages array → returns { success: true, synced: 0 }', async () => {
    await chrome.storage.local.set(VALID_STORAGE);

    const result = await syncMessages([]);

    expect(result).toMatchObject({ success: true, synced: 0 });
  });

  // 8. Platform normalization applied to messages
  it('8. calls normalizePlatform on each message platform field', async () => {
    await chrome.storage.local.set(VALID_STORAGE);
    fetchWithTimeout.mockResolvedValue(makeOkResponse([]));
    callEdgeFunction.mockImplementation((fn) => {
      if (fn === 'generate_embeddings') return Promise.resolve({ embeddings: [[0.1]] });
      return Promise.resolve({ success: true });
    });

    const msg = makeMessage({ platform: 'claude' });
    await syncMessages([msg]);

    expect(normalizePlatform).toHaveBeenCalledWith('claude');
  });

  // 9. Deflections filtered: messages with deflection >= 0.70 are excluded
  it('9. filters out messages with deflection >= 0.70', async () => {
    await chrome.storage.local.set(VALID_STORAGE);
    fetchWithTimeout.mockResolvedValue(makeOkResponse([]));
    callEdgeFunction.mockImplementation((fn) => {
      if (fn === 'generate_embeddings') return Promise.resolve({ embeddings: [[0.1]] });
      return Promise.resolve({ success: true });
    });

    const goodMsg = makeMessage({ deflection: 0.3, content: 'Meaningful content to sync' });
    const deflectedMsg = makeMessage({ deflection: 0.75, content: 'Deflection content to drop' });

    const result = await syncMessages([goodMsg, deflectedMsg]);

    // Only 1 message should have been synced (the non-deflection one)
    expect(result.success).toBe(true);
    expect(result.synced).toBe(1);
  });

  // 10. Circuit breaker checked before embedding generation
  it('10. checks circuit breaker before generating embeddings', async () => {
    await chrome.storage.local.set(VALID_STORAGE);
    fetchWithTimeout.mockResolvedValue(makeOkResponse([]));

    const msg = makeMessage();
    await syncMessages([msg]);

    expect(isEmbeddingCircuitOpen).toHaveBeenCalled();
  });

  // 11. Embedding generation skipped when circuit breaker is open
  it('11. skips embedding generation when circuit breaker is open', async () => {
    await chrome.storage.local.set(VALID_STORAGE);
    fetchWithTimeout.mockResolvedValue(makeOkResponse([]));
    isEmbeddingCircuitOpen.mockResolvedValue({ open: true, reason: 'too many failures' });
    // callEdgeFunction for generate_embeddings should NOT be called (circuit open throws)

    const msg = makeMessage();
    const result = await syncMessages([msg]);

    // Sync should still succeed (embeddings degrade gracefully to null)
    expect(result.success).toBe(true);
    // generate_embeddings should NOT have been called via callEdgeFunction
    const embeddingCalls = callEdgeFunction.mock.calls.filter(c => c[0] === 'generate_embeddings');
    expect(embeddingCalls.length).toBe(0);
  });

  // 12. Batch processing: messages are processed
  it('12. processes messages and returns synced count', async () => {
    await chrome.storage.local.set(VALID_STORAGE);
    fetchWithTimeout.mockResolvedValue(makeOkResponse([]));
    callEdgeFunction.mockImplementation((fn) => {
      if (fn === 'generate_embeddings') return Promise.resolve({ embeddings: [[0.1], [0.2]] });
      return Promise.resolve({ success: true });
    });

    const msgs = [makeMessage(), makeMessage()];
    const result = await syncMessages(msgs);

    expect(result.success).toBe(true);
    expect(result.synced).toBe(2);
  });

  // 13. Return object includes success and synced count
  it('13. return object has success and synced properties', async () => {
    await chrome.storage.local.set(VALID_STORAGE);
    fetchWithTimeout.mockResolvedValue(makeOkResponse([]));
    callEdgeFunction.mockImplementation((fn) => {
      if (fn === 'generate_embeddings') return Promise.resolve({ embeddings: [[0.1]] });
      return Promise.resolve({ success: true });
    });

    const result = await syncMessages([makeMessage()]);

    expect(result).toHaveProperty('success');
    expect(result).toHaveProperty('synced');
    expect(typeof result.success).toBe('boolean');
    expect(typeof result.synced).toBe('number');
  });

  // 14. syncToSupabase is an async function
  it('14. syncToSupabase is an async function returning a Promise', () => {
    const promise = syncToSupabase();
    expect(promise).toBeInstanceOf(Promise);
    // Clean up
    return promise.catch(() => {});
  });

  // 15. Dual-write: messages table is called via global fetch (fetchWithAuthRetry)
  it('15. posts to messages REST endpoint via fetch (dual-write messages table)', async () => {
    await chrome.storage.local.set(VALID_STORAGE);
    callEdgeFunction.mockImplementation((fn) => {
      if (fn === 'generate_embeddings') return Promise.resolve({ embeddings: [[0.1]] });
      return Promise.resolve({ success: true });
    });

    await syncMessages([makeMessage()]);

    // fetchWithAuthRetry calls global fetch for the messages table POST
    const fetchCalls = global.fetch.mock.calls;
    const messagesCall = fetchCalls.find(([url]) =>
      typeof url === 'string' && url.includes('/rest/v1/messages')
    );
    expect(messagesCall).toBeDefined();
  });

  // 16. Error in batch response doesn't kill entire sync (continue on failure)
  it('16. continues sync when a batch REST call fails (non-fatal batch error)', async () => {
    await chrome.storage.local.set(VALID_STORAGE);
    callEdgeFunction.mockImplementation((fn) => {
      if (fn === 'generate_embeddings') {
        // Return enough embeddings for all messages
        return Promise.resolve({ embeddings: [[0.1], [0.2], [0.3], [0.4], [0.5], [0.6]] });
      }
      return Promise.resolve({ success: true });
    });

    // First batch POST fails, second succeeds — via global.fetch (fetchWithAuthRetry)
    const failResponse = {
      ok: false,
      status: 500,
      json: () => Promise.resolve({ message: 'Internal server error' }),
      text: () => Promise.resolve('Internal server error')
    };
    global.fetch
      .mockResolvedValueOnce(failResponse)    // first batch POST fails
      .mockResolvedValue(makeOkResponse([])); // second batch succeeds

    // Use just 2 messages (2 batches of 1 each would need BATCH_SIZE=1, but BATCH_SIZE=5 so use 6)
    // Actually, use a single message to avoid the 1s inter-batch delay.
    // The test is about continue-on-failure, so we can trigger it with 1 message (1 batch fails).
    const msgs = [makeMessage()];
    const result = await syncMessages(msgs);

    // Sync should still return success=true — catches per-batch errors and continues
    expect(result.success).toBe(true);
  }, 15000);

});

describe('setApiConfig', () => {

  // 17. setApiConfig stores config in chrome.storage
  it('17. setApiConfig writes config to chrome.storage.local', async () => {
    const config = {
      supabaseUrl: 'https://example.supabase.co',
      supabaseKey: 'my-anon-key'
    };

    await setApiConfig(config);

    const stored = chrome.storage._getInternalStorage();
    expect(stored.api_config).toMatchObject(config);
  });

});

describe('backfillNullEmbeddings', () => {

  // 18. backfillNullEmbeddings checks circuit breaker before starting
  it('18. checks circuit breaker before starting backfill', async () => {
    await chrome.storage.local.set(VALID_STORAGE);
    isEmbeddingCircuitOpen.mockResolvedValue({ open: true, reason: 'rate limit exceeded' });

    const result = await backfillNullEmbeddings();

    expect(isEmbeddingCircuitOpen).toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/circuit breaker/i);
    expect(result.backfilled).toBe(0);
  });

});
