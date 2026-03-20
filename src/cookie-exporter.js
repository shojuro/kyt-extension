/**
 * Cookie Exporter — bridges Chrome extension cookies to the MCP server.
 *
 * Two transport modes (tried in order):
 * 1. HTTP bridge (localhost:19418) — works everywhere including WSL
 * 2. Native messaging — works on same-OS setups
 *
 * chrome.cookies.getAll() gets HttpOnly cookies (document.cookie can't).
 * This gives us all the auth cookies Google sets, including the critical
 * __Secure-* ones that expire every few hours.
 */

const COOKIE_BRIDGE_PORT = 19418;
const COOKIE_BRIDGE_URLS = [
  `http://127.0.0.1:${COOKIE_BRIDGE_PORT}`,   // native or WSL2 localhost proxy
  `http://localhost:${COOKIE_BRIDGE_PORT}`,     // fallback hostname
];
const NATIVE_HOST_NAME = 'com.kyt.cookie_host';

// Google auth cookie names needed for NotebookLM API calls
const REQUIRED_COOKIE_NAMES = new Set([
  'SID', 'HSID', 'SSID', 'APISID', 'SAPISID',
  'SIDCC', 'OSID',
  '__Secure-1PSID', '__Secure-3PSID',
  '__Secure-1PAPISID', '__Secure-3PAPISID',
  '__Secure-1PSIDTS', '__Secure-3PSIDTS',
  '__Secure-1PSIDRTS', '__Secure-3PSIDRTS',
  '__Secure-1PSIDCC', '__Secure-3PSIDCC',
  '__Secure-OSID', '__Secure-BUCKET',
  'NID', 'AEC', 'SEARCH_SAMESITE',
]);

// Track state
let _consecutiveFailures = 0;
let _lastExportTime = null;
let _transport = null; // null = unknown, 'http' | 'native' | false

/**
 * Export Google auth cookies to the MCP cookie bridge.
 * Tries HTTP first (works cross-OS/WSL), falls back to native messaging.
 *
 * @returns {Promise<{ success: boolean, cookieCount?: number, error?: string, transport?: string }>}
 */
export async function exportNotebookLMCookies() {
  // If both transports confirmed unavailable, skip (recheck every 10 calls)
  if (_transport === false && _consecutiveFailures % 10 !== 0) {
    _consecutiveFailures++;
    return { success: false, error: 'no_transport_available' };
  }

  try {
    // Get Google auth cookies from multiple queries to catch all domains
    // SID/HSID/SIDCC are HttpOnly on .google.com
    // SAPISID/SSID are on .google.com
    // OSID/__Secure-OSID are on notebooklm.google.com
    const [byUrl, byDomain, byApex, nlmCookies] = await Promise.all([
      chrome.cookies.getAll({ url: 'https://www.google.com' }),
      chrome.cookies.getAll({ domain: '.google.com' }),
      chrome.cookies.getAll({ domain: 'google.com' }),
      chrome.cookies.getAll({ url: 'https://notebooklm.google.com' }),
    ]);
    // Debug: log what each query returns (remove after confirmed working)
    const counts = {
      byUrl: byUrl.length,
      byDomain: byDomain.length,
      byApex: byApex.length,
      nlm: nlmCookies.length,
      byUrlNames: byUrl.map(c => c.name).join(','),
      byDomainNames: byDomain.map(c => c.name).join(','),
      byApexNames: byApex.map(c => c.name).join(','),
    };
    console.log('[KYT] Cookie query debug:', JSON.stringify(counts));
    const mainCookies = [...byUrl, ...byDomain, ...byApex];

    // Merge and deduplicate (prefer notebooklm-specific cookies)
    const byName = new Map();
    for (const c of mainCookies) {
      if (REQUIRED_COOKIE_NAMES.has(c.name)) byName.set(c.name, c);
    }
    for (const c of nlmCookies) {
      if (REQUIRED_COOKIE_NAMES.has(c.name)) byName.set(c.name, c);
    }
    const authCookies = [...byName.values()];

    if (authCookies.length === 0) {
      console.warn('[KYT] No Google auth cookies found — user may not be signed in');
      return { success: false, error: 'no_google_cookies' };
    }

    const cookiePayload = authCookies.map(c => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
    }));

    // Try HTTP bridge first (or skip if we know it's unavailable)
    if (_transport !== 'native') {
      const httpResult = await tryHttpBridge(cookiePayload);
      if (httpResult.success) {
        _transport = 'http';
        _consecutiveFailures = 0;
        _lastExportTime = Date.now();
        return { ...httpResult, transport: 'http' };
      }
    }

    // Fall back to native messaging
    if (_transport !== 'http') {
      const nativeResult = await tryNativeMessaging(cookiePayload);
      if (nativeResult.success) {
        _transport = 'native';
        _consecutiveFailures = 0;
        _lastExportTime = Date.now();
        return { ...nativeResult, transport: 'native' };
      }
    }

    // Both failed
    _consecutiveFailures++;
    if (_consecutiveFailures === 1) {
      console.warn('[KYT] Cookie export: no transport available. Start cookie bridge server or install native host.');
    }
    _transport = false;
    return { success: false, error: 'no_transport_available' };
  } catch (err) {
    _consecutiveFailures++;
    return { success: false, error: err.message };
  }
}

/**
 * Try the HTTP bridge — attempts multiple URLs for cross-OS compatibility.
 */
async function tryHttpBridge(cookies) {
  for (const baseUrl of COOKIE_BRIDGE_URLS) {
    try {
      const res = await fetch(`${baseUrl}/cookies`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cookies }),
        signal: AbortSignal.timeout(3000),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        return { success: false, error: `HTTP ${res.status}: ${body}` };
      }

      const data = await res.json();
      if (data.success) {
        console.log(`[KYT] Cookies exported via HTTP bridge (${baseUrl}): ${data.cookieCount} cookies`);
      }
      return data;
    } catch {
      continue; // try next URL
    }
  }
  return { success: false, error: 'http_bridge_unreachable' };
}

/**
 * Try native messaging (com.kyt.cookie_host).
 */
async function tryNativeMessaging(cookies) {
  try {
    const response = await chrome.runtime.sendNativeMessage(NATIVE_HOST_NAME, {
      action: 'export_cookies',
      cookies,
    });

    if (response?.success) {
      console.log(`[KYT] Cookies exported via native messaging: ${response.cookieCount} cookies`);
    }
    return response || { success: false, error: 'empty_response' };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Get the status of the cookie exporter.
 */
export function getCookieExportStatus() {
  return {
    transport: _transport,
    consecutiveFailures: _consecutiveFailures,
    lastExportTime: _lastExportTime,
    lastExportAge: _lastExportTime ? Math.round((Date.now() - _lastExportTime) / 1000) + 's' : null,
  };
}

/**
 * Reset the failure counter and transport detection.
 */
export function resetCookieExporter() {
  _consecutiveFailures = 0;
  _transport = null;
}
