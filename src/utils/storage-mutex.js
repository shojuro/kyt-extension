/**
 * Serialize read-modify-write operations on chrome.storage.local.
 *
 * Usage:
 *   await withStorageMutex('kyt_stats', async (current) => {
 *     current.count = (current.count || 0) + 1;
 *     return current; // returned value is written back
 *   });
 *
 * Concurrent calls on the same key are queued, not interleaved.
 * The mutex is in-memory — resets on SW termination (acceptable: stats
 * corruption during termination is already a lost cause).
 */

const _chains = new Map();

export async function withStorageMutex(key, mutator, defaultValue = {}) {
  const prev = _chains.get(key) || Promise.resolve();
  const next = prev.then(async () => {
    const result = await chrome.storage.local.get([key]);
    const current = result[key] ?? (typeof defaultValue === 'function' ? defaultValue() : structuredClone(defaultValue));
    const updated = await mutator(current);
    if (updated !== undefined) {
      await chrome.storage.local.set({ [key]: updated });
    }
  }).catch(err => {
    console.warn(`⚠️ withStorageMutex(${key}):`, err.message);
  });
  _chains.set(key, next);
  return next;
}

// Exposed for testing only
export function _resetChains() {
  _chains.clear();
}
