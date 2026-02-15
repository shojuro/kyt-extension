/**
 * Legacy data migration: moves data from old anonymous userId to
 * the authenticated user's ID via the claim_user_data edge function.
 */

import { callEdgeFunction } from '../api-client.js';

/**
 * Check if the user has legacy data under a different userId and migrate it.
 *
 * @param {string} authUserId - The authenticated user's UUID (from JWT)
 * @returns {Promise<{migrated: boolean, oldUserId?: string}>}
 */
export async function checkAndMigrateLegacyData(authUserId) {
  // 1. Read legacy config
  const result = await chrome.storage.local.get(['api_config']);
  const legacyUserId = result.api_config?.userId;

  if (!legacyUserId || legacyUserId === authUserId) {
    return { migrated: false };
  }

  // 2. Call claim_user_data edge function
  const response = await callEdgeFunction('claim_user_data', {
    oldUserId: legacyUserId,
  });

  if (!response.success) {
    throw new Error(response.error || 'Data migration failed');
  }

  // 3. Update local config to point to authenticated user
  const updatedConfig = { ...result.api_config, userId: authUserId };
  await chrome.storage.local.set({ api_config: updatedConfig });

  console.log(`Data migrated: ${legacyUserId} → ${authUserId}`);

  return {
    migrated: true,
    oldUserId: legacyUserId,
    recordsMigrated: response.records_migrated || 0,
  };
}
