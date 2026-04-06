/**
 * Gemini Auth — extracts authentication tokens for background polling.
 *
 * Gemini uses Google's batchexecute protocol which requires:
 * 1. Google session cookies (SID, HSID, SAPISID, etc.) — from chrome.cookies
 * 2. XSRF token (SNlM0e / "at") — extracted from Gemini homepage HTML
 * 3. Build label ("bl") — from Gemini homepage or page scripts
 * 4. Session ID ("f.sid") — from Gemini homepage WIZ_global_data
 *
 * Tokens are cached with a 30-minute TTL and re-fetched from the homepage
 * when stale. Cookies are always fetched fresh from chrome.cookies (never cached).
 */

const GEMINI_URL = 'https://gemini.google.com';
const BATCHEXECUTE_URL = 'https://gemini.google.com/_/BardChatUi/data/batchexecute';
const TOKEN_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

let _tokenCache = null;
let _tokenCacheTime = 0;

/**
 * Get Google session cookies for gemini.google.com.
 * Always fetched fresh — never persisted to storage.
 *
 * @returns {Promise<string>} Cookie header string ("name=value; name=value; ...")
 * @throws If no cookies found (user not signed into Google)
 */
export async function getGeminiCookies() {
  const cookies = await chrome.cookies.getAll({ url: GEMINI_URL });
  if (!cookies || cookies.length === 0) {
    throw new Error('NO_GEMINI_COOKIES');
  }
  return cookies.map(c => `${c.name}=${c.value}`).join('; ');
}

/**
 * Extract XSRF token (at), build label (bl), and session ID (f.sid)
 * from the Gemini homepage HTML.
 *
 * @param {string} cookieStr - Cookie header for authenticated request
 * @returns {Promise<{at: string, bl: string, sid: string}>}
 */
async function extractTokensFromHomepage(cookieStr) {
  const res = await fetch(GEMINI_URL, {
    headers: {
      'Cookie': cookieStr,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
    },
  });

  if (!res.ok) {
    throw new Error(`GEMINI_HOMEPAGE_${res.status}`);
  }

  const html = await res.text();

  // Extract SNlM0e (XSRF/at token)
  const atMatch = html.match(/"SNlM0e":"([^"]+)"/);
  const at = atMatch?.[1];

  // Extract cfb2h (build label / bl)
  const blMatch = html.match(/"cfb2h":"([^"]+)"/);
  const bl = blMatch?.[1];

  // Extract FdrFJe (session ID / f.sid)
  const sidMatch = html.match(/"FdrFJe":"([^"]+)"/);
  const sid = sidMatch?.[1];

  if (!at) {
    throw new Error('GEMINI_NO_XSRF_TOKEN');
  }

  return { at, bl: bl || '', sid: sid || '' };
}

/**
 * Get full Gemini auth context for batchexecute calls.
 * Uses cached tokens if fresh (< 30 min), otherwise re-fetches from homepage.
 *
 * @param {boolean} [forceRefresh=false] - Force re-fetch even if cache is fresh
 * @returns {Promise<{cookieStr: string, at: string, bl: string, sid: string}>}
 */
export async function getGeminiAuth(forceRefresh = false) {
  const cookieStr = await getGeminiCookies();

  // Check token cache
  const now = Date.now();
  if (!forceRefresh && _tokenCache && (now - _tokenCacheTime) < TOKEN_CACHE_TTL_MS) {
    return { cookieStr, ..._tokenCache };
  }

  // Fetch fresh tokens from homepage
  const tokens = await extractTokensFromHomepage(cookieStr);
  _tokenCache = tokens;
  _tokenCacheTime = now;

  return { cookieStr, ...tokens };
}

/**
 * Clear token cache — called on auth failure to force re-fetch.
 */
export function clearGeminiAuthCache() {
  _tokenCache = null;
  _tokenCacheTime = 0;
}

// ─── batchexecute helpers ────────────────────────────────────────────

/**
 * Build a batchexecute request body.
 *
 * @param {string} rpcId - RPC method ID (e.g. "MaZiqc")
 * @param {any[]} params - Parameter array for the RPC
 * @param {string} at - XSRF token
 * @returns {string} URL-encoded form body
 */
export function buildBatchExecuteBody(rpcId, params, at) {
  const paramsJson = JSON.stringify(params);
  const fReq = JSON.stringify([[[rpcId, paramsJson, null, 'generic']]]);
  return `f.req=${encodeURIComponent(fReq)}&at=${encodeURIComponent(at)}&`;
}

/**
 * Build batchexecute query string.
 *
 * @param {string} rpcId - RPC method ID
 * @param {string} bl - Build label
 * @param {string} sid - Session ID (f.sid)
 * @returns {string} Query string (without leading ?)
 */
export function buildBatchExecuteQueryString(rpcId, bl, sid) {
  const params = new URLSearchParams({
    'rpcids': rpcId,
    'source-path': '/app',
    'bl': bl,
    'hl': 'en',
    'rt': 'c',
  });
  if (sid) params.set('f.sid', sid);
  params.set('_reqid', String(Math.floor(Math.random() * 9000000) + 1000000));
  return params.toString();
}

