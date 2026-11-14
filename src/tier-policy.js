/**
 * Tier policy for the extension: the single place that says which tiers exist
 * and how many captured turns a day each may use for recall.
 *
 * Beta (billing off): every account gets the same allowance as a cost guard,
 * whatever its tier column says, and no upgrade or checkout UI is shown. The
 * founder and developer accounts are not limited. The server's side of this
 * policy is supabase/functions/_shared/tier-limits.ts; the database accepts
 * free | pro | dev | founder (users_tier_check). tests/unit/tier-policy.test.js
 * holds the three together.
 */

/** Billing is off and upgrades cannot be bought. Turn off at public launch. */
export const BETA_MODE = true;

/** Daily allowance for every beta account. */
export const BETA_TURNS_PER_DAY = 75;

/** Every tier name the extension accepts from the database. */
export const VALID_TIERS = new Set(['free', 'pro', 'dev', 'founder', 'max']);

const UNLIMITED_TIERS = new Set(['founder', 'dev', 'max']);

// Allowances once billing is on. -1 = unlimited.
const PAID_TURNS_PER_DAY = { free: 20, pro: 75 };

/**
 * Captured turns a day before recall pauses. -1 = unlimited.
 * @param {string} tier
 * @returns {number}
 */
export function turnsPerDay(tier) {
  if (UNLIMITED_TIERS.has(tier)) return -1;
  if (BETA_MODE) return BETA_TURNS_PER_DAY;
  return PAID_TURNS_PER_DAY[tier] ?? PAID_TURNS_PER_DAY.free;
}

/** Whether upgrade buttons and checkout may be shown. */
export function upgradeUiEnabled() {
  return !BETA_MODE;
}
