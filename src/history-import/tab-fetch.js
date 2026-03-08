/**
 * Tab-proxied fetch for history import.
 *
 * Background service workers in MV3 have their own (empty) cookie jar —
 * they can't use `credentials: 'include'` to piggyback on the user's
 * claude.ai / chatgpt.com session.  This module finds an open tab on the
 * target domain and executes the fetch there (MAIN world), where the
 * page's session cookies are available.
 *
 * Returns a Response-like object with `.ok`, `.status`, `.json()`, `.text()`.
 */

/**
 * @param {string} domain  e.g. 'claude.ai', 'chatgpt.com'
 * @param {string} url     Full URL to fetch
 * @param {Object} [options]
 * @param {string} [options.method]
 * @param {Object} [options.headers]
 * @param {string} [options.body]
 * @param {number} [options.timeoutMs=30000]
 * @returns {Promise<{ok: boolean, status: number, statusText: string, json: () => any, text: () => string}>}
 */
export async function fetchFromTab(domain, url, options = {}) {
    // Find an open tab on the target domain
    const patterns = [`https://${domain}/*`];
    // ChatGPT also lives on chat.openai.com
    if (domain === 'chatgpt.com') patterns.push('https://chat.openai.com/*');

    const tabs = await chrome.tabs.query({ url: patterns });
    if (!tabs || tabs.length === 0) {
        throw new Error(
            `No ${domain} tab found. Please open ${domain} in your browser and try again.`
        );
    }

    const tabId = tabs[0].id;
    const timeoutMs = options.timeoutMs || 30000;

    const execPromise = chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: async (fetchUrl, fetchMethod, fetchHeaders, fetchBody) => {
            try {
                const resp = await fetch(fetchUrl, {
                    method: fetchMethod || 'GET',
                    headers: fetchHeaders || {},
                    body: fetchBody || undefined,
                    credentials: 'include',
                });
                const text = await resp.text();
                return {
                    ok: resp.ok,
                    status: resp.status,
                    statusText: resp.statusText,
                    body: text,
                };
            } catch (e) {
                return {
                    ok: false,
                    status: 0,
                    statusText: e.message,
                    body: e.message,
                    networkError: true,
                };
            }
        },
        args: [
            url,
            options.method || 'GET',
            options.headers || {},
            options.body || null,
        ],
    });

    // Race against timeout
    const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`Tab fetch timed out after ${timeoutMs}ms`)), timeoutMs)
    );

    const results = await Promise.race([execPromise, timeoutPromise]);

    if (!results?.[0]?.result) {
        throw new Error(`Script execution failed in ${domain} tab`);
    }

    const result = results[0].result;
    if (result.networkError) {
        throw new Error(`Network error in ${domain} tab: ${result.body}`);
    }

    // Return a Response-like object so fetchers need minimal changes
    const bodyText = result.body;
    return {
        ok: result.ok,
        status: result.status,
        statusText: result.statusText,
        json: () => JSON.parse(bodyText),
        text: () => bodyText,
    };
}
