/**
 * Browser API Compatibility Layer
 *
 * Firefox MV3 supports `chrome.*` namespace for most APIs (since Firefox 101+),
 * but some APIs differ:
 *   - chrome.action → browser.action (Firefox 109+, same API)
 *   - chrome.identity.launchWebAuthFlow → NOT available in Firefox
 *   - chrome.scripting.executeScript world: "MAIN" → NOT available in Firefox
 *
 * This module:
 *   1. Detects the runtime (Chrome vs Firefox)
 *   2. Exposes `isFirefox` flag for conditional logic
 *   3. Patches missing APIs with Firefox-compatible fallbacks
 *
 * Usage: import { isFirefox } from './browser-compat.js'
 *
 * IMPORTANT: Firefox MV3 (109+) natively supports chrome.* namespace for:
 *   - chrome.storage
 *   - chrome.runtime
 *   - chrome.alarms
 *   - chrome.tabs
 *   - chrome.scripting (without world: "MAIN")
 *   - chrome.action (badge, popup)
 * So we do NOT need to rewrite 397 chrome.* calls. Only patch edge cases.
 */

/**
 * Detect if running in Firefox.
 * Firefox sets `browser` as the primary namespace; Chrome does not.
 */
export const isFirefox = typeof globalThis.browser !== 'undefined' &&
  typeof globalThis.browser.runtime !== 'undefined';

/**
 * Execute a content script in a tab.
 * Wraps chrome.scripting.executeScript with Firefox compatibility:
 * - Firefox doesn't support `world: "MAIN"`, so we strip it.
 * - The MAIN-world injection is handled differently on Firefox
 *   (page script injection via web_accessible_resources).
 *
 * @param {Object} options - chrome.scripting.executeScript options
 * @returns {Promise} Result of script execution
 */
export async function executeScript(options) {
  if (isFirefox && options.world === 'MAIN') {
    // Firefox: inject via content script that adds a <script> tag
    // pointing to the web_accessible_resource
    const { world, ...firefoxOptions } = options;
    return chrome.scripting.executeScript(firefoxOptions);
  }
  return chrome.scripting.executeScript(options);
}

/**
 * Launch OAuth flow.
 * Chrome: uses chrome.identity.launchWebAuthFlow
 * Firefox: uses browser.identity.launchWebAuthFlow (available since Firefox 120)
 *          or falls back to manual tab-based OAuth
 *
 * @param {Object} options - { url, interactive }
 * @returns {Promise<string>} Redirect URL with auth code
 */
export async function launchAuthFlow(options) {
  if (isFirefox) {
    // Firefox 120+ supports browser.identity.launchWebAuthFlow
    if (typeof browser !== 'undefined' && browser.identity?.launchWebAuthFlow) {
      return browser.identity.launchWebAuthFlow(options);
    }
    // Fallback: open auth URL in a new tab, listen for redirect
    return new Promise((resolve, reject) => {
      chrome.tabs.create({ url: options.url, active: true }, (tab) => {
        const tabId = tab.id;

        function onUpdated(updatedTabId, changeInfo) {
          if (updatedTabId !== tabId || !changeInfo.url) return;
          const url = changeInfo.url;

          // Check if the URL is a redirect back to the extension
          if (url.includes('extensions.allizom.org') || url.includes('extensions.gnome.org') ||
              url.includes('chrome-extension://') || url.includes('moz-extension://')) {
            chrome.tabs.onUpdated.removeListener(onUpdated);
            chrome.tabs.remove(tabId).catch(() => {});
            resolve(url);
          }
        }

        function onRemoved(removedTabId) {
          if (removedTabId !== tabId) return;
          chrome.tabs.onRemoved.removeListener(onRemoved);
          chrome.tabs.onUpdated.removeListener(onUpdated);
          reject(new Error('Auth tab closed by user'));
        }

        chrome.tabs.onUpdated.addListener(onUpdated);
        chrome.tabs.onRemoved.addListener(onRemoved);
      });
    });
  }

  // Chrome: use native identity API
  return chrome.identity.launchWebAuthFlow(options);
}
