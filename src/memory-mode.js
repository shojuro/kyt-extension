/**
 * Memory Mode Module
 * Controls capture and injection behavior per-device.
 *
 * Modes:
 *   full       — capture + inject (default)
 *   clean_room — capture only, no injection
 *   incognito  — no capture, no injection
 *
 * Stored in chrome.storage.local (client-side only, not in DB).
 */

export const MEMORY_MODE_KEY = 'kyt_memory_mode';
export const VALID_MODES = ['full', 'clean_room', 'incognito'];
export const DEFAULT_MODE = 'full';

/**
 * Get current memory mode from storage.
 * @returns {Promise<'full'|'clean_room'|'incognito'>}
 */
export async function getMemoryMode() {
  const result = await chrome.storage.local.get([MEMORY_MODE_KEY]);
  const mode = result[MEMORY_MODE_KEY];
  return VALID_MODES.includes(mode) ? mode : DEFAULT_MODE;
}

/**
 * Set memory mode. Validates input and updates badge.
 * @param {'full'|'clean_room'|'incognito'} mode
 */
export async function setMemoryMode(mode) {
  if (!VALID_MODES.includes(mode)) {
    throw new Error(`Invalid memory mode: ${mode}. Must be one of: ${VALID_MODES.join(', ')}`);
  }
  await chrome.storage.local.set({ [MEMORY_MODE_KEY]: mode });
  console.log(`🧠 Memory mode set to: ${mode}`);
  updateBadge(mode);
}

/**
 * Update extension badge to reflect current mode.
 * @param {'full'|'clean_room'|'incognito'} mode
 */
export function updateBadge(mode) {
  switch (mode) {
    case 'full':
      chrome.action.setBadgeText({ text: '' });
      break;
    case 'clean_room':
      chrome.action.setBadgeText({ text: 'CR' });
      chrome.action.setBadgeBackgroundColor({ color: '#D4890B' });
      break;
    case 'incognito':
      chrome.action.setBadgeText({ text: 'OFF' });
      chrome.action.setBadgeBackgroundColor({ color: '#888888' });
      break;
  }
}

/**
 * Whether message capture is allowed in the current mode.
 * @returns {Promise<boolean>}
 */
export async function isCaptureAllowed() {
  const mode = await getMemoryMode();
  return mode !== 'incognito';
}

/**
 * Whether context injection is allowed in the current mode.
 * @returns {Promise<boolean>}
 */
export async function isInjectionAllowed() {
  const mode = await getMemoryMode();
  return mode === 'full';
}
