// Server side of the tier policy: rate limits per tier. Pure module (no remote
// imports): tests/unit/tier-policy.test.js checks it against the extension's
// src/tier-policy.js and the tiers the database accepts.

/** Billing is off: every ordinary account gets the pro limits. Keep equal to BETA_MODE in src/tier-policy.js. */
export const SERVER_BETA_MODE = true;

export interface TierLimits {
  searchesPerMin: number;
  savesPerMin: number;
  importsPerDay: number;
  llmCallsPerMin: number;
}

const DEV_LIMITS: TierLimits = { searchesPerMin: 200, savesPerMin: 500, importsPerDay: 50, llmCallsPerMin: 100 };

export const TIER_LIMITS: Record<string, TierLimits> = {
  free:    { searchesPerMin: 10, savesPerMin: 20, importsPerDay: 1,  llmCallsPerMin: 5   },
  pro:     { searchesPerMin: 60, savesPerMin: 100, importsPerDay: 10, llmCallsPerMin: 30  },
  dev:     DEV_LIMITS,
  founder: DEV_LIMITS,
};

// Re-ingestion rate limits: max distinct old conversations resurfaced per 90-day window
// "Old" = ingested_at - created_at > 90 days
export const RESURFACE_LIMITS: Record<string, number> = {
  free: 10,     // Casual "oh I remember that chat" browsing
  pro:  50,     // Power users who actively curate their history
  dev:  200,    // Effectively unlimited for development/testing
  founder: 200,
};

/** The tier whose limits apply to an account with this tier column. */
function effectiveTier(tier: string): string {
  if (tier === "dev" || tier === "founder") return tier;
  if (SERVER_BETA_MODE) return "pro";
  return tier in TIER_LIMITS ? tier : "free";
}

export function tierLimitsFor(tier: string): TierLimits {
  return TIER_LIMITS[effectiveTier(tier)];
}

export function resurfaceLimitFor(tier: string): number {
  return RESURFACE_LIMITS[effectiveTier(tier)];
}
