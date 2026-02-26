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
  // Check cache first
  const cached = await chrome.storage.local.get([ACTIVE_PROFILE_KEY]);
  if (cached[ACTIVE_PROFILE_KEY]) {
    return cached[ACTIVE_PROFILE_KEY];
  }

  // Fall back to userId from auth session or stored user_id
  const result = await chrome.storage.local.get(['auth_session', 'user_id']);
  const userId = result.auth_session?.user?.id || result.user_id || null;

  // Cache it
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
