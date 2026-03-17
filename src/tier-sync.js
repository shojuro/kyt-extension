/**
 * Tier Sync Module
 * Syncs the user's subscription tier from Supabase (users.tier)
 * to chrome.storage.local (user_tier).
 *
 * Two sync triggers:
 * 1. Periodic alarm (every 5 min via 'syncTier' alarm) — catches upgrades, downgrades, cancellations
 * 2. Post-checkout poll (every 10s for 2 min) — fast path after Stripe checkout
 *
 * Handles both directions:
 * - Upgrade: free→pro, free→max, pro→max
 * - Downgrade: pro→free, max→free, max→pro (cancellation, payment failure)
 */

import { SUPABASE_URL, SUPABASE_ANON_KEY } from './supabase-config.js';
import { AUTH_SESSION_KEY } from './auth/auth-service.js';

const VALID_TIERS = new Set(['free', 'pro', 'founder', 'max']);

/**
 * Fetch the user's current tier from Supabase and sync to chrome.storage.local.
 * @returns {{ changed: boolean, oldTier: string, newTier: string } | null} null if not authenticated
 */
export async function syncUserTier() {
  const result = await chrome.storage.local.get([AUTH_SESSION_KEY, 'user_tier', 'user_id']);
  const session = result[AUTH_SESSION_KEY];

  // Need a valid session to query Supabase
  if (!session?.access_token || !session.user?.id) {
    return null;
  }

  const userId = session.user.id;
  const oldTier = result.user_tier || 'free';

  try {
    const resp = await fetch(
      `${SUPABASE_URL}/rest/v1/users?id=eq.${userId}&select=tier`,
      {
        headers: {
          'Authorization': `Bearer ${session.access_token}`,
          'apikey': SUPABASE_ANON_KEY,
          'Content-Type': 'application/json',
        },
      }
    );

    if (!resp.ok) {
      console.warn(`⚠️ [Tier Sync] Supabase query failed: ${resp.status}`);
      return null;
    }

    const rows = await resp.json();
    if (!rows || rows.length === 0) {
      return null;
    }

    const newTier = rows[0].tier || 'free';

    // Validate tier value
    if (!VALID_TIERS.has(newTier)) {
      console.warn(`⚠️ [Tier Sync] Unknown tier from DB: "${newTier}", ignoring`);
      return null;
    }

    const changed = oldTier !== newTier;

    if (changed) {
      await chrome.storage.local.set({ user_tier: newTier });
      console.log(`🔄 [Tier Sync] Tier changed: ${oldTier} → ${newTier}`);
    }

    return { changed, oldTier, newTier };
  } catch (error) {
    console.warn('⚠️ [Tier Sync] Failed:', error.message);
    return null;
  }
}

// Post-checkout polling state
let checkoutPollInterval = null;
let checkoutPollCount = 0;
const CHECKOUT_POLL_INTERVAL_MS = 10_000; // 10s
const CHECKOUT_POLL_MAX = 12; // 12 × 10s = 2 minutes

/**
 * Start polling for tier changes after a checkout completes.
 * Polls every 10s for up to 2 minutes, stops early on tier change.
 */
export function startPostCheckoutPoll() {
  stopPostCheckoutPoll(); // Clear any existing poll
  checkoutPollCount = 0;

  console.log('🔄 [Tier Sync] Post-checkout poll started (10s intervals, 2min max)');

  checkoutPollInterval = setInterval(async () => {
    checkoutPollCount++;

    const result = await syncUserTier();

    if (result?.changed) {
      console.log(`✅ [Tier Sync] Upgrade detected via checkout poll: ${result.oldTier} → ${result.newTier}`);
      stopPostCheckoutPoll();
      return;
    }

    if (checkoutPollCount >= CHECKOUT_POLL_MAX) {
      console.log('⏱️ [Tier Sync] Post-checkout poll timed out (2min). Periodic alarm will catch it.');
      stopPostCheckoutPoll();
    }
  }, CHECKOUT_POLL_INTERVAL_MS);
}

/**
 * Stop the post-checkout polling loop.
 */
export function stopPostCheckoutPoll() {
  if (checkoutPollInterval) {
    clearInterval(checkoutPollInterval);
    checkoutPollInterval = null;
    checkoutPollCount = 0;
  }
}
