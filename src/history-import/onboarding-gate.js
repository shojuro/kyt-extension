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

/**
 * Decide what to do with a DB-reported in-progress import.
 *
 * MV3 service workers die on browser restart/crash; the DB row stays
 * 'in_progress' but no import loop is running. `running` is the
 * background's live truth (activeImporterRef) — when it's false the
 * import was interrupted and should be resumed, not displayed as if
 * it were still progressing.
 *
 * @param {{hasInProgressImport: boolean, running: boolean}} params
 * @returns {'show_progress'|'auto_resume'|'none'}
 */
export function decideImportResume({ hasInProgressImport, running }) {
    if (!hasInProgressImport) return 'none';
    return running ? 'show_progress' : 'auto_resume';
}
