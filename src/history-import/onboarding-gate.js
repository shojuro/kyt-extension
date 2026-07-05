/**
 * Onboarding auth gate for the history-import modal.
 *
 * On a fresh install there is no auth session and api_config has no
 * supabaseUrl/Key, so starting an import unauthenticated fetches
 * `undefined/rest/v1/...` and fails cryptically — and even signed-out
 * later, save_chat_turn_batch 401s anon-key Bearers. The modal must
 * route to an auth_required view until a valid session exists.
 *
 * Pure functions — no chrome.* access — so they are unit-testable.
 */

/** Must match AUTH_SESSION_KEY in src/auth/auth-service.js */
export const AUTH_SESSION_STORAGE_KEY = 'auth_session';

/**
 * @param {{access_token?: string, expires_at?: number}|null|undefined} session
 * @param {number} [nowSec]
 * @returns {boolean}
 */
export function hasValidSession(session, nowSec = Math.floor(Date.now() / 1000)) {
    return !!(session?.access_token && session.expires_at > nowSec);
}

/**
 * Decide which view the import modal should open on.
 *
 * The first-install welcome/mode screens are allowed unauthenticated
 * (they only touch client-side storage); everything that leads to an
 * actual import requires a valid session.
 *
 * @param {Object} params
 * @param {boolean} params.isFirstInstall  URL has ?mode=first-install
 * @param {boolean} params.showOnboarding  show_import_onboarding !== false
 * @param {Object|null|undefined} params.session  Stored auth session
 * @param {number} [params.nowSec]
 * @returns {'welcome'|'auth_required'|'platform_select'}
 */
export function decideEntryState({ isFirstInstall, showOnboarding, session, nowSec }) {
    if (isFirstInstall && showOnboarding !== false) {
        return 'welcome';
    }
    if (!hasValidSession(session, nowSec)) {
        return 'auth_required';
    }
    return 'platform_select';
}
