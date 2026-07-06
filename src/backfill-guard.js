/**
 * Auth guard for edge-function backfill alarms.
 *
 * The backfill_* edge functions require a real user JWT (service-role gate,
 * 2026-07-05) — anon keys and token-less calls get 401. Backfill alarms are
 * scheduled on every extension update/import regardless of auth state, so on
 * a signed-out profile (fresh unpacked load, dead refresh token) each firing
 * used to throw "Not authenticated and no API keys configured" and re-arm
 * every 10 minutes.
 *
 * IMPORTANT (MV3): All imports must be static. No dynamic import().
 */

import { getRoutingMode } from './auth-config.js';

/** How long to snooze a backfill alarm while the user is signed out. */
export const BACKFILL_AUTH_RETRY_MINUTES = 60;

/**
 * Returns true when backfills can run. Otherwise re-arms the alarm with a
 * long delay and returns false — the caller should skip quietly instead of
 * erroring.
 *
 * Edge-fn backfills need a JWT session ('edge' mode). The client-side
 * embeddings backfill also works with legacy API keys — pass
 * {allowLegacy: true} for it.
 *
 * @param {string} alarmName Alarm to re-arm on skip (e.g. 'backfillContextual')
 * @param {{allowLegacy?: boolean}} [options]
 * @returns {Promise<boolean>}
 */
export async function backfillAuthReady(alarmName, { allowLegacy = false } = {}) {
    let mode = 'unconfigured';
    try {
        mode = await getRoutingMode();
    } catch (e) {
        console.warn(`⚠️ ${alarmName}: routing mode check failed (${e.message}) — treating as signed out`);
    }

    if (mode === 'edge') return true;
    if (allowLegacy && mode === 'legacy') return true;

    // 'legacy' (anon keys) can't call JWT-gated backfill fns.
    console.log(`⏭️ ${alarmName}: skipped — no JWT session (mode: ${mode}). Retrying in ${BACKFILL_AUTH_RETRY_MINUTES}min.`);
    chrome.alarms.create(alarmName, { delayInMinutes: BACKFILL_AUTH_RETRY_MINUTES });
    return false;
}
