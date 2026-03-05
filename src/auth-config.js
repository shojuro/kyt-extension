/**
 * Auth & API Configuration Module
 * Extracted from background.js — caching, routing mode, config resolution.
 *
 * IMPORTANT (MV3): All imports must be static. No dynamic import().
 */

import { AUTH_SESSION_KEY } from './auth/auth-service.js';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './supabase-config.js';

// ===== CONFIG CACHE =====
let cachedApiConfig = null;
let configLoadTime = 0;
const CONFIG_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Get API config with caching to survive service worker sleep
 */
export async function getApiConfig() {
  if (cachedApiConfig && (Date.now() - configLoadTime) < CONFIG_CACHE_TTL) {
    console.log('📦 Using cached API config');
    return cachedApiConfig;
  }

  console.log('📥 Loading API config from storage');
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
      // Legacy fields — not needed for edge mode, but some code paths read them
      disableQueryTransformation: result.api_config?.disableQueryTransformation ?? true,
    };
    configLoadTime = Date.now();
    return cachedApiConfig;
  }

  // Fall back to legacy api_config
  if (!result.api_config) {
    throw new Error('API configuration not found - run setup.html');
  }

  cachedApiConfig = result.api_config;
  // Resolve userId: prefer config > stored user_id (survives session expiry)
  if (!cachedApiConfig.userId) {
    cachedApiConfig.userId = result.user_id || null;
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
