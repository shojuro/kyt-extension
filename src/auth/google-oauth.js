/**
 * Google OAuth for Chrome extensions via chrome.identity.launchWebAuthFlow.
 *
 * Uses Supabase as the OAuth provider relay:
 *   1. Opens Supabase /auth/v1/authorize?provider=google
 *   2. Supabase handles the Google consent screen
 *   3. Supabase redirects back to the extension's chromiumapp.org URL
 *   4. We parse the fragment for access_token + refresh_token
 *
 * PREREQUISITE: Register the redirect URL in Supabase Dashboard →
 *   Authentication → URL Configuration → Redirect URLs:
 *   https://<extension-id>.chromiumapp.org/
 */

import { SUPABASE_URL } from '../supabase-config.js';
import { AUTH_SESSION_KEY } from './auth-service.js';

/**
 * Initiate Google OAuth sign-in via chrome.identity.launchWebAuthFlow.
 * @returns {Promise<Object>} Stored session
 */
export async function signInWithGoogle() {
  const redirectUrl = `https://${chrome.runtime.id}.chromiumapp.org/`;

  const authUrl =
    `${SUPABASE_URL}/auth/v1/authorize` +
    `?provider=google` +
    `&redirect_to=${encodeURIComponent(redirectUrl)}`;

  // Opens the Supabase → Google consent flow in a browser popup
  const callbackUrl = await new Promise((resolve, reject) => {
    chrome.identity.launchWebAuthFlow(
      { url: authUrl, interactive: true },
      (responseUrl) => {
        if (chrome.runtime.lastError) {
          return reject(new Error(chrome.runtime.lastError.message));
        }
        if (!responseUrl) {
          return reject(new Error('OAuth flow was cancelled'));
        }
        resolve(responseUrl);
      },
    );
  });

  // Supabase returns tokens in the URL fragment (#access_token=...&refresh_token=...)
  const hashString = new URL(callbackUrl).hash.substring(1); // drop the '#'
  const params = new URLSearchParams(hashString);

  const accessToken = params.get('access_token');
  const refreshToken = params.get('refresh_token');
  const expiresIn = parseInt(params.get('expires_in') || '3600', 10);

  if (!accessToken) {
    throw new Error('No access_token returned from OAuth flow');
  }

  // Decode the JWT payload to extract user info (no verification needed —
  // Supabase already validated it, we just need the claims for display)
  let user = {};
  try {
    const payload = JSON.parse(atob(accessToken.split('.')[1]));
    user = {
      id: payload.sub,
      email: payload.email,
    };
  } catch {
    // If decode fails, leave user empty — non-critical
  }

  const session = {
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_at: Math.floor(Date.now() / 1000) + expiresIn,
    user,
  };

  await chrome.storage.local.set({ [AUTH_SESSION_KEY]: session });
  return session;
}
