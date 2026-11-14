/**
 * One tier policy for the beta, agreed by the extension, the edge functions
 * and the database (src/tier-policy.js, supabase/functions/_shared/tier-limits.ts).
 *
 * Regression for 2026-11-14: the database allowed free|pro|dev|founder, the
 * extension knew free|pro|founder|max and the server free|pro|dev. The
 * founder's account sat on "free", so recall stopped after 20 captured
 * messages a day, behind a banner selling an upgrade that cannot be bought.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import {
  BETA_MODE,
  BETA_TURNS_PER_DAY,
  VALID_TIERS,
  turnsPerDay,
  upgradeUiEnabled,
} from '../../src/tier-policy.js';
import { TIER_LIMITS, RESURFACE_LIMITS, tierLimitsFor, resurfaceLimitFor, SERVER_BETA_MODE }
  from '../../supabase/functions/_shared/tier-limits.ts';

// The tiers the database accepts (users_tier_check).
const DB_TIERS = ['free', 'pro', 'dev', 'founder'];

describe('extension tier policy', () => {
  it('is in beta mode with billing off', () => {
    expect(BETA_MODE).toBe(true);
    expect(upgradeUiEnabled()).toBe(false);
  });

  it('knows every tier the database can hold', () => {
    for (const tier of DB_TIERS) expect(VALID_TIERS.has(tier)).toBe(true);
  });

  it('gives every beta account the same daily allowance, whatever its tier says', () => {
    expect(BETA_TURNS_PER_DAY).toBe(75);
    expect(turnsPerDay('free')).toBe(75);
    expect(turnsPerDay('pro')).toBe(75);
    expect(turnsPerDay('something-new')).toBe(75);
    expect(turnsPerDay(undefined)).toBe(75);
  });

  it('never limits the founder or developer accounts', () => {
    expect(turnsPerDay('founder')).toBe(-1);
    expect(turnsPerDay('dev')).toBe(-1);
    expect(turnsPerDay('max')).toBe(-1);
  });
});

describe('server tier limits', () => {
  it('is in beta mode too', () => {
    expect(SERVER_BETA_MODE).toBe(BETA_MODE);
  });

  it('has limits for every tier the database can hold', () => {
    for (const tier of DB_TIERS) {
      expect(TIER_LIMITS[tier]).toBeDefined();
      expect(RESURFACE_LIMITS[tier]).toBeGreaterThan(0);
    }
  });

  it('gives beta (free) accounts the pro rate limits', () => {
    expect(tierLimitsFor('free')).toEqual(TIER_LIMITS.pro);
    expect(tierLimitsFor('unknown')).toEqual(TIER_LIMITS.pro);
    expect(resurfaceLimitFor('free')).toBe(RESURFACE_LIMITS.pro);
  });

  it('gives the founder the developer limits', () => {
    expect(tierLimitsFor('founder')).toEqual(TIER_LIMITS.dev);
    expect(tierLimitsFor('dev')).toEqual(TIER_LIMITS.dev);
    expect(resurfaceLimitFor('founder')).toBe(RESURFACE_LIMITS.dev);
  });
});

describe('scripts that cannot import the policy stay in step with it', () => {
  it('popup.js carries the same beta flag', () => {
    const popup = fs.readFileSync(new URL('../../popup/popup.js', import.meta.url), 'utf8');
    expect(popup).toMatch(new RegExp(`const BETA_MODE = ${BETA_MODE};`));
  });

  it('the limit banner has a no-upgrade form', () => {
    const banner = fs.readFileSync(new URL('../../src/content/upgrade-banner.js', import.meta.url), 'utf8');
    expect(banner).toMatch(/showUpgrade/);
  });
});