/**
 * Parse a batchexecute response.
 * Strips anti-XSSI prefix, extracts wrb.fr frames, double-decodes inner JSON.
 *
 * @param {string} responseText - Raw batchexecute response
 * @returns {any} Parsed inner data from the first wrb.fr frame, or null
 */
export function parseBatchExecuteResponse(responseText) {
  let text = responseText;

  // Strip anti-XSSI prefix
  if (text.startsWith(")]}'")) {
    text = text.slice(text.indexOf('\n') + 1);
  }

  // Parse length-prefixed chunks
  const chunks = [];
  const lines = text.split('\n');
  let i = 0;
  while (i < lines.length) {
    const lenLine = lines[i].trim();
    if (!lenLine || isNaN(parseInt(lenLine))) {
      i++;
      continue;
    }
    const len = parseInt(lenLine);
    i++;
    if (i < lines.length) {
      const data = lines[i];
      try {
        chunks.push(JSON.parse(data));
      } catch { /* not JSON */ }
    }
    i++;
  }

  // Find wrb.fr frame
  for (const chunk of chunks) {
    if (!Array.isArray(chunk)) continue;
    for (const item of chunk) {
      if (!Array.isArray(item) || item[0] !== 'wrb.fr') continue;
      const resultData = item[2];
      if (!resultData) continue;
      try {
        return typeof resultData === 'string' ? JSON.parse(resultData) : resultData;
      } catch { /* parse error */ }
    }
  }

  return null;
}

/**
 * Make an authenticated batchexecute call to Gemini.
 *
 * @param {string} rpcId - RPC method ID
 * @param {any[]} params - RPC parameters
 * @param {object} auth - Auth context from getGeminiAuth()
 * @returns {Promise<any>} Parsed response data
 */
export async function callBatchExecute(rpcId, params, auth) {
  const body = buildBatchExecuteBody(rpcId, params, auth.at);
  const qs = buildBatchExecuteQueryString(rpcId, auth.bl, auth.sid);

  const res = await fetch(`${BATCHEXECUTE_URL}?${qs}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
      'Cookie': auth.cookieStr,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
      'Origin': GEMINI_URL,
      'Referer': `${GEMINI_URL}/`,
      'x-same-domain': '1',
    },
    body,
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`GEMINI_RPC_${res.status}: ${errText.substring(0, 200)}`);
  }

  const responseText = await res.text();
  const parsed = parseBatchExecuteResponse(responseText);

  if (!parsed) {
    throw new Error('GEMINI_RPC_EMPTY_RESPONSE');
  }

  return parsed;
}

// ─── Conversation list API ───────────────────────────────────────────

const CONV_LIST_RPC_ID = 'MaZiqc';
const CONV_LIST_PAGE_SIZE = 20;

/**
 * Fetch a page of conversations from Gemini.
 *
 * @param {object} auth - Auth context from getGeminiAuth()
 * @param {string|null} cursor - Pagination cursor (null for first page)
 * @returns {Promise<{conversations: Array, nextCursor: string|null}>}
 */
export async function fetchConversationPage(auth, cursor = null) {
  const params = [CONV_LIST_PAGE_SIZE, cursor, [0, null, 1]];
  const data = await callBatchExecute(CONV_LIST_RPC_ID, params, auth);

  // Response: [null, next_cursor, [[entries...]]]
  const nextCursor = data?.[1] || null;
  const entries = data?.[2] || [];

  const conversations = entries.map(entry => {
    if (!Array.isArray(entry)) return null;
    const id = entry[0];
    const title = (entry[1] || '').replace(/\n$/, '').trim();
    const timestamp = Array.isArray(entry[5])
      ? entry[5][0] * 1000 + Math.floor((entry[5][1] || 0) / 1_000_000) // sec + ms from nanosec
      : 0;
    return { id, title, timestamp };
  }).filter(Boolean);

  return { conversations, nextCursor };
}

/**
 * Fetch all conversations since a cutoff timestamp, paginating as needed.
 *
 * @param {object} auth - Auth context from getGeminiAuth()
 * @param {number} cutoffMs - Only return conversations updated after this time (ms)
 * @param {number} [maxPages=20] - Safety limit on pagination
 * @returns {Promise<Array<{id: string, title: string, timestamp: number}>>}
 */
export async function fetchConversationsSince(auth, cutoffMs, maxPages = 20) {
  const allConversations = [];
  let cursor = null;
  let page = 0;

  while (page < maxPages) {
    const { conversations, nextCursor } = await fetchConversationPage(auth, cursor);

    if (conversations.length === 0) break;

    // Add conversations that are after the cutoff
    let reachedCutoff = false;
    for (const conv of conversations) {
      if (conv.timestamp >= cutoffMs) {
        allConversations.push(conv);
      } else {
        reachedCutoff = true;
        break;
      }
    }

    if (reachedCutoff || !nextCursor) break;

    cursor = nextCursor;
    page++;

    // Rate limit: 2s between pages (Google is strict)
    await new Promise(r => setTimeout(r, 2000));
  }

  console.log(`📋 Gemini: fetched ${allConversations.length} conversations across ${page + 1} pages`);
  return allConversations;
}

export { GEMINI_URL, BATCHEXECUTE_URL, CONV_LIST_RPC_ID };
