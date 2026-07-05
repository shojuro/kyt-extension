/**
 * Onboarding gate — the first-install import modal must require a signed-in
 * session before letting the user start a history import. On fresh installs
 * api_config has no supabaseUrl/Key, so an unauthenticated import fetches
 * `undefined/rest/v1/...` and fails cryptically.
 */

import { describe, it, expect } from 'vitest';
import {
    hasValidSession,
    decideEntryState,
    AUTH_SESSION_STORAGE_KEY,
} from '../../src/history-import/onboarding-gate.js';

const NOW_SEC = 1_800_000_000;

function validSession(overrides = {}) {
    return {
        access_token: 'jwt-token',
        expires_at: NOW_SEC + 3600,
        user: { id: 'user-1' },
        ...overrides,
    };
}

describe('hasValidSession', () => {
    it('accepts a session with a token expiring in the future', () => {
        expect(hasValidSession(validSession(), NOW_SEC)).toBe(true);
    });

    it('rejects a missing session', () => {
        expect(hasValidSession(undefined, NOW_SEC)).toBe(false);
        expect(hasValidSession(null, NOW_SEC)).toBe(false);
    });

    it('rejects an expired session', () => {
        expect(hasValidSession(validSession({ expires_at: NOW_SEC - 10 }), NOW_SEC)).toBe(false);
    });

    it('rejects a session without an access token', () => {
        expect(hasValidSession(validSession({ access_token: null }), NOW_SEC)).toBe(false);
    });
});

describe('decideEntryState', () => {
    it('shows welcome on first install with onboarding pending (auth comes later)', () => {
        expect(decideEntryState({
            isFirstInstall: true,
            showOnboarding: true,
            session: null,
            nowSec: NOW_SEC,
        })).toBe('welcome');
    });

    it('requires auth when opening the modal without a session', () => {
        expect(decideEntryState({
            isFirstInstall: false,
            showOnboarding: false,
            session: null,
            nowSec: NOW_SEC,
        })).toBe('auth_required');
    });

    it('requires auth when the session is expired', () => {
        expect(decideEntryState({
            isFirstInstall: false,
            showOnboarding: false,
            session: validSession({ expires_at: NOW_SEC - 10 }),
            nowSec: NOW_SEC,
        })).toBe('auth_required');
    });

    it('goes to platform select with a valid session', () => {
        expect(decideEntryState({
            isFirstInstall: false,
            showOnboarding: false,
            session: validSession(),
            nowSec: NOW_SEC,
        })).toBe('platform_select');
    });

    it('re-opened first-install modal after onboarding seen still gates on auth', () => {
        expect(decideEntryState({
            isFirstInstall: true,
            showOnboarding: false,
            session: null,
            nowSec: NOW_SEC,
        })).toBe('auth_required');
    });
});

describe('AUTH_SESSION_STORAGE_KEY', () => {
    it('matches the auth-service storage key', () => {
        expect(AUTH_SESSION_STORAGE_KEY).toBe('auth_session');
    });
});
