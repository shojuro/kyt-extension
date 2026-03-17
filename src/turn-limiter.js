/**
 * Turn Limiter Module
 * Tracks daily turn usage per tier, stored in chrome.storage.local.
 *
 * Key: kyt_daily_turns = { date: "2026-03-17", count: 14 }
 * Lazy reset: if stored date !== today, resets count to 0.
 * No midnight alarm — MV3 service workers can't rely on alarms firing exactly.
 */

// Tier limits — mirrors TIER_LIMITS in tier-check.ts
// -1 = unlimited
const TURNS_PER_DAY = {
  free: 20,
  pro: 75,
  founder: 75,
  max: -1,
};

function getTodayDate() {
  return new Date().toISOString().slice(0, 10); // "2026-03-17"
}

/**
 * Read current turn data, lazy-resetting if date changed.
 * @returns {{ date: string, count: number }}
 */
async function readTurnData() {
  const result = await chrome.storage.local.get('kyt_daily_turns');
  const data = result.kyt_daily_turns || { date: getTodayDate(), count: 0 };
  const today = getTodayDate();
  if (data.date !== today) {
    const reset = { date: today, count: 0 };
    await chrome.storage.local.set({ kyt_daily_turns: reset });
    return reset;
  }
  return data;
}

/**
 * Get the user's cached tier from storage.
 * @returns {string}
 */
async function getCachedTier() {
  const result = await chrome.storage.local.get('user_tier');
  return result.user_tier || 'free';
}

/**
 * Check if the user can still capture turns today.
 * @returns {{ allowed: boolean, used: number, limit: number, tier: string }}
 */
export async function checkTurnLimit() {
  const [data, tier] = await Promise.all([readTurnData(), getCachedTier()]);
  const limit = TURNS_PER_DAY[tier] ?? TURNS_PER_DAY.free;
  const allowed = limit === -1 || data.count < limit;
  return { allowed, used: data.count, limit, tier };
}

/**
 * Increment the daily turn count. Call after a successful save.
 * @returns {number} The new count.
 */
export async function incrementTurnCount() {
  const data = await readTurnData();
  data.count += 1;
  await chrome.storage.local.set({ kyt_daily_turns: data });
  return data.count;
}

/**
 * Read-only turn usage for popup display.
 * @returns {{ used: number, limit: number, tier: string, date: string }}
 */
export async function getTurnUsage() {
  const [data, tier] = await Promise.all([readTurnData(), getCachedTier()]);
  const limit = TURNS_PER_DAY[tier] ?? TURNS_PER_DAY.free;
  return { used: data.count, limit, tier, date: data.date };
}
