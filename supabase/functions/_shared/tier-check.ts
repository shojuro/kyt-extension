/**
 * Tier check helper with in-memory caching.
 *
 * Looks up user tier from the `users` table and caches for 5 minutes.
 * Used by rate-limited edge functions to apply tier-specific limits.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

import { resurfaceLimitFor, tierLimitsFor, type TierLimits } from './tier-limits.ts';

// The limits themselves live in tier-limits.ts (pure, unit-tested).
export { RESURFACE_LIMITS, resurfaceLimitFor, TIER_LIMITS } from './tier-limits.ts';
export type { TierLimits } from './tier-limits.ts';

// In-memory tier cache with 5-minute TTL
const tierCache = new Map<string, { tier: string; fetchedAt: number }>();
const TIER_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Get the user's tier, with caching.
 * Falls back to 'free' if not found.
 */
export async function getUserTier(userId: string): Promise<string> {
  const cached = tierCache.get(userId);
  if (cached && Date.now() - cached.fetchedAt < TIER_CACHE_TTL_MS) {
    return cached.tier;
  }

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );
    const { data } = await supabase
      .from('users')
      .select('tier')
      .eq('id', userId)
      .single();

    const tier = data?.tier || 'free';
    tierCache.set(userId, { tier, fetchedAt: Date.now() });
    return tier;
  } catch {
    // On error, default to free (safe)
    return 'free';
  }
}

/**
 * Get rate limits for a tier.
 */
export function getTierLimits(tier: string): TierLimits {
  return tierLimitsFor(tier);
}
