/**
 * NotebookLM RPC Proxy — routes API calls through a browser tab.
 *
 * The browser attaches ALL cookies (including SID, HSID, SIDCC that are
 * invisible to the chrome.cookies API) to same-origin requests. This
 * eliminates the need for manual SID injection.
 *
 * Flow:
 *   Cookie bridge POST /rpc → this module polls /rpc/pending →
 *   sends to content script on NLM tab → content script makes fetch →
 *   response flows back → POST /rpc/{id}/response
 */

const BRIDGE_URL = 'http://127.0.0.1:19418';
const POLL_INTERVAL_MS = 1000;
const NLM_URL = 'https://notebooklm.google.com';

/** Get bridge auth token from chrome.storage.local. */
async function getBridgeToken() {
  try {
    const { kyt_bridge_token } = await chrome.storage.local.get('kyt_bridge_token');
    return kyt_bridge_token || null;
  } catch { return null; }
}

async function bridgeHeaders() {
  const token = await getBridgeToken();
  const headers = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return headers;
}

let _proxyTabId = null;
let _polling = false;
let _pollTimer = null;

/**
 * Find a usable NLM tab or create one.
 *
 * After extension reload, old tabs have dead content script ports.
 * We verify liveness by sending a ping before reusing.
 */
async function ensureNlmTab() {
  // Check if our tracked tab is still alive AND responsive
  if (_proxyTabId) {
    try {
      const tab = await chrome.tabs.get(_proxyTabId);
      if (tab && tab.url?.startsWith(NLM_URL)) {
        // Verify content script is responsive (not a stale reload survivor)
        const alive = await pingTab(_proxyTabId);
        if (alive) return _proxyTabId;
      }
    } catch { /* tab gone */ }
    _proxyTabId = null;
  }

  // Look for any existing NLM tab with a responsive content script
  const tabs = await chrome.tabs.query({ url: `${NLM_URL}/*` });
  for (const tab of tabs) {
    const alive = await pingTab(tab.id);
    if (alive) {
      _proxyTabId = tab.id;
      return _proxyTabId;
    }
  }

  // No responsive tab found — create a fresh one
  const tab = await chrome.tabs.create({ url: NLM_URL, active: false });
  _proxyTabId = tab.id;

  // Wait for the tab to finish loading
  await new Promise((resolve) => {
    const listener = (tabId, changeInfo) => {
      if (tabId === _proxyTabId && changeInfo.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, 15000);
  });

  // Give the content script a moment to initialize
  await new Promise(r => setTimeout(r, 2000));

  return _proxyTabId;
}

/**
 * Ping a tab's content script to verify it's responsive.
 * Returns false if the content script is dead (extension reload survivor).
 */
function pingTab(tabId) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(false), 2000);
    chrome.tabs.sendMessage(tabId, { type: 'GET_PAGE_STATS' }, (response) => {
      clearTimeout(timeout);
      if (chrome.runtime.lastError) {
        resolve(false);
      } else {
        resolve(true);
      }
    });
  });
}

/**
 * Handle fetch_url requests directly in the service worker.
 * Bypasses CORS restrictions that block content script fetches to CDN domains.
 * The service worker has host_permissions for *.google.com.
 */
async function handleFetchUrl(request) {
  const { url } = request;

  // Validate URL domain
  try {
    const parsed = new URL(url);
    const trusted = ['.google.com', '.googleusercontent.com', '.googleapis.com'];
    if (parsed.protocol !== 'https:' || !trusted.some(d => parsed.hostname === d.slice(1) || parsed.hostname.endsWith(d))) {
      return { success: false, error: `Untrusted domain: ${parsed.hostname}` };
    }
  } catch { return { success: false, error: 'Invalid URL' }; }

  // Download directly from the SW. Extension host_permissions bypass CORS,
  // and the SW's fetch sends browser cookies automatically for permitted domains.
  try {
    console.log('[KYT fetch_url] Downloading in SW (host_permissions bypass CORS)...');
    const res = await fetch(url, { credentials: 'include', redirect: 'follow' });
    console.log('[KYT fetch_url] HTTP', res.status, 'Content-Type:', res.headers.get('content-type'));

    if (!res.ok) {
      return { success: false, error: `HTTP ${res.status}` };
    }

    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('text/html')) {
      // Auth redirect to sign-in page — fall back to cookie export
      console.log('[KYT fetch_url] Got HTML (auth redirect), falling back to cookie export');
      const googleCookies = await chrome.cookies.getAll({ domain: '.google.com' });
      const cookieHeader = googleCookies.map(c => `${c.name}=${c.value}`).join('; ');
      return { success: true, cookieHeader, url };
    }

    // Binary download succeeded — return base64-encoded data
    const buffer = await res.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    const base64Data = btoa(binary);
    console.log('[KYT fetch_url] Downloaded', bytes.length, 'bytes');

    return { success: true, base64Data, contentType, size: bytes.length };
  } catch (err) {
    console.error('[KYT fetch_url] Error:', err);
    return { success: false, error: err.message };
  }
}

