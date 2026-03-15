/**
 * Unit Tests for src/auth/auth-service.js
 *
 * 18 tests covering: signUp, signIn, signOut, getAuthStatus,
 * getSession, refreshSession, getAccessToken, isAuthenticated
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setupChromeMocks, resetAllMocks } from '../setup.js';

// ---------------------------------------------------------------------------
// Module mocks — declared before any import of the module under test
// ---------------------------------------------------------------------------

vi.mock('../../src/supabase-config.js', () => ({
  SUPABASE_URL: 'https://test.supabase.co',
  SUPABASE_ANON_KEY: 'test-anon-key',
}));

vi.mock('../../src/utils/fetch.js', () => ({
  fetchWithTimeout: vi.fn(),
}));

// Import after mocks are declared
import {
  signUp,
  signIn,
  signOut,
  getAuthStatus,
  getSession,
  refreshSession,
  getAccessToken,
  isAuthenticated,
  AUTH_SESSION_KEY,
  AUTH_EXPIRED_KEY,
} from '../../src/auth/auth-service.js';
import { fetchWithTimeout } from '../../src/utils/fetch.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal Response-like object */
function makeResponse(status, body) {
  const ok = status >= 200 && status < 300;
  return {
    status,
    ok,
    json: () => Promise.resolve(body),
  };
}

/** Return a future timestamp (seconds) that is not near expiry */
function futureExpiry(secondsFromNow = 3600) {
  return Math.floor(Date.now() / 1000) + secondsFromNow;
}

/** Return a past timestamp (seconds) — already expired */
function pastExpiry(secondsAgo = 60) {
  return Math.floor(Date.now() / 1000) - secondsAgo;
}

/** Pre-populate storage with a valid session */
async function seedSession(overrides = {}) {
  const session = {
    access_token: 'test-access-token',
    refresh_token: 'test-refresh-token',
    expires_at: futureExpiry(3600),
    user: { id: 'user-123', email: 'user@example.com' },
    ...overrides,
  };
  await chrome.storage.local.set({ [AUTH_SESSION_KEY]: session });
  return session;
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  setupChromeMocks();
  vi.clearAllMocks();
});

afterEach(() => {
  resetAllMocks();
});

// ---------------------------------------------------------------------------
// signIn
// ---------------------------------------------------------------------------

describe('signIn()', () => {
  it('1. success: stores session with access_token, refresh_token, user.id', async () => {
    fetchWithTimeout.mockResolvedValue(makeResponse(200, {
      access_token: 'acc-token',
      refresh_token: 'ref-token',
      expires_in: 3600,
      user: { id: 'uid-1', email: 'a@b.com' },
    }));

    const session = await signIn('a@b.com', 'password123');

    expect(session.access_token).toBe('acc-token');
    expect(session.refresh_token).toBe('ref-token');
    expect(session.user.id).toBe('uid-1');

    // Verify it was stored
    const stored = await chrome.storage.local.get([AUTH_SESSION_KEY]);
    expect(stored[AUTH_SESSION_KEY].access_token).toBe('acc-token');
  });

  it('2. failure (401): throws with error description', async () => {
    fetchWithTimeout.mockResolvedValue(makeResponse(401, {
      error_description: 'Invalid login credentials',
    }));

    await expect(signIn('a@b.com', 'wrong'))
      .rejects.toThrow('Invalid login credentials');
  });
});

// ---------------------------------------------------------------------------
// signOut
// ---------------------------------------------------------------------------

