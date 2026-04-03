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
const AUTH_EXPIRED_KEY = 'auth_expired';
const REFRESH_LOCK_KEY = 'kyt_auth_refresh_lock';
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000; // Refresh when <5 min left
const REFRESH_LOCK_TTL_MS = 10000; // 10s stale lock expiry

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
  await chrome.storage.local.set({
    [AUTH_SESSION_KEY]: session,
    [AUTH_EXPIRED_KEY]: false,  // Clear expired flag on fresh session
    user_id: data.user?.id,    // Persist independently — survives session expiry
  });
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
  await chrome.storage.local.remove([AUTH_SESSION_KEY, AUTH_EXPIRED_KEY]);
}

/**
 * Get auth status including expiry state.
 * @returns {Promise<{authenticated: boolean, expired: boolean, userId: string|null}>}
 */
export async function getAuthStatus() {
  const result = await chrome.storage.local.get([AUTH_SESSION_KEY, AUTH_EXPIRED_KEY]);
  const session = result[AUTH_SESSION_KEY];
  const expired = result[AUTH_EXPIRED_KEY] === true;
  const nowSec = Math.floor(Date.now() / 1000);

  if (session?.access_token && session.expires_at > nowSec) {
    return { authenticated: true, expired: false, userId: session.user?.id || null };
  }

  return {
    authenticated: false,
    expired: expired || (session != null && session.expires_at <= nowSec),
    userId: session?.user?.id || null,
  };
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

  // Token already expired or about to expire — try refreshing (with mutex)
  if (session.expires_at - nowSec < marginSec) {
    try {
      return await refreshSessionWithLock(session.refresh_token);
    } catch (err) {
      console.warn('Auto-refresh failed:', err.message);
      // If refresh fails and token is truly expired, mark as expired
      // but keep session data (user.id, email) for display purposes
      if (session.expires_at <= nowSec) {
        await chrome.storage.local.set({ [AUTH_EXPIRED_KEY]: true });
        console.warn('Auth session expired — set auth_expired flag (session data preserved)');
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
 * Mutex-protected refresh — serializes concurrent refresh attempts.
 * Multiple tabs/alarm handlers may trigger refresh simultaneously.
 * Supabase refresh token rotation invalidates the old token on first use,
 * so a second concurrent refresh with the same token will fail permanently.
 *
 * @param {string} [refreshToken] - If omitted, reads from stored session
 * @returns {Promise<Object>} New stored session
 */
export async function refreshSessionWithLock(refreshToken) {
  const lock = await chrome.storage.local.get(REFRESH_LOCK_KEY);
  const lockTime = lock[REFRESH_LOCK_KEY] || 0;

  // If another caller is currently refreshing (lock < TTL), wait and read result
  if (Date.now() - lockTime < REFRESH_LOCK_TTL_MS) {
    console.log('🔒 Auth refresh: waiting for concurrent refresh to complete');
    await new Promise(r => setTimeout(r, 2000));
    const result = await chrome.storage.local.get(AUTH_SESSION_KEY);
    if (result[AUTH_SESSION_KEY]?.access_token) {
      return result[AUTH_SESSION_KEY];
    }
    // Other caller may have failed — fall through and try ourselves
  }

  // Acquire lock
  await chrome.storage.local.set({ [REFRESH_LOCK_KEY]: Date.now() });

  try {
    const session = await refreshSession(refreshToken);
    return session;
  } finally {
    // Release lock
    await chrome.storage.local.remove(REFRESH_LOCK_KEY);
  }
}

/**
 * Proactive refresh check — call from any SW entry point (alarm, message, etc.)
 * Refreshes if token expires within 5 minutes. Safe to call frequently.
 * Uses mutex to prevent concurrent refreshes.
 *
 * @returns {Promise<boolean>} True if refresh was performed
 */
export async function proactiveRefreshCheck() {
  const result = await chrome.storage.local.get(AUTH_SESSION_KEY);
  const session = result[AUTH_SESSION_KEY];
  if (!session?.access_token || !session.refresh_token) return false;

  const nowSec = Math.floor(Date.now() / 1000);
  const marginSec = TOKEN_REFRESH_MARGIN_MS / 1000;

  if (session.expires_at - nowSec < marginSec) {
    try {
      await refreshSessionWithLock(session.refresh_token);
      console.log('✅ Proactive auth refresh completed');
      return true;
    } catch (e) {
      console.warn('⚠️ Proactive refresh failed:', e.message);
      // If refresh token itself is dead (weeks of inactivity), flag for re-auth
      if (e.message.includes('Invalid Refresh Token') || e.message.includes('refresh_token_not_found')) {
        await chrome.storage.local.set({ [AUTH_EXPIRED_KEY]: true });
        console.error('🔒 Refresh token expired — user must re-authenticate');
      }
      return false;
    }
  }
  return false;
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

export { AUTH_SESSION_KEY, AUTH_EXPIRED_KEY };
