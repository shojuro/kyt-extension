/**
 * Thin HTTP client for calling Supabase Edge Functions with auth.
 *
 * Tries auth_session JWT first; falls back to legacy api_config.supabaseKey.
 * Uses fetchWithTimeout from src/utils/fetch.js.
 */

import { SUPABASE_URL, SUPABASE_ANON_KEY } from './supabase-config.js';
import { getAccessToken, getSession, refreshSession } from './auth/auth-service.js';
import { fetchWithTimeout } from './utils/fetch.js';

/**
 * Call a Supabase Edge Function.
 *
 * @param {string} functionName - e.g. 'search_memories', 'save_chat_turn_batch'
 * @param {Object} body - JSON request body
 * @param {Object} [options]
 * @param {number} [options.timeoutMs=30000] - Request timeout
 * @returns {Promise<Object>} Parsed JSON response
 */
export async function callEdgeFunction(functionName, body, options = {}) {
  const { timeoutMs = 30000 } = options;

  // 1. Resolve auth: prefer JWT session, fall back to legacy anon key
  let bearerToken;
  let supabaseUrl = SUPABASE_URL;

  try {
    bearerToken = await getAccessToken();
  } catch {
    // Not authenticated via auth_session — try legacy config
    const result = await chrome.storage.local.get(['api_config']);
    const config = result.api_config;
    if (config?.supabaseKey) {
      bearerToken = config.supabaseKey;
      if (config.supabaseUrl) supabaseUrl = config.supabaseUrl;
    } else {
      throw new Error('Not authenticated and no API keys configured');
    }
  }

  // 2. Make the request
  const url = `${supabaseUrl}/functions/v1/${functionName}`;

  const res = await fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${bearerToken}`,
        apikey: SUPABASE_ANON_KEY,
      },
      body: JSON.stringify(body),
    },
    timeoutMs,
  );

  // 3. Handle errors
  if (res.status === 401) {
    // Token expired mid-flight — try one refresh + retry
    try {
      await refreshSession();
      const newToken = await getAccessToken();

      const retryRes = await fetchWithTimeout(
        url,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${newToken}`,
            apikey: SUPABASE_ANON_KEY,
          },
          body: JSON.stringify(body),
        },
        timeoutMs,
      );

      if (!retryRes.ok) {
        const errBody = await retryRes.json().catch(() => ({}));
        throw new Error(errBody.error || `Edge function ${functionName} returned ${retryRes.status}`);
      }
      return retryRes.json();
    } catch (refreshErr) {
      throw new Error(`Authentication failed: ${refreshErr.message}`);
    }
  }

  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    throw new Error(errBody.error || `Edge function ${functionName} returned ${res.status}`);
  }

  return res.json();
}
