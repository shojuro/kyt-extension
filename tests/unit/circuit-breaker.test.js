import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setupChromeMocks, resetAllMocks } from '../setup.js';

let mocks;

beforeEach(() => {
  mocks = setupChromeMocks();
  resetAllMocks();
  mocks = setupChromeMocks();
});

// Import after chrome is set up
const getModule = () => import('../../src/embedding-circuit-breaker.js');

// Test cooldown steps for easy inspection
const TEST_STEPS = [1000, 2000, 5000, 10000];
const TEST_KEY = 'test_cb_key';

describe('createCircuitBreaker — initial state', () => {
  it('new CB: isOpen() returns { open: false }', async () => {
    const { createCircuitBreaker } = await getModule();
    const cb = createCircuitBreaker(TEST_KEY, TEST_STEPS);
    const result = await cb.isOpen();
    expect(result.open).toBe(false);
    expect(result.waitMs).toBe(0);
  });

  it('getState returns default when storage is empty', async () => {
    const { createCircuitBreaker } = await getModule();
    const cb = createCircuitBreaker(TEST_KEY, TEST_STEPS);
    const state = await cb.getState();
    expect(state.isOpen).toBe(false);
    expect(state.consecutiveFailures).toBe(0);
    expect(state.openedAt).toBeNull();
    expect(state.totalTrips).toBe(0);
    expect(state.cooldownMs).toBe(TEST_STEPS[0]);
  });
});

describe('createCircuitBreaker — transient failures (429)', () => {
  it('1 failure (429): still closed', async () => {
    const { createCircuitBreaker } = await getModule();
    const cb = createCircuitBreaker(TEST_KEY, TEST_STEPS);
    await cb.recordFailure(429, 'rate limited');
    const result = await cb.isOpen();
    expect(result.open).toBe(false);
  });

  it('2 failures (429): still closed', async () => {
    const { createCircuitBreaker } = await getModule();
    const cb = createCircuitBreaker(TEST_KEY, TEST_STEPS);
    await cb.recordFailure(429, 'rate limited');
    await cb.recordFailure(429, 'rate limited');
    const result = await cb.isOpen();
    expect(result.open).toBe(false);
  });

  it('3 failures (429): opens circuit', async () => {
    const { createCircuitBreaker } = await getModule();
    const cb = createCircuitBreaker(TEST_KEY, TEST_STEPS);
    await cb.recordFailure(429, 'rate limited');
    await cb.recordFailure(429, 'rate limited');
    await cb.recordFailure(429, 'rate limited');
    const result = await cb.isOpen();
    expect(result.open).toBe(true);
    expect(result.waitMs).toBeGreaterThan(0);
  });
});

describe('createCircuitBreaker — cooldown expiry and reset', () => {
  it('after cooldown expires: isOpen() returns { open: false, reason: "probe" }', async () => {
    const { createCircuitBreaker } = await getModule();
    // Use very short steps so we can fake expiry via openedAt
    const cb = createCircuitBreaker(TEST_KEY, TEST_STEPS);

    // Trip circuit
    await cb.recordFailure(429, 'err');
    await cb.recordFailure(429, 'err');
    await cb.recordFailure(429, 'err');

    // Manually set openedAt far in the past so cooldown is expired
    const state = await cb.getState();
    await cb.updateState({ openedAt: Date.now() - state.cooldownMs - 1 });

    const result = await cb.isOpen();
    expect(result.open).toBe(false);
    expect(result.reason).toBe('probe');
    expect(result.waitMs).toBe(0);
  });

  it('recordSuccess after probe: resets state fully', async () => {
    const { createCircuitBreaker } = await getModule();
    const cb = createCircuitBreaker(TEST_KEY, TEST_STEPS);

    // Trip and expire
    await cb.recordFailure(429, 'err');
    await cb.recordFailure(429, 'err');
    await cb.recordFailure(429, 'err');
    await cb.updateState({ openedAt: Date.now() - 99999 });

    // Confirm probe state
    const probe = await cb.isOpen();
    expect(probe.reason).toBe('probe');

    await cb.recordSuccess();

    const state = await cb.getState();
    expect(state.isOpen).toBe(false);
    expect(state.consecutiveFailures).toBe(0);
    expect(state.openedAt).toBeNull();
    expect(state.lastFailureCode).toBeNull();
    expect(state.cooldownMs).toBe(TEST_STEPS[0]);
  });
});

