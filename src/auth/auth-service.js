/**
 * Auth service for KYT Memory Extension.
 *
 * Uses Supabase Auth REST API directly (no @supabase/supabase-js) because
 * the Supabase JS SDK relies on `window`/`document` which don't exist in
 * MV3 service workers.
 *
 * Session is persisted in chrome.storage.local under the key `auth_session`.
 */

import { SUPABASE_URL, SUPABASE_ANON_KEY } from '../supabase-config.js';
import { fetchWithTimeout } from '../utils/fetch.js';

const AUTH_SESSION_KEY = 'auth_session';
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000; // Refresh when <5 min left

// ─── Helpers ─────────────────────────────────────────────────

/**
 * Build common headers for Supabase Auth REST calls.
 * @param {string} [bearerToken] - Optional JWT for authenticated requests
 * @returns {Record<string, string>}
 */
function authHeaders(bearerToken) {
  const headers = {
    'Content-Type': 'application/json',
    apikey: SUPABASE_ANON_KEY,
  };
  if (bearerToken) {
    headers['Authorization'] = `Bearer ${bearerToken}`;
  }
  return headers;
}

/**
 * Persist a session object returned by Supabase Auth into chrome.storage.
 * @param {Object} data - Supabase auth response (access_token, refresh_token, user, expires_in)
 * @returns {Promise<Object>} The stored session
 */
async function storeSession(data) {
  const session = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Math.floor(Date.now() / 1000) + (data.expires_in || 3600),
    user: {
      id: data.user?.id,
      email: data.user?.email,
    },
  };
  await chrome.storage.local.set({ [AUTH_SESSION_KEY]: session });
  return session;
}

// ─── Public API ──────────────────────────────────────────────

/**
 * Sign up a new user with email + password.
 * @param {string} email
 * @param {string} password
 * @returns {Promise<Object>} Session or confirmation object
 */
export async function signUp(email, password) {
  const res = await fetchWithTimeout(
    `${SUPABASE_URL}/auth/v1/signup`,
    {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ email, password }),
    },
    15000,
  );

  const data = await res.json();

  if (!res.ok) {
    throw new Error(data.error_description || data.msg || 'Sign up failed');
  }

  // If email confirmation is required, data won't have access_token yet
  if (data.access_token) {
    return storeSession(data);
  }

  // Confirmation required — return raw data so UI can show message
  return { confirmation_required: true, email, ...data };
}

/**
 * Sign in with email + password.
 * @param {string} email
 * @param {string} password
 * @returns {Promise<Object>} Stored session
 */
export async function signIn(email, password) {
  const res = await fetchWithTimeout(
    `${SUPABASE_URL}/auth/v1/token?grant_type=password`,
    {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ email, password }),
    },
    15000,
  );

  const data = await res.json();

  if (!res.ok) {
    throw new Error(data.error_description || data.msg || 'Sign in failed');
  }

  return storeSession(data);
}

/**
 * Sign out — clears the local session. Does NOT call Supabase /logout
 * because the token will expire on its own and avoiding an extra network
 * call makes sign-out instant + offline-safe.
 */
export async function signOut() {
  await chrome.storage.local.remove(AUTH_SESSION_KEY);
}

/**
 * Load the current session from chrome.storage.
 * Returns null if no session exists.
 * Auto-refreshes if the token expires within TOKEN_REFRESH_MARGIN_MS.
 * @returns {Promise<Object|null>}
 */
export async function getSession() {
  const result = await chrome.storage.local.get([AUTH_SESSION_KEY]);
  const session = result[AUTH_SESSION_KEY];
  if (!session) return null;

  const nowSec = Math.floor(Date.now() / 1000);
  const marginSec = TOKEN_REFRESH_MARGIN_MS / 1000;

  // Token already expired or about to expire — try refreshing
  if (session.expires_at - nowSec < marginSec) {
    try {
      return await refreshSession(session.refresh_token);
    } catch (err) {
      console.warn('Auto-refresh failed:', err.message);
      // If refresh fails and token is truly expired, clear session
      if (session.expires_at <= nowSec) {
        await signOut();
        return null;
      }
      // Token not yet expired — return as-is, caller can try again later
      return session;
    }
  }

  return session;
}

/**
 * Refresh the session using a refresh token.
 * @param {string} [refreshToken] - If omitted, reads from stored session
 * @returns {Promise<Object>} New stored session
 */
export async function refreshSession(refreshToken) {
  if (!refreshToken) {
    const result = await chrome.storage.local.get([AUTH_SESSION_KEY]);
    refreshToken = result[AUTH_SESSION_KEY]?.refresh_token;
    if (!refreshToken) throw new Error('No refresh token available');
  }

  const res = await fetchWithTimeout(
    `${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`,
    {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ refresh_token: refreshToken }),
    },
    15000,
  );

  const data = await res.json();

  if (!res.ok) {
    throw new Error(data.error_description || data.msg || 'Token refresh failed');
  }

  // Store new tokens immediately (idempotent)
  return storeSession(data);
}

/**
 * Get a valid access token, refreshing if necessary.
 * @returns {Promise<string>} JWT access token
 * @throws If no session exists or refresh fails
 */
export async function getAccessToken() {
  const session = await getSession();
  if (!session) throw new Error('Not authenticated');
  return session.access_token;
}

/**
 * Quick boolean check: is there a session with a non-expired token?
 * Does NOT trigger a refresh — use getSession() for that.
 * @returns {Promise<boolean>}
 */
export async function isAuthenticated() {
  const result = await chrome.storage.local.get([AUTH_SESSION_KEY]);
  const session = result[AUTH_SESSION_KEY];
  if (!session?.access_token) return false;
  return session.expires_at > Math.floor(Date.now() / 1000);
}

export { AUTH_SESSION_KEY };
