/**
 * Profile Manager Module
 * Manages the active profile for memory isolation.
 *
 * MVP: profile_id = user_id (1:1 mapping).
 * Future: Multiple profiles per user for context separation.
 *
 * IMPORTANT: Static imports only (MV3 service worker).
 */

const ACTIVE_PROFILE_KEY = 'kyt_active_profile_id';

/**
 * Get the active profile ID.
 * MVP: Always returns userId (1:1 mapping).
 * @returns {Promise<string|null>}
 */
export async function getActiveProfileId() {
  const result = await chrome.storage.local.get([ACTIVE_PROFILE_KEY, 'auth_session', 'user_id']);
  const cached = result[ACTIVE_PROFILE_KEY];
  const sessionUserId = result.auth_session?.user?.id;

  // If a JWT session exists, its user_id is authoritative (must match auth.uid() for RLS).
  // Invalidate cache if it differs (e.g. user switched accounts).
  if (sessionUserId && cached && cached !== sessionUserId) {
    await chrome.storage.local.set({ [ACTIVE_PROFILE_KEY]: sessionUserId });
    return sessionUserId;
  }

  if (cached) return cached;

  // Fall back to userId from auth session or stored user_id
  const userId = sessionUserId || result.user_id || null;

  if (userId) {
    await chrome.storage.local.set({ [ACTIVE_PROFILE_KEY]: userId });
  }

  return userId;
}

/**
 * Set the active profile ID.
 * @param {string} profileId
 */
export async function setActiveProfileId(profileId) {
  if (!profileId || typeof profileId !== 'string') {
    throw new Error('Invalid profile ID');
  }
  await chrome.storage.local.set({ [ACTIVE_PROFILE_KEY]: profileId });
  console.log(`Active profile set to: ${profileId.substring(0, 8)}...`);
}

/**
 * Clear the active profile (e.g., on sign-out).
 */
export async function clearActiveProfile() {
  await chrome.storage.local.remove(ACTIVE_PROFILE_KEY);
  console.log('Active profile cleared');
}