describe('signOut()', () => {
  it('3. removes auth_session and auth_expired from storage', async () => {
    await seedSession();
    await chrome.storage.local.set({ [AUTH_EXPIRED_KEY]: false });

    await signOut();

    const result = await chrome.storage.local.get([AUTH_SESSION_KEY, AUTH_EXPIRED_KEY]);
    expect(result[AUTH_SESSION_KEY]).toBeUndefined();
    expect(result[AUTH_EXPIRED_KEY]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// getAuthStatus
// ---------------------------------------------------------------------------

describe('getAuthStatus()', () => {
  it('4. valid session: returns { authenticated: true, expired: false }', async () => {
    await seedSession({ expires_at: futureExpiry(3600) });

    const status = await getAuthStatus();

    expect(status.authenticated).toBe(true);
    expect(status.expired).toBe(false);
    expect(status.userId).toBe('user-123');
  });

  it('5. expired session: returns { authenticated: false, expired: true }', async () => {
    await seedSession({ expires_at: pastExpiry(60) });

    const status = await getAuthStatus();

    expect(status.authenticated).toBe(false);
    expect(status.expired).toBe(true);
  });

  it('6. no session: returns { authenticated: false, expired: false }', async () => {
    // Storage is empty (no session seeded)
    const status = await getAuthStatus();

    expect(status.authenticated).toBe(false);
    expect(status.expired).toBe(false);
    expect(status.userId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getSession
// ---------------------------------------------------------------------------

describe('getSession()', () => {
  it('7. valid non-expiring token: returns session as-is without refreshing', async () => {
    const session = await seedSession({ expires_at: futureExpiry(3600) });

    const result = await getSession();

    expect(result.access_token).toBe(session.access_token);
    // fetchWithTimeout should NOT have been called (no refresh)
    expect(fetchWithTimeout).not.toHaveBeenCalled();
  });

  it('8. near-expiry token: triggers refreshSession()', async () => {
    // Token expires in 2 minutes — within the 5-minute margin
    await seedSession({ expires_at: futureExpiry(120) });

    fetchWithTimeout.mockResolvedValue(makeResponse(200, {
      access_token: 'new-acc-token',
      refresh_token: 'new-ref-token',
      expires_in: 3600,
      user: { id: 'user-123', email: 'user@example.com' },
    }));

    const result = await getSession();

    expect(fetchWithTimeout).toHaveBeenCalled();
    expect(result.access_token).toBe('new-acc-token');
  });

  it('9. refresh fails and token is expired: sets auth_expired, returns null', async () => {
    // Already expired
    await seedSession({ expires_at: pastExpiry(10) });

    fetchWithTimeout.mockResolvedValue(makeResponse(401, {
      error_description: 'Refresh token expired',
    }));

    const result = await getSession();

    expect(result).toBeNull();
    const stored = await chrome.storage.local.get([AUTH_EXPIRED_KEY]);
    expect(stored[AUTH_EXPIRED_KEY]).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// refreshSession
// ---------------------------------------------------------------------------

describe('refreshSession()', () => {
  it('10. success: stores new session with updated tokens', async () => {
    fetchWithTimeout.mockResolvedValue(makeResponse(200, {
      access_token: 'refreshed-token',
      refresh_token: 'new-refresh',
      expires_in: 3600,
      user: { id: 'user-123', email: 'user@example.com' },
    }));

    const session = await refreshSession('old-refresh-token');

    expect(session.access_token).toBe('refreshed-token');
    const stored = await chrome.storage.local.get([AUTH_SESSION_KEY]);
    expect(stored[AUTH_SESSION_KEY].access_token).toBe('refreshed-token');
  });

  it('11. failure: throws with error description', async () => {
    fetchWithTimeout.mockResolvedValue(makeResponse(401, {
      error_description: 'Invalid refresh token',
    }));

    await expect(refreshSession('bad-token'))
      .rejects.toThrow('Invalid refresh token');
  });

  it('12. no token provided and none in storage: throws "No refresh token"', async () => {
    // Storage is empty — no session
    await expect(refreshSession())
      .rejects.toThrow('No refresh token available');
  });
});

// ---------------------------------------------------------------------------
// getAccessToken
// ---------------------------------------------------------------------------

describe('getAccessToken()', () => {
  it('13. valid session: returns access_token string', async () => {
    await seedSession({ expires_at: futureExpiry(3600) });

    const token = await getAccessToken();

    expect(token).toBe('test-access-token');
  });

  it('14. no session: throws "Not authenticated"', async () => {
    // Storage is empty
    await expect(getAccessToken())
      .rejects.toThrow('Not authenticated');
  });
});

// ---------------------------------------------------------------------------
// isAuthenticated
// ---------------------------------------------------------------------------

describe('isAuthenticated()', () => {
  it('15. valid non-expired token: returns true', async () => {
    await seedSession({ expires_at: futureExpiry(3600) });

    const result = await isAuthenticated();

    expect(result).toBe(true);
  });

  it('16. no session in storage: returns false', async () => {
    // Storage is empty
    const result = await isAuthenticated();

    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// signUp
// ---------------------------------------------------------------------------

describe('signUp()', () => {
  it('17. immediate token (no confirmation): stores session', async () => {
    fetchWithTimeout.mockResolvedValue(makeResponse(200, {
      access_token: 'signup-token',
      refresh_token: 'signup-refresh',
      expires_in: 3600,
      user: { id: 'new-user', email: 'new@example.com' },
    }));

    const session = await signUp('new@example.com', 'newpassword');

    expect(session.access_token).toBe('signup-token');
    const stored = await chrome.storage.local.get([AUTH_SESSION_KEY]);
    expect(stored[AUTH_SESSION_KEY].access_token).toBe('signup-token');
  });

  it('18. confirmation required: returns { confirmation_required: true }', async () => {
    fetchWithTimeout.mockResolvedValue(makeResponse(200, {
      // No access_token — confirmation email sent
      id: 'pending-user-id',
      email: 'pending@example.com',
    }));

    const result = await signUp('pending@example.com', 'pass');

    expect(result.confirmation_required).toBe(true);
    expect(result.email).toBe('pending@example.com');
  });
});
