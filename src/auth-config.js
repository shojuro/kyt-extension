/**
 * Auth & API Configuration Module
 * Extracted from background.js — caching, routing mode, config resolution.
 *
 * IMPORTANT (MV3): All imports must be static. No dynamic import().
 */

import { AUTH_SESSION_KEY, getSession } from './auth/auth-service.js';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './supabase-config.js';

// ===== CONFIG CACHE =====
let cachedApiConfig = null;
let configLoadTime = 0;
const CONFIG_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Get API config with caching to survive service worker sleep
 */
export async function getApiConfig() {
  // Always check test mode — even on cached config (toggle takes effect immediately)
  const testFlags = await chrome.storage.local.get(['kyt_test_mode', 'kyt_test_user_id']);
  const testModeActive = !!(testFlags.kyt_test_mode && testFlags.kyt_test_user_id);

  if (cachedApiConfig && (Date.now() - configLoadTime) < CONFIG_CACHE_TTL) {
    // If test mode changed, invalidate cache
    if (testModeActive !== !!cachedApiConfig._testMode) {
      cachedApiConfig = null;
    } else {
      return cachedApiConfig;
    }
  }

  const result = await chrome.storage.local.get(['api_config', AUTH_SESSION_KEY, 'user_id']);

  // Prefer auth session for authenticated users
  const session = result[AUTH_SESSION_KEY];
  if (session?.access_token && session.expires_at > Math.floor(Date.now() / 1000)) {
    cachedApiConfig = {
      supabaseUrl: SUPABASE_URL,
      supabaseKey: SUPABASE_ANON_KEY,
      accessToken: session.access_token,
      userId: session.user?.id || result.user_id,
      authMode: 'jwt',
      disableQueryTransformation: result.api_config?.disableQueryTransformation ?? true,
    };
  } else if (result.api_config) {
    cachedApiConfig = result.api_config;
    if (!cachedApiConfig.userId) {
      cachedApiConfig.userId = result.user_id || null;
    }
  } else {
    throw new Error('API configuration not found - run setup.html');
  }

  // Test mode: override userId for retrieval (dev testing only)
  if (testModeActive) {
    cachedApiConfig.userId = testFlags.kyt_test_user_id;
    cachedApiConfig._testMode = true;
    console.log('🧪 TEST MODE: retrieval using user', testFlags.kyt_test_user_id);
  }

  configLoadTime = Date.now();
  return cachedApiConfig;
}

/**
 * Determine routing mode: 'edge' (authenticated), 'legacy' (API keys), or 'unconfigured'.
 * Edge mode routes sync/search through Supabase Edge Functions.
 * Legacy mode uses direct HuggingFace + Supabase REST calls.
 */
export async function getRoutingMode() {
  const result = await chrome.storage.local.get([AUTH_SESSION_KEY, 'api_config']);
  const session = result[AUTH_SESSION_KEY];
  if (session?.access_token && session.expires_at > Math.floor(Date.now() / 1000)) {
    return 'edge';
  }
  // Token expired — try refresh before falling back to legacy
  if (session?.refresh_token) {
    try {
      const refreshed = await getSession();
      if (refreshed?.access_token) return 'edge';
    } catch (e) {
      console.warn('Token refresh failed in getRoutingMode:', e.message);
    }
  }
  if (result.api_config?.supabaseUrl && result.api_config?.supabaseKey) {
    return 'legacy';
  }
  return 'unconfigured';
}

/**
 * Clear config cache (called on service worker suspend)
 */
export function clearConfigCache() {
  cachedApiConfig = null;
  configLoadTime = 0;
}
