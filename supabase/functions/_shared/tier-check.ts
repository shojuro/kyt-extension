/**
 * Tier check helper with in-memory caching.
 *
 * Looks up user tier from the `users` table and caches for 5 minutes.
 * Used by rate-limited edge functions to apply tier-specific limits.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

export const TIER_LIMITS: Record<string, TierLimits> = {
  free:  { searchesPerMin: 10, savesPerMin: 20, importsPerDay: 1,  llmCallsPerMin: 5   },
  pro:   { searchesPerMin: 60, savesPerMin: 100, importsPerDay: 10, llmCallsPerMin: 30  },
  dev:   { searchesPerMin: 200, savesPerMin: 500, importsPerDay: 50, llmCallsPerMin: 100 },
};

// Re-ingestion rate limits: max distinct old conversations resurfaced per 90-day window
// "Old" = ingested_at - created_at > 90 days
export const RESURFACE_LIMITS: Record<string, number> = {
  free: 10,   // Casual "oh I remember that chat" browsing
  pro:  50,   // Power users who actively curate their history
  dev:  200,  // Effectively unlimited for development/testing
};

export interface TierLimits {
  searchesPerMin: number;
  savesPerMin: number;
  importsPerDay: number;
  llmCallsPerMin: number;
}

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
  return TIER_LIMITS[tier] || TIER_LIMITS.free;
}
