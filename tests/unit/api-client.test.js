/**
 * Unit Tests for src/api-client.js
 *
 * Tests callEdgeFunction(functionName, body, options) covering:
 * - Happy path JWT flow
 * - Legacy key fallback
 * - Auth failure paths
 * - 401 retry with token refresh
 * - Error body extraction
 * - Non-JSON response handling
 * - Custom timeoutMs forwarding
 * - URL construction
 * - Header correctness
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setupChromeMocks, resetAllMocks } from '../setup.js';

// ---------------------------------------------------------------------------
// Module mocks — declared before any import of the module under test
// ---------------------------------------------------------------------------

vi.mock('../../src/supabase-config.js', () => ({
  SUPABASE_URL: 'https://svrcvfzlwhnixzuxaccf.supabase.co',
  SUPABASE_ANON_KEY: 'test-anon-key',
}));

vi.mock('../../src/auth/auth-service.js', () => ({
  getAccessToken: vi.fn(),
  getSession: vi.fn(),
  refreshSession: vi.fn(),
}));

vi.mock('../../src/utils/fetch.js', () => ({
  fetchWithTimeout: vi.fn(),
}));

// Import after mocks are declared
import { callEdgeFunction } from '../../src/api-client.js';
import { getAccessToken, refreshSession } from '../../src/auth/auth-service.js';
import { fetchWithTimeout } from '../../src/utils/fetch.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal Response-like object */
function makeResponse(status, body, ok = status >= 200 && status < 300) {
  return {
    status,
    ok,
    json: typeof body === 'string'
      ? () => Promise.reject(new SyntaxError('Unexpected token'))
      : () => Promise.resolve(body),
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let chromeMocks;

beforeEach(() => {
  chromeMocks = setupChromeMocks();
  vi.clearAllMocks();
});

afterEach(() => {
  resetAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('callEdgeFunction', () => {

  // 1. Happy path: JWT resolves, fetch 200 JSON → returns parsed body
  it('1. returns parsed JSON body on successful JWT + 200 response', async () => {
    getAccessToken.mockResolvedValue('jwt-token-abc');
    fetchWithTimeout.mockResolvedValue(makeResponse(200, { result: 'ok' }));

    const result = await callEdgeFunction('my_function', { foo: 'bar' });

    expect(result).toEqual({ result: 'ok' });
  });

  // 2. JWT unavailable, legacy supabaseKey in storage → uses anon key
  it('2. falls back to legacy supabaseKey when JWT throws', async () => {
    getAccessToken.mockRejectedValue(new Error('Not signed in'));
    await chrome.storage.local.set({
      api_config: { supabaseKey: 'legacy-anon-key' },
    });
    fetchWithTimeout.mockResolvedValue(makeResponse(200, { data: 'legacy' }));

    const result = await callEdgeFunction('my_function', {});

    expect(result).toEqual({ data: 'legacy' });
    // Should use the legacy key as Bearer
    const [, init] = fetchWithTimeout.mock.calls[0];
    expect(init.headers.Authorization).toBe('Bearer legacy-anon-key');
  });

  // 3. Neither JWT nor legacy key → throws "Not authenticated"
  it('3. throws "Not authenticated" when no JWT and no stored key', async () => {
    getAccessToken.mockRejectedValue(new Error('No session'));
    // storage has no api_config

    await expect(callEdgeFunction('my_function', {}))
      .rejects.toThrow('Not authenticated and no API keys configured');
  });

  // 4. 401 with JWT: calls refreshSession(), retries, succeeds
  it('4. retries after 401 by refreshing session token', async () => {
    getAccessToken
      .mockResolvedValueOnce('old-jwt')
      .mockResolvedValueOnce('new-jwt');
    refreshSession.mockResolvedValue(undefined);

    // First call → 401, retry call → 200
    fetchWithTimeout
      .mockResolvedValueOnce(makeResponse(401, {}, false))
      .mockResolvedValueOnce(makeResponse(200, { retried: true }));

    const result = await callEdgeFunction('my_function', {});

    expect(refreshSession).toHaveBeenCalledOnce();
    expect(result).toEqual({ retried: true });
    // Second fetch should use the new token
    const [, retryInit] = fetchWithTimeout.mock.calls[1];
    expect(retryInit.headers.Authorization).toBe('Bearer new-jwt');
  });

  // 5. 401 with legacy key: throws immediately, message includes "requires JWT auth"
  it('5. throws immediately on 401 when using legacy anon key', async () => {
    getAccessToken.mockRejectedValue(new Error('No JWT'));
    await chrome.storage.local.set({
      api_config: { supabaseKey: 'legacy-key' },
    });
    fetchWithTimeout.mockResolvedValue(makeResponse(401, {}, false));

    await expect(callEdgeFunction('secure_function', {}))
      .rejects.toThrow('requires JWT auth');
  });

  // 6. 401 + refresh fails: throws "Authentication failed"
  it('6. throws "Authentication failed" when refresh throws', async () => {
    getAccessToken.mockResolvedValue('stale-jwt');
    refreshSession.mockRejectedValue(new Error('Refresh token expired'));
    fetchWithTimeout.mockResolvedValue(makeResponse(401, {}, false));

    await expect(callEdgeFunction('my_function', {}))
      .rejects.toThrow('Authentication failed');
  });

  // 7. Non-200 with JSON error body: extracts `error` field
  it('7. extracts error field from JSON error body on non-200', async () => {
    getAccessToken.mockResolvedValue('jwt');
    fetchWithTimeout.mockResolvedValue(makeResponse(422, { error: 'Validation failed' }, false));

    await expect(callEdgeFunction('my_function', {}))
      .rejects.toThrow('Validation failed');
  });

  // 8. Non-200 with non-JSON body: throws with status code
  it('8. throws with status code when non-200 response has non-JSON body', async () => {
    getAccessToken.mockResolvedValue('jwt');
    fetchWithTimeout.mockResolvedValue(makeResponse(503, 'Service Unavailable', false));

    await expect(callEdgeFunction('my_function', {}))
      .rejects.toThrow('503');
  });

  // 9. 200 with non-JSON body: throws "returned non-JSON response"
  it('9. throws "returned non-JSON response" when 200 response is not JSON', async () => {
    getAccessToken.mockResolvedValue('jwt');
    fetchWithTimeout.mockResolvedValue(makeResponse(200, 'not-json', true));

    await expect(callEdgeFunction('my_function', {}))
      .rejects.toThrow('returned non-JSON response');
  });

  // 10. Custom timeoutMs forwarded to fetchWithTimeout
  it('10. forwards custom timeoutMs to fetchWithTimeout', async () => {
    getAccessToken.mockResolvedValue('jwt');
    fetchWithTimeout.mockResolvedValue(makeResponse(200, { ok: true }));

    await callEdgeFunction('my_function', {}, { timeoutMs: 5000 });

    const [, , timeout] = fetchWithTimeout.mock.calls[0];
    expect(timeout).toBe(5000);
  });

  // 11. URL constructed correctly
  it('11. constructs URL as <supabaseUrl>/functions/v1/<functionName>', async () => {
    getAccessToken.mockResolvedValue('jwt');
    fetchWithTimeout.mockResolvedValue(makeResponse(200, {}));

    await callEdgeFunction('search_memories', {});

    const [url] = fetchWithTimeout.mock.calls[0];
    expect(url).toBe('https://svrcvfzlwhnixzuxaccf.supabase.co/functions/v1/search_memories');
  });

  // 12. Headers include Authorization Bearer and apikey
  it('12. sends Authorization Bearer and apikey headers', async () => {
    getAccessToken.mockResolvedValue('my-jwt-token');
    fetchWithTimeout.mockResolvedValue(makeResponse(200, {}));

    await callEdgeFunction('my_function', { data: 1 });

    const [, init] = fetchWithTimeout.mock.calls[0];
    expect(init.headers.Authorization).toBe('Bearer my-jwt-token');
    expect(init.headers.apikey).toBe('test-anon-key');
    expect(init.headers['Content-Type']).toBe('application/json');
  });

});
