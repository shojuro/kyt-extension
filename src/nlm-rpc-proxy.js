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

let _proxyTabId = null;
let _polling = false;
let _pollTimer = null;

/**
 * Find an existing NLM tab or create one.
 */
async function ensureNlmTab() {
  // Check if our tracked tab is still alive
  if (_proxyTabId) {
    try {
      const tab = await chrome.tabs.get(_proxyTabId);
      if (tab && tab.url?.startsWith(NLM_URL)) return _proxyTabId;
    } catch {
      _proxyTabId = null;
    }
  }

  // Look for any existing NLM tab
  const tabs = await chrome.tabs.query({ url: `${NLM_URL}/*` });
  if (tabs.length > 0) {
    _proxyTabId = tabs[0].id;
    return _proxyTabId;
  }

  // Create a new background tab
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
    // Safety timeout
    setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, 15000);
  });

  // Give the content script a moment to initialize
  await new Promise(r => setTimeout(r, 1000));

  return _proxyTabId;
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
    const res = await fetch(`${BRIDGE_URL}/rpc/pending`, {
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
      const result = await proxyRpcToTab(request);

      // Deliver response back to the bridge
      await fetch(`${BRIDGE_URL}/rpc/${id}/response`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(result),
        signal: AbortSignal.timeout(5000),
      });
    } catch (proxyErr) {
      // Deliver error response
      await fetch(`${BRIDGE_URL}/rpc/${id}/response`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
 * Get proxy status for diagnostics.
 */
export function getRpcProxyStatus() {
  return {
    polling: _polling,
    proxyTabId: _proxyTabId,
  };
}
