/**
 * Haiku Tiebreaker — Layer 2 Intent Classification
 *
 * Calls the classify_intent edge function to get a Haiku 4.5 tiebreaker
 * for messages that the v2 heuristic classified as PASSIVE (ambiguous).
 *
 * IMPORTANT (MV3): All imports must be static. No dynamic import().
 *
 * Exports:
 *   classifyWithHaiku(message, heuristicScores) → { classification, latencyMs, source }
 *   isHaikuEnabled() → boolean
 */

import { callEdgeFunction } from './api-client.js';

const HAIKU_TIMEOUT_MS = 2000;
const DAILY_HAIKU_LIMIT = 100;

/**
 * Calls the classify_intent edge function to get a Haiku tiebreaker
 * classification for an ambiguous (PASSIVE) message.
 *
 * @param {string} message - The user's message text
 * @param {Object} heuristicScores - {directive,memory,question,personal,temporal,density} from v2
 * @param {string} reason - Layer 1 classification reason string
 * @returns {Promise<{classification: string, latencyMs: number, source: string}>}
 */
export async function classifyWithHaiku(message, heuristicScores, reason) {
  // Rate limit check
  if (!(await checkDailyLimit())) {
    console.log('🤖 Haiku: rate limited (100/day) — falling back to PASSIVE');
    return { classification: 'FALLBACK', latencyMs: 0, source: 'rate_limited' };
  }

  const startTime = performance.now();

  try {
    const result = await Promise.race([
      callEdgeFunction('classify_intent', {
        message: message.slice(0, 500),
        scores: heuristicScores,
        reason,
      }, { timeoutMs: HAIKU_TIMEOUT_MS }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Layer 2 timeout')), HAIKU_TIMEOUT_MS + 500))
    ]);

    const latencyMs = Math.round(performance.now() - startTime);
    await incrementDailyCount();

    return {
      classification: result.classification || 'FALLBACK',
      latencyMs,
      source: result.source || 'haiku_tiebreaker',
    };
  } catch (error) {
    const latencyMs = Math.round(performance.now() - startTime);

    if (error.message?.includes('timeout')) {
      console.warn(`[KYT:Haiku] Tiebreaker timed out after ${HAIKU_TIMEOUT_MS}ms`);
      return { classification: 'FALLBACK', latencyMs, source: 'timeout' };
    }

    console.error('[KYT:Haiku] Tiebreaker error:', error.message);
    return { classification: 'FALLBACK', latencyMs, source: 'error' };
  }
}

// ── Feature toggle ──

/**
 * Check if the Haiku tiebreaker is enabled via chrome.storage.local toggle.
 * Default: false (must be explicitly enabled in settings).
 */
export async function isHaikuEnabled() {
  const { kyt_haiku_tiebreaker_enabled } =
    await chrome.storage.local.get('kyt_haiku_tiebreaker_enabled');
  return kyt_haiku_tiebreaker_enabled === true;
}

// ── Rate limiting (client-side, per calendar day) ──

async function checkDailyLimit() {
  const today = new Date().toISOString().split('T')[0];
  const key = `kyt_haiku_count_${today}`;
  const { [key]: count = 0 } = await chrome.storage.local.get(key);
  return count < DAILY_HAIKU_LIMIT;
}

async function incrementDailyCount() {
  const today = new Date().toISOString().split('T')[0];
  const key = `kyt_haiku_count_${today}`;
  const { [key]: count = 0 } = await chrome.storage.local.get(key);
  await chrome.storage.local.set({ [key]: count + 1 });

  // Clean up yesterday's key
  const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
  await chrome.storage.local.remove(`kyt_haiku_count_${yesterday}`);
}
