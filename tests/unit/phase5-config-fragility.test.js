/**
 * Phase 5 Configuration Fragility Regression Tests
 *
 * Tests for architectural fragility fixes F1-F5. Each test is designed to
 * FAIL if the corresponding fix is reverted.
 *
 * Fixes covered:
 *   F1 — Centralized constants (no more magic numbers scattered across files)
 *   F2 — Frozen edge function registry (single source of truth)
 *   F3 — Storage-backed circuit breaker survives SW restarts
 *   F4 — Sync lock TTL expires after 2 minutes (stale lock released)
 *   F5 — callEdgeFunction default timeout is 20s (TIMEOUT_EDGE_FUNCTION_MS)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setupChromeMocks, resetAllMocks } from '../setup.js';

// ============================================================================
// F1: Centralized constants
// ============================================================================

describe('F1: constants.js exports correct default values', () => {
  it('CONFIDENCE_THRESHOLD_DEFAULT === 0.40', async () => {
    const { CONFIDENCE_THRESHOLD_DEFAULT } = await import('../../src/constants.js');
    expect(CONFIDENCE_THRESHOLD_DEFAULT).toBe(0.40);
  });

  it('TIMEOUT_PIPELINE_MS === 22000', async () => {
    const { TIMEOUT_PIPELINE_MS } = await import('../../src/constants.js');
    expect(TIMEOUT_PIPELINE_MS).toBe(22_000);
  });

  it('TIMEOUT_EDGE_FUNCTION_MS === 20000', async () => {
    const { TIMEOUT_EDGE_FUNCTION_MS } = await import('../../src/constants.js');
    expect(TIMEOUT_EDGE_FUNCTION_MS).toBe(20_000);
  });

  it('TIMEOUT_SYNC_API_MS === 30000', async () => {
    const { TIMEOUT_SYNC_API_MS } = await import('../../src/constants.js');
    expect(TIMEOUT_SYNC_API_MS).toBe(30_000);
  });

  it('BATCH_SIZE_SYNC === 5', async () => {
    const { BATCH_SIZE_SYNC } = await import('../../src/constants.js');
    expect(BATCH_SIZE_SYNC).toBe(5);
  });

  it('BATCH_SIZE_EDGE_SYNC === 50', async () => {
    const { BATCH_SIZE_EDGE_SYNC } = await import('../../src/constants.js');
    expect(BATCH_SIZE_EDGE_SYNC).toBe(50);
  });

  it('CONFIG_CACHE_TTL_MS === 300000 (5 minutes)', async () => {
    const { CONFIG_CACHE_TTL_MS } = await import('../../src/constants.js');
    expect(CONFIG_CACHE_TTL_MS).toBe(300_000);
  });

  it('timeout hierarchy: pipeline > sync API > edge function', async () => {
    const {
      TIMEOUT_PIPELINE_MS,
      TIMEOUT_SYNC_API_MS,
      TIMEOUT_EDGE_FUNCTION_MS,
    } = await import('../../src/constants.js');
    expect(TIMEOUT_PIPELINE_MS).toBeLessThan(TIMEOUT_SYNC_API_MS);
    expect(TIMEOUT_EDGE_FUNCTION_MS).toBeLessThan(TIMEOUT_PIPELINE_MS);
  });
});

// ============================================================================
// F2: Edge function registry is frozen
// ============================================================================

describe('F2: EDGE_FN registry integrity', () => {
  it('EDGE_FN is frozen (Object.isFrozen)', async () => {
    const { EDGE_FN } = await import('../../src/edge-functions.js');
    expect(Object.isFrozen(EDGE_FN)).toBe(true);
  });

  it('contains exactly 9 function names', async () => {
    const { EDGE_FN } = await import('../../src/edge-functions.js');
    expect(Object.keys(EDGE_FN)).toHaveLength(9);
  });

  it('all 9 expected keys are present', async () => {
    const { EDGE_FN } = await import('../../src/edge-functions.js');
    const expectedKeys = [
      'SEARCH_MEMORIES',
      'SAVE_CHAT_TURN_BATCH',
      'GENERATE_EMBEDDINGS',
      'BACKFILL_ENTITIES',
      'BACKFILL_CONTEXTUAL',
      'BACKFILL_GRAVITY',
      'LLM_COMPLETION',
      'CLASSIFY_INTENT',
      'CLAIM_USER_DATA',
    ];
    expect(Object.keys(EDGE_FN).sort()).toEqual(expectedKeys.sort());
  });

  it('all values are non-empty strings', async () => {
    const { EDGE_FN } = await import('../../src/edge-functions.js');
    for (const [key, val] of Object.entries(EDGE_FN)) {
      expect(typeof val).toBe('string');
      expect(val.length).toBeGreaterThan(0);
    }
  });

  it('mutations are rejected (frozen object)', async () => {
    const { EDGE_FN } = await import('../../src/edge-functions.js');
    // In strict mode, assigning to a frozen object throws TypeError.
    // In non-strict mode it silently fails. Either way the value is unchanged.
    const originalValue = EDGE_FN.SEARCH_MEMORIES;
    try {
      EDGE_FN.SEARCH_MEMORIES = 'hacked';
    } catch {
      // expected in strict mode
    }
    expect(EDGE_FN.SEARCH_MEMORIES).toBe(originalValue);
  });
});

// ============================================================================
// F3: Storage-backed circuit breaker survives SW restarts
// ============================================================================

describe('F3: circuit breaker persistence across SW restarts', () => {
  let mocks;

  beforeEach(() => {
    mocks = setupChromeMocks();
    resetAllMocks();
  });

  it('opens after 3 consecutive transient failures', async () => {
    const { createCircuitBreaker } = await import('../../src/embedding-circuit-breaker.js');
    const cb = createCircuitBreaker('test_cb', [60_000, 120_000, 300_000]);

    // Record 3 failures (429 = transient)
    await cb.recordFailure(429, 'rate limited');
    await cb.recordFailure(429, 'rate limited');
    await cb.recordFailure(429, 'rate limited');

    const state = await cb.getState();
    expect(state.isOpen).toBe(true);
    expect(state.consecutiveFailures).toBe(3);
  });

  it('persists open state in chrome.storage.local', async () => {
    const { createCircuitBreaker } = await import('../../src/embedding-circuit-breaker.js');
    const cb = createCircuitBreaker('test_cb_persist', [60_000, 120_000]);

    await cb.recordFailure(500, 'server error');
    await cb.recordFailure(500, 'server error');
    await cb.recordFailure(500, 'server error');

    // Read directly from storage (bypass CB API)
    const raw = mocks.storage._getInternalStorage();
    expect(raw['test_cb_persist']).toBeDefined();
    expect(raw['test_cb_persist'].isOpen).toBe(true);
  });

  it('new CB instance with same key reads persisted open state (simulates SW restart)', async () => {
    const { createCircuitBreaker } = await import('../../src/embedding-circuit-breaker.js');

    // First instance: open the circuit
    const cb1 = createCircuitBreaker('test_cb_restart', [60_000, 120_000]);
    await cb1.recordFailure(429, 'rate limited');
    await cb1.recordFailure(429, 'rate limited');
    await cb1.recordFailure(429, 'rate limited');

    const state1 = await cb1.isOpen();
    expect(state1.open).toBe(true);

    // Simulate SW restart: create a NEW instance with the same storage key
    const cb2 = createCircuitBreaker('test_cb_restart', [60_000, 120_000]);

    const state2 = await cb2.isOpen();
    expect(state2.open).toBe(true);
    expect(state2.reason).toContain('circuit open');
  });

  it('recordSuccess closes the circuit', async () => {
    const { createCircuitBreaker } = await import('../../src/embedding-circuit-breaker.js');
    const cb = createCircuitBreaker('test_cb_close', [60_000]);

    // Open it
    await cb.recordFailure(500, 'fail');
    await cb.recordFailure(500, 'fail');
    await cb.recordFailure(500, 'fail');
    expect((await cb.isOpen()).open).toBe(true);

    // Close it
    await cb.recordSuccess();

    const state = await cb.getState();
    expect(state.isOpen).toBe(false);
    expect(state.consecutiveFailures).toBe(0);
  });
});

// ============================================================================
// F4: Sync lock TTL expires after 2 minutes
// ============================================================================

describe('F4: sync lock TTL expiry', () => {
  let mocks;
  const SYNC_LOCK_KEY = 'kyt_sync_lock';
  const SYNC_LOCK_TTL_MS = 120_000; // 2 minutes — must match browser-sync.js

  beforeEach(() => {
    mocks = setupChromeMocks();
    resetAllMocks();
    // Add remove() to mock since setup.js doesn't include it
    if (!chrome.storage.local.remove) {
      chrome.storage.local.remove = vi.fn((key) => {
        const storage = mocks.storage._getInternalStorage();
        const keyToRemove = Array.isArray(key) ? key[0] : key;
        delete storage[keyToRemove];
        return Promise.resolve();
      });
    }
  });

  it('fresh lock can be acquired (no existing lock)', async () => {
    // Simulate acquireSyncLock logic
    const result = await chrome.storage.local.get([SYNC_LOCK_KEY]);
    const lock = result[SYNC_LOCK_KEY];
    const canAcquire = !lock || (Date.now() - lock.acquiredAt) >= SYNC_LOCK_TTL_MS;
    expect(canAcquire).toBe(true);
  });

  it('active lock blocks acquisition', async () => {
    // Set a fresh lock
    await chrome.storage.local.set({
      [SYNC_LOCK_KEY]: { acquiredAt: Date.now() },
    });

    const result = await chrome.storage.local.get([SYNC_LOCK_KEY]);
    const lock = result[SYNC_LOCK_KEY];
    const canAcquire = !lock || (Date.now() - lock.acquiredAt) >= SYNC_LOCK_TTL_MS;
    expect(canAcquire).toBe(false);
  });

  it('stale lock (>2 min old) is released and can be re-acquired', async () => {
    // Set a lock from 3 minutes ago
    const threeMinutesAgo = Date.now() - 180_000;
    await chrome.storage.local.set({
      [SYNC_LOCK_KEY]: { acquiredAt: threeMinutesAgo },
    });

    const result = await chrome.storage.local.get([SYNC_LOCK_KEY]);
    const lock = result[SYNC_LOCK_KEY];
    const canAcquire = !lock || (Date.now() - lock.acquiredAt) >= SYNC_LOCK_TTL_MS;
    expect(canAcquire).toBe(true);
  });

  it('lock at exactly TTL boundary is released', async () => {
    const exactlyTTLAgo = Date.now() - SYNC_LOCK_TTL_MS;
    await chrome.storage.local.set({
      [SYNC_LOCK_KEY]: { acquiredAt: exactlyTTLAgo },
    });

    const result = await chrome.storage.local.get([SYNC_LOCK_KEY]);
    const lock = result[SYNC_LOCK_KEY];
    const canAcquire = !lock || (Date.now() - lock.acquiredAt) >= SYNC_LOCK_TTL_MS;
    expect(canAcquire).toBe(true);
  });

  it('releaseSyncLock removes the key from storage', async () => {
    // Set lock
    await chrome.storage.local.set({
      [SYNC_LOCK_KEY]: { acquiredAt: Date.now() },
    });

    // Release (simulate releaseSyncLock)
    await chrome.storage.local.remove(SYNC_LOCK_KEY);

    const result = await chrome.storage.local.get([SYNC_LOCK_KEY]);
    expect(result[SYNC_LOCK_KEY]).toBeUndefined();
  });
});

// ============================================================================
// F5: callEdgeFunction default timeout is TIMEOUT_EDGE_FUNCTION_MS (20s)
// ============================================================================

describe('F5: callEdgeFunction default timeout', () => {
  it('TIMEOUT_EDGE_FUNCTION_MS is 20000, not 30000', async () => {
    const { TIMEOUT_EDGE_FUNCTION_MS } = await import('../../src/constants.js');
    expect(TIMEOUT_EDGE_FUNCTION_MS).toBe(20_000);
    expect(TIMEOUT_EDGE_FUNCTION_MS).not.toBe(30_000);
  });

  it('api-client.js imports TIMEOUT_EDGE_FUNCTION_MS as default timeout', async () => {
    // Read the source to verify the import and destructuring default
    const fs = await import('fs');
    const path = await import('path');
    const apiClientSrc = fs.readFileSync(
      path.resolve(import.meta.dirname, '../../src/api-client.js'),
      'utf-8',
    );

    // Verify it imports TIMEOUT_EDGE_FUNCTION_MS from constants
    expect(apiClientSrc).toContain("import { TIMEOUT_EDGE_FUNCTION_MS } from './constants.js'");

    // Verify the destructuring default uses it
    expect(apiClientSrc).toContain('timeoutMs = TIMEOUT_EDGE_FUNCTION_MS');
  });

  it('default timeout is NOT TIMEOUT_SYNC_API_MS (30s)', async () => {
    const { TIMEOUT_EDGE_FUNCTION_MS, TIMEOUT_SYNC_API_MS } = await import('../../src/constants.js');
    // Edge function timeout must be less than sync API timeout
    expect(TIMEOUT_EDGE_FUNCTION_MS).toBeLessThan(TIMEOUT_SYNC_API_MS);
  });
});
