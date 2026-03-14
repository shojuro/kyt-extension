/**
 * Project Manager Module
 * Manages active project context for scoped memory capture and retrieval.
 *
 * Storage keys:
 *   kyt_active_project_id    — UUID or null (general mode)
 *   kyt_active_project_name  — display name for badge
 *   kyt_active_project_vault — boolean (vault privacy flag)
 *
 * IMPORTANT (MV3): All imports must be static. No dynamic import().
 */

/**
 * Get the currently active project.
 * @returns {Promise<{id: string|null, name: string|null, isVault: boolean}>}
 */
export async function getActiveProject() {
  const result = await chrome.storage.local.get([
    'kyt_active_project_id',
    'kyt_active_project_name',
    'kyt_active_project_vault'
  ]);
  return {
    id: result.kyt_active_project_id || null,
    name: result.kyt_active_project_name || null,
    isVault: result.kyt_active_project_vault || false,
  };
}

/**
 * Set the active project.
 * @param {string} id - Project UUID
 * @param {string} name - Project display name
 * @param {boolean} isVault - Whether this is a vault project
 */
export async function setActiveProject(id, name, isVault = false) {
  await chrome.storage.local.set({
    kyt_active_project_id: id,
    kyt_active_project_name: name,
    kyt_active_project_vault: isVault,
  });
  updateProjectBadge(name, isVault);
}

/**
 * Clear the active project (return to general mode).
 */
export async function clearActiveProject() {
  await chrome.storage.local.remove([
    'kyt_active_project_id',
    'kyt_active_project_name',
    'kyt_active_project_vault'
  ]);
  updateProjectBadge(null, false);
}

/**
 * Update the extension badge to show active project.
 * Vault projects show a lock icon; regular projects show 2-char abbreviation.
 * General mode (no project) clears the badge text.
 * @param {string|null} name - Project name or null
 * @param {boolean} isVault - Vault flag
 */
function updateProjectBadge(name, isVault) {
  if (!name) {
    // General mode — clear project badge
    chrome.action.setBadgeText({ text: '' });
    return;
  }
  if (isVault) {
    // Vault projects use generic lock icon (S5: prevent name leakage)
    chrome.action.setBadgeText({ text: '\u{1F512}' });
    chrome.action.setBadgeBackgroundColor({ color: '#FF4444' });
    return;
  }
  // Regular project: 2-char abbreviation
  const abbrev = name.substring(0, 2).toUpperCase();
  chrome.action.setBadgeText({ text: abbrev });
  chrome.action.setBadgeBackgroundColor({ color: '#00AA66' });
}