describe('createCircuitBreaker — cooldown escalation', () => {
  it('second trip uses next cooldown step', async () => {
    const { createCircuitBreaker } = await getModule();
    const cb = createCircuitBreaker(TEST_KEY, TEST_STEPS);

    // First trip: 3 failures → circuit opens at STEPS[0]
    await cb.recordFailure(429, 'err');
    await cb.recordFailure(429, 'err');
    await cb.recordFailure(429, 'err');
    const state1 = await cb.getState();
    expect(state1.cooldownMs).toBe(TEST_STEPS[0]);

    // Expire cooldown (no recordSuccess — circuit stays open state in storage)
    await cb.updateState({ openedAt: Date.now() - state1.cooldownMs - 1 });

    // One more failure while circuit is/was open → re-opens with escalated step
    // (failures >= 3 is still satisfied, isOpen=true → use nextIdx)
    await cb.recordFailure(429, 'err');
    const state2 = await cb.getState();
    // After first failure of the re-trip: currentIdx=indexOf(STEPS[0])=0, nextIdx=1 → STEPS[1]
    expect(state2.cooldownMs).toBe(TEST_STEPS[1]);
  });

  it('max cooldown step: does not exceed last step', async () => {
    const { createCircuitBreaker } = await getModule();
    const cb = createCircuitBreaker(TEST_KEY, TEST_STEPS);

    // Push cooldownMs beyond the last step by directly setting state
    await cb.updateState({
      isOpen: true,
      openedAt: Date.now() - 1,
      consecutiveFailures: 2,
      cooldownMs: TEST_STEPS[TEST_STEPS.length - 1],
      totalTrips: 3
    });

    // One more trip
    await cb.recordFailure(429, 'err');
    const state = await cb.getState();
    expect(state.cooldownMs).toBe(TEST_STEPS[TEST_STEPS.length - 1]);
  });
});

describe('createCircuitBreaker — storage isolation', () => {
  it('state persists to correct storage key', async () => {
    const { createCircuitBreaker } = await getModule();
    const cb = createCircuitBreaker('my_unique_key', TEST_STEPS);

    await cb.recordFailure(429, 'err');
    await cb.recordFailure(429, 'err');
    await cb.recordFailure(429, 'err');

    const raw = await chrome.storage.local.get(['my_unique_key']);
    expect(raw['my_unique_key']).toBeDefined();
    expect(raw['my_unique_key'].isOpen).toBe(true);
  });

  it('state survives "restart" (new instance, same key reads same storage)', async () => {
    const { createCircuitBreaker } = await getModule();
    const KEY = 'restart_test_key';

    const cb1 = createCircuitBreaker(KEY, TEST_STEPS);
    await cb1.recordFailure(429, 'err');
    await cb1.recordFailure(429, 'err');
    await cb1.recordFailure(429, 'err');

    // Simulate restart: new instance, same key
    const cb2 = createCircuitBreaker(KEY, TEST_STEPS);
    const result = await cb2.isOpen();
    expect(result.open).toBe(true);
  });

  it('separate CBs with different keys do not interfere', async () => {
    const { createCircuitBreaker } = await getModule();
    const cbA = createCircuitBreaker('key_a', TEST_STEPS);
    const cbB = createCircuitBreaker('key_b', TEST_STEPS);

    // Trip cbA
    await cbA.recordFailure(429, 'err');
    await cbA.recordFailure(429, 'err');
    await cbA.recordFailure(429, 'err');

    // cbB should still be closed
    const resultB = await cbB.isOpen();
    expect(resultB.open).toBe(false);

    // cbA should be open
    const resultA = await cbA.isOpen();
    expect(resultA.open).toBe(true);
  });
});

describe('createCircuitBreaker — totalTrips counter', () => {
  it('totalTrips increments on each open', async () => {
    const { createCircuitBreaker } = await getModule();
    const cb = createCircuitBreaker(TEST_KEY, TEST_STEPS);

    // First trip
    await cb.recordFailure(429, 'err');
    await cb.recordFailure(429, 'err');
    await cb.recordFailure(429, 'err');
    const state1 = await cb.getState();
    expect(state1.totalTrips).toBe(1);

    // Reset and trip again
    await cb.recordSuccess();
    await cb.recordFailure(429, 'err');
    await cb.recordFailure(429, 'err');
    await cb.recordFailure(429, 'err');
    const state2 = await cb.getState();
    expect(state2.totalTrips).toBe(2);
  });
});

describe('createCircuitBreaker — HTTP 403 immediate open', () => {
  it('403: opens immediately on first failure with 5min cooldown', async () => {
    const { createCircuitBreaker } = await getModule();
    const cb = createCircuitBreaker(TEST_KEY, TEST_STEPS);

    // Single 403 should immediately open — does not wait for 3 failures
    await cb.recordFailure(403, 'provider unavailable');

    const result = await cb.isOpen();
    expect(result.open).toBe(true);

    const state = await cb.getState();
    expect(state.isOpen).toBe(true);
    expect(state.cooldownMs).toBe(300000); // 5 minutes
    expect(state.totalTrips).toBe(1);
    expect(state.consecutiveFailures).toBe(1);
  });
});
