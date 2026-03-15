import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setupChromeMocks, resetAllMocks } from '../setup.js';

vi.mock('../../src/browser-sync.js', () => ({
  syncToSupabase: vi.fn(),
}));

import { syncToSupabase } from '../../src/browser-sync.js';

let mocks;

beforeEach(() => {
  vi.useFakeTimers();
  mocks = setupChromeMocks();
  resetAllMocks();
  mocks = setupChromeMocks();
  syncToSupabase.mockReset();
  // Default: resolve with success
  syncToSupabase.mockResolvedValue({ success: true });
});

afterEach(async () => {
  // Clean up any pending timers via cancelTimersAndFlush
  const { cancelTimersAndFlush } = await import('../../src/sync-controller.js');
  cancelTimersAndFlush();
  vi.useRealTimers();
});

describe('scheduleDebouncedSync — storage flags', () => {
  it('sets kyt_sync_pending: true immediately on schedule', async () => {
    const { scheduleDebouncedSync } = await import('../../src/sync-controller.js');

    scheduleDebouncedSync();

    const storage = chrome.storage._getInternalStorage();
    expect(storage.kyt_sync_pending).toBe(true);
  });

  it('fires executeDebouncedSync after the 5s debounce period', async () => {
    const { scheduleDebouncedSync } = await import('../../src/sync-controller.js');

    scheduleDebouncedSync();
    expect(syncToSupabase).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5000);

    expect(syncToSupabase).toHaveBeenCalledTimes(1);
  });

  it('rapid calls reset debounce — only one sync fires after 5s', async () => {
    const { scheduleDebouncedSync } = await import('../../src/sync-controller.js');

    scheduleDebouncedSync();
    await vi.advanceTimersByTimeAsync(2000);
    scheduleDebouncedSync();
    await vi.advanceTimersByTimeAsync(2000);
    // Only 4s since last call — should not have fired yet
    expect(syncToSupabase).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(3000); // full 5s after last call
    expect(syncToSupabase).toHaveBeenCalledTimes(1);
  });

  it('max-wait timer forces sync after 30s even with continuous resets', async () => {
    const { scheduleDebouncedSync } = await import('../../src/sync-controller.js');

    // Keep resetting debounce every 4s so it never fires on its own
    scheduleDebouncedSync(); // t=0 — starts max-wait at 30s
    await vi.advanceTimersByTimeAsync(4000);
    scheduleDebouncedSync(); // t=4000 — resets debounce, max-wait already set (not reset)
    await vi.advanceTimersByTimeAsync(4000);
    scheduleDebouncedSync(); // t=8000
    await vi.advanceTimersByTimeAsync(4000);
    scheduleDebouncedSync(); // t=12000
    await vi.advanceTimersByTimeAsync(4000);
    scheduleDebouncedSync(); // t=16000
    await vi.advanceTimersByTimeAsync(4000);
    scheduleDebouncedSync(); // t=20000
    await vi.advanceTimersByTimeAsync(4000);
    scheduleDebouncedSync(); // t=24000

    // Haven't reached 30s yet from the first call
    expect(syncToSupabase).not.toHaveBeenCalled();

    // Advance to t=30000 — max-wait fires
    await vi.advanceTimersByTimeAsync(6000);
    expect(syncToSupabase).toHaveBeenCalledTimes(1);
  });
});

describe('executeDebouncedSync — success path', () => {
  it('clears kyt_sync_pending (sets to false) on success', async () => {
    const { executeDebouncedSync } = await import('../../src/sync-controller.js');

    chrome.storage.local.set({ kyt_sync_pending: true });
    await executeDebouncedSync();

    const storage = chrome.storage._getInternalStorage();
    expect(storage.kyt_sync_pending).toBe(false);
  });

  it('sets and then removes kyt_sync_running around the sync call', async () => {
    const { executeDebouncedSync } = await import('../../src/sync-controller.js');

    const runningValues = [];
    syncToSupabase.mockImplementation(async () => {
      // Capture storage state mid-sync
      runningValues.push(chrome.storage._getInternalStorage().kyt_sync_running);
      return { success: true };
    });

    await executeDebouncedSync();

    // During sync: kyt_sync_running was set to a number (timestamp)
    expect(typeof runningValues[0]).toBe('number');
    expect(runningValues[0]).toBeGreaterThan(0);

    // After sync: kyt_sync_running is removed
    const storage = chrome.storage._getInternalStorage();
    expect(storage.kyt_sync_running).toBeUndefined();
  });
});

describe('executeDebouncedSync — failure path', () => {
  it('leaves kyt_sync_pending as-is (does not set to false) when syncToSupabase throws', async () => {
    const { executeDebouncedSync } = await import('../../src/sync-controller.js');

    syncToSupabase.mockRejectedValue(new Error('network error'));
    chrome.storage.local.set({ kyt_sync_pending: true });

    await executeDebouncedSync();

    const storage = chrome.storage._getInternalStorage();
    // kyt_sync_pending should still be true — success path never ran
    expect(storage.kyt_sync_pending).toBe(true);
  });

  it('sets kyt_sync_auth_failed when error includes "Not authenticated"', async () => {
    const { executeDebouncedSync } = await import('../../src/sync-controller.js');

    syncToSupabase.mockRejectedValue(new Error('Not authenticated'));

    await executeDebouncedSync();

    const storage = chrome.storage._getInternalStorage();
    expect(storage.kyt_sync_auth_failed).toBeDefined();
    expect(storage.kyt_sync_auth_failed.error).toBe('Not authenticated');
    expect(typeof storage.kyt_sync_auth_failed.timestamp).toBe('number');
  });

  it('sets kyt_sync_auth_failed when error includes "No authenticated user"', async () => {
    const { executeDebouncedSync } = await import('../../src/sync-controller.js');

    syncToSupabase.mockRejectedValue(new Error('No authenticated user found'));

    await executeDebouncedSync();

    const storage = chrome.storage._getInternalStorage();
    expect(storage.kyt_sync_auth_failed).toBeDefined();
    expect(storage.kyt_sync_auth_failed.error).toContain('No authenticated user');
  });
});

describe('cancelTimersAndFlush', () => {
  it('cancels both timers so no sync fires after calling it', async () => {
    const { scheduleDebouncedSync, cancelTimersAndFlush } = await import('../../src/sync-controller.js');

    scheduleDebouncedSync();
    cancelTimersAndFlush();

    // Advance well past both debounce (5s) and max-wait (30s) thresholds
    await vi.advanceTimersByTimeAsync(35000);

    expect(syncToSupabase).not.toHaveBeenCalled();
  });

  it('is idempotent when called with no timers set', async () => {
    const { cancelTimersAndFlush } = await import('../../src/sync-controller.js');

    // Should not throw when called with nothing to cancel
    expect(() => cancelTimersAndFlush()).not.toThrow();
    expect(() => cancelTimersAndFlush()).not.toThrow();
  });
});