/**
 * Send an RPC request to the NLM tab's content script.
 */
async function proxyRpcToTab(request) {
  const tabId = await ensureNlmTab();
  if (!tabId) throw new Error('Could not create NLM tab');

  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, {
      type: 'KYT_RPC_PROXY',
      request,
    }, (response) => {
      if (chrome.runtime.lastError) {
        // Tab might have navigated away or content script not ready
        _proxyTabId = null;
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(response);
      }
    });
  });
}

/**
 * Poll the cookie bridge for pending RPC requests and proxy them.
 */
async function pollForRequests() {
  if (!_polling) return;

  try {
    const headers = await bridgeHeaders();
    const res = await fetch(`${BRIDGE_URL}/rpc/pending`, {
      headers,
      signal: AbortSignal.timeout(3000),
    });

    if (!res.ok) {
      schedulePoll();
      return;
    }

    const data = await res.json();
    if (!data.request) {
      schedulePoll();
      return;
    }

    // Got a pending request — proxy it through the NLM tab
    const { id, request } = data;
    console.log(`[KYT RPC Proxy] Processing request ${id}: ${request.methodId || request.type}`);

    try {
      // Handle fetch_url in service worker (bypasses CORS, has host_permissions)
      let result;
      if (request.type === 'fetch_url') {
        console.log('[KYT RPC Proxy] Handling fetch_url in SW (not content script)');
        result = await handleFetchUrl(request);
      } else {
        result = await proxyRpcToTab(request);
      }

      // Deliver response back to the bridge
      // Binary downloads (base64-encoded) can be 8+ MB — allow 60s for localhost transfer
      const respHeaders = await bridgeHeaders();
      respHeaders['Content-Type'] = 'application/json';
      await fetch(`${BRIDGE_URL}/rpc/${id}/response`, {
        method: 'POST',
        headers: respHeaders,
        body: JSON.stringify(result),
        signal: AbortSignal.timeout(result.base64Data ? 60000 : 5000),
      });
    } catch (proxyErr) {
      // Deliver error response
      const respHeaders = await bridgeHeaders();
      respHeaders['Content-Type'] = 'application/json';
      await fetch(`${BRIDGE_URL}/rpc/${id}/response`, {
        method: 'POST',
        headers: respHeaders,
        body: JSON.stringify({ success: false, error: proxyErr.message }),
        signal: AbortSignal.timeout(5000),
      }).catch(() => {});
    }
  } catch {
    // Bridge not reachable — that's fine, keep polling
  }

  schedulePoll();
}

function schedulePoll() {
  if (!_polling) return;
  _pollTimer = setTimeout(pollForRequests, POLL_INTERVAL_MS);
}

/**
 * Start the RPC proxy poller.
 */
export function startRpcProxy() {
  if (_polling) return;
  _polling = true;
  console.log('[KYT RPC Proxy] Started polling for requests');
  schedulePoll();
}

/**
 * Stop the RPC proxy poller.
 */
export function stopRpcProxy() {
  _polling = false;
  if (_pollTimer) {
    clearTimeout(_pollTimer);
    _pollTimer = null;
  }
}

/**
 * Check if the proxy is running.
 */
export function isRpcProxyRunning() {
  return _polling;
}

/**
 * Alarm watchdog handler — restarts polling if SW was terminated and restarted.
 * Called from background.js alarm listener.
 */
export function handleRpcPollAlarm() {
  if (!_polling) return; // proxy was intentionally stopped
  // If no active poll timer, the SW was terminated and restarted.
  // setTimeout timers don't survive SW termination, so restart polling.
  if (!_pollTimer) {
    console.log('[KYT RPC Proxy] Watchdog: restarting poll loop after SW restart');
    schedulePoll();
  }
}

/**
 * Get proxy status for diagnostics.
 */
// Debug: expose handleFetchUrl for console testing
export { handleFetchUrl as _testFetchUrl };

export function getRpcProxyStatus() {
  return {
    polling: _polling,
    proxyTabId: _proxyTabId,
    buildMeta: self._kytBuildMeta || null,
  };
}
