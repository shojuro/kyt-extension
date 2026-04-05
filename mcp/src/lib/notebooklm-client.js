/**
 * NotebookLM API client.
 *
 * Async wrapper over the batchexecute RPC layer + auth.
 * Methods: listNotebooks, createNotebook, addTextSource, askQuestion, deleteNotebook.
 *
 * All methods auto-retry once on 401/403 with fresh auth tokens.
 *
 * Security: Passphrase is held in memory only for the duration of the MCP server
 * process. It is never persisted to disk.
 */

import { createHash } from 'node:crypto';
import { getAuth, clearAuthCache, getEffectivePassphrase } from './notebooklm-auth.js';
import {
  RPC,
  BATCHEXECUTE_URL,
  STREAMING_URL,
  encodeRpcRequest,
  buildRequestBody,
  buildQueryString,
  decodeResponse,
  decodeStreamingResponse,
} from './notebooklm-rpc.js';
import {
  ARTIFACT_TYPE,
  ARTIFACT_TYPE_LABEL,
  ARTIFACT_STATUS_LABEL,
  AUDIO_FORMAT,
  AUDIO_LENGTH,
  VIDEO_FORMAT,
  VIDEO_STYLE,
  QUIZ_VARIANT,
  QUIZ_QUANTITY,
  QUIZ_DIFFICULTY,
  INFOGRAPHIC_ORIENTATION,
  INFOGRAPHIC_DETAIL,
  INFOGRAPHIC_STYLE,
  SLIDE_DECK_FORMAT,
  SLIDE_DECK_LENGTH,
} from './notebooklm-constants.js';

const ORIGIN = 'https://notebooklm.google.com';
const RPC_PROXY_URL = 'http://127.0.0.1:19418';

// Proxy state: null = untested, true = available, false = unavailable
let _proxyAvailable = null;

// ── Source ID cache ─────────────────────────────────────────
// Prevents cascading failures when listSources RPC is flaky.
// Populated on successful listSources(), consumed by askQuestion() and tool handlers.
const _sourceCache = new Map(); // Map<notebookId, { sources: Array, fetchedAt: number }>
const SOURCE_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Bridge auth token — read from ~/.kyt/bridge-token (same file the server writes)
import { readFileSync as _readFileSync, existsSync as _existsSync } from 'fs';
import { join as _join } from 'path';
import { homedir as _homedir } from 'os';
import { spawn as _spawn } from 'child_process';
import { dirname as _dirname } from 'path';
import { fileURLToPath as _fileURLToPath } from 'url';

function getBridgeToken() {
  const tokenPath = _join(_homedir(), '.kyt', 'bridge-token');
  if (_existsSync(tokenPath)) return _readFileSync(tokenPath, 'utf8').trim();
  return null;
}

function bridgeHeaders() {
  const token = getBridgeToken();
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return headers;
}

// --- Auto-start bridge ---

let _bridgeStartAttempted = false;
let _proxyLastCheck = 0;
const PROXY_RECHECK_MS = 10_000;

/**
 * Ensure the cookie bridge server is running.
 * Checks health endpoint; if not reachable, spawns as a detached process.
 * Called once per MCP server lifetime (first NLM tool call).
 */
async function ensureBridgeRunning() {
  if (_bridgeStartAttempted) return;
  _bridgeStartAttempted = true;

  // Check if already running
  try {
    const res = await fetch(`${RPC_PROXY_URL}/health`, { signal: AbortSignal.timeout(2000) });
    if (res.ok) {
      const body = await res.json();
      if (body.service === 'kyt-cookie-bridge') return; // Verified it's ours
    }
  } catch { /* not running */ }

  // Spawn bridge as detached process
  const __dirname = _dirname(_fileURLToPath(import.meta.url));
  const bridgePath = _join(__dirname, '..', 'native-host', 'kyt-cookie-server.js');

  if (!_existsSync(bridgePath)) {
    process.stderr.write('[kyt] Cookie bridge not found at ' + bridgePath + '\n');
    return;
  }

  try {
    const child = _spawn('node', [bridgePath], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    process.stderr.write('[kyt] Cookie bridge auto-started on port 19418\n');
  } catch (e) {
    process.stderr.write('[kyt] Failed to start cookie bridge: ' + e.message + '\n');
    return;
  }

  // Wait for bridge to be ready (up to 3s)
  for (let i = 0; i < 6; i++) {
    await new Promise(r => setTimeout(r, 500));
    try {
      const res = await fetch(`${RPC_PROXY_URL}/health`, { signal: AbortSignal.timeout(1000) });
      if (res.ok) return;
    } catch { /* not ready yet */ }
  }
  process.stderr.write('[kyt] Cookie bridge started but health check timed out\n');
}

/**
 * Generate Google SAPISIDHASH authorization header.
 * Required for batchexecute API calls.
 * Formula: SAPISIDHASH timestamp_SHA1(timestamp + " " + SAPISID + " " + origin)
 *
 * @param {string} cookieHeader - Full cookie header string
 * @returns {string|null} Authorization header value, or null if SAPISID not found
 */
function generateSapisidHash(cookieHeader) {
  const match = cookieHeader.match(/(?:^|;\s*)SAPISID=([^;]+)/);
  if (!match) return null;
  const sapisid = match[1];
  const timestamp = Math.floor(Date.now() / 1000);
  const input = `${timestamp} ${sapisid} ${ORIGIN}`;
  const hash = createHash('sha1').update(input).digest('hex');
  return `SAPISIDHASH ${timestamp}_${hash}`;
}

const SOURCE_UPLOAD_DELAY_MS = 2000;
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 1000;

// --- Passphrase management ---
// Priority chain: explicit setPassphrase() > auto-key file > NOTEBOOKLM_PASSPHRASE env var

let _passphrase = null;

/**
 * Set an explicit passphrase for this session (overrides auto-key and env var).
 * Held in memory only — never persisted.
 *
 * @param {string} passphrase
 */
export function setPassphrase(passphrase) {
  _passphrase = passphrase;
}

/**
 * Check if any passphrase source is available (explicit, auto-key, or env var).
 */
export function hasPassphrase() {
  return getEffectivePassphrase(_passphrase) !== null;
}

/**
 * Clear the in-memory explicit passphrase.
 */
export function clearPassphrase() {
  _passphrase = null;
}

function requirePassphrase() {
  const effective = getEffectivePassphrase(_passphrase);
  if (!effective) {
    throw new Error(
      'NotebookLM auth not available. Import cookies first (auto-key will be generated), ' +
      'or pass the `passphrase` parameter explicitly.'
    );
  }
  return effective;
}

/**
 * Try to make an RPC call via the browser proxy (content script on NLM tab).
 * The browser attaches ALL cookies (including SID) to same-origin requests.
 *
 * @returns {Promise<string|null>} Raw response text, or null if proxy unavailable
 */
async function tryProxyRpc(methodId, params, opts = {}) {
  // Periodic recheck: if proxy was unavailable, retry after 60s
  if (_proxyAvailable === false && Date.now() - _proxyLastCheck > PROXY_RECHECK_MS) {
    _proxyAvailable = null;
  }
  if (_proxyAvailable === false) return null;
  _proxyLastCheck = Date.now();

  // Auto-start bridge if needed (first call only)
  await ensureBridgeRunning();

  try {
    const encoded = encodeRpcRequest(methodId, params);
    const proxyRes = await fetch(`${RPC_PROXY_URL}/rpc`, {
      method: 'POST',
      headers: bridgeHeaders(),
      body: JSON.stringify({
        type: 'batchexecute',
        methodId,
        encodedRpc: encoded,
        sourcePath: opts.sourcePath || null,
      }),
      signal: AbortSignal.timeout(35000), // 30s proxy timeout + 5s buffer
    });

    if (!proxyRes.ok) {
      _proxyAvailable = false;
      return null;
    }

    const result = await proxyRes.json();
    if (result.success && result.responseText) {
      _proxyAvailable = true;
      return result.responseText;
    }

    // Proxy returned error (e.g., no tab, no tokens)
    if (result.error) {
      process.stderr.write(`RPC proxy error: ${result.error}\n`);
    }
    return null;
  } catch {
    // Proxy not reachable — fall back to direct
    _proxyAvailable = false;
    return null;
  }
}

/**
 * Make an authenticated batchexecute RPC call.
 * Tries proxy first (full browser cookies), falls back to direct (extracted cookies).
 *
 * @param {string} methodId
 * @param {any[]} params
 * @param {object} [opts]
 * @param {string} [opts.sourcePath] - Source-path query param
 * @param {boolean} [opts._isRetry] - Internal: prevent infinite retry loop
 * @returns {Promise<any>} Decoded result
 */
async function rpcCall(methodId, params, opts = {}) {
  // Try proxy first — gets full cookie jar including SID
  const proxyResponse = await tryProxyRpc(methodId, params, opts);
  if (proxyResponse) {
    try {
      return decodeResponse(proxyResponse, methodId);
    } catch (decodeErr) {
      throw new Error(`NotebookLM RPC ${methodId} (proxy) decode failed: ${decodeErr.message}`);
    }
  }

  // Fall back to direct call with extracted cookies
  const passphrase = requirePassphrase();
  const auth = await getAuth(passphrase);
  const encoded = encodeRpcRequest(methodId, params);
  const body = buildRequestBody(encoded, auth.csrfToken);
  const qs = buildQueryString(methodId, auth.sessionId, opts.sourcePath);

  const headers = {
    'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
    'Cookie': auth.cookieHeader,
    'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Origin': ORIGIN,
    'Referer': `${ORIGIN}/`,
  };
  const sapisidHash = generateSapisidHash(auth.cookieHeader);
  if (sapisidHash) headers['Authorization'] = sapisidHash;

  const res = await fetch(`${BATCHEXECUTE_URL}?${qs}`, {
    method: 'POST',
    headers,
    body,
  });

  // Handle auth expiry — retry once with fresh cookies/tokens
  if ((res.status === 401 || res.status === 403) && !opts._isRetry) {
    clearAuthCache();
    return rpcCall(methodId, params, { ...opts, _isRetry: true });
  }

  // Handle rate limiting
  if (res.status === 429) {
    const retryAfter = parseInt(res.headers.get('retry-after') || '30', 10);
    throw new Error(`NotebookLM rate limited. Retry after ${retryAfter}s.`);
  }

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`NotebookLM RPC ${methodId} returned ${res.status}: ${errBody.substring(0, 200)}`);
  }

  const text = await res.text();
  try {
    return decodeResponse(text, methodId);
  } catch (decodeErr) {
    throw new Error(`NotebookLM RPC ${methodId} decode failed: ${decodeErr.message}. Response length: ${text.length}, starts: ${text.substring(0, 100)}`);
  }
}

/**
 * Sleep helper with exponential backoff.
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================================================
// Public API
// ============================================================================

/**
 * List all notebooks in the user's account.
 *
 * @returns {Promise<{ id: string, title: string, sourceCount: number }[]>}
 */
export async function listNotebooks() {
  const result = await rpcCall(RPC.LIST_NOTEBOOKS, [null, 1, null, [2]]);

  if (!result || !Array.isArray(result)) return [];

  // Result structure: result = [ [ notebook1, notebook2, ... ] ]
  // Unwrap: notebooks are at result[0] when single-wrapped
  // Each notebook: [title, sources[], id, emoji, null, metadata, ...]
  let entries = result;
  if (entries.length === 1 && Array.isArray(entries[0]) && Array.isArray(entries[0][0])) {
    entries = entries[0]; // unwrap [[nb1, nb2, ...]] → [nb1, nb2, ...]
  }

  const notebooks = [];
  for (const entry of entries) {
    if (!Array.isArray(entry)) continue;
    const title = typeof entry[0] === 'string' ? entry[0] : 'Untitled';
    const sources = Array.isArray(entry[1]) ? entry[1] : [];
    const id = typeof entry[2] === 'string' ? entry[2] : null;
    if (id) {
      notebooks.push({ id, title, sourceCount: sources.length });
    }
  }

  return notebooks;
}

/**
 * Create a new notebook.
 *
 * @param {string} title
 * @returns {Promise<{ id: string, title: string }>}
 */
export async function createNotebook(title) {
  const result = await rpcCall(RPC.CREATE_NOTEBOOK, [title, null, null, [2], [1]]);

  if (!result) {
    throw new Error('createNotebook returned null — may be rate limited');
  }

  // Result structure: [title, null, notebookId, ...]
  let id;
  if (Array.isArray(result) && typeof result[2] === 'string') {
    id = result[2]; // UUID at position 2
  } else if (typeof result === 'string') {
    id = result;
  }

  if (!id) {
    throw new Error(`Could not extract notebook ID from createNotebook response: ${JSON.stringify(result).substring(0, 200)}`);
  }

  return { id, title };
}

/**
 * Add a text source to a notebook.
 *
 * @param {string} notebookId
 * @param {string} title - Source title
 * @param {string} content - Source text content
 * @returns {Promise<{ sourceId: string }>}
 */
export async function addTextSource(notebookId, title, content) {
  const params = [
    [[null, [title, content], null, null, null, null, null, null]],
    notebookId,
    [2],
    null,
    null,
  ];

  const result = await rpcCall(RPC.ADD_SOURCE, params, {
    sourcePath: `/notebook/${notebookId}`,
  });

  let sourceId = null;
  if (result) {
    if (Array.isArray(result)) {
      const walk = (obj, depth) => {
        if (depth > 5) return null;
        if (typeof obj === 'string' && obj.length > 5 && !obj.includes(' ')) return obj;
        if (Array.isArray(obj)) {
          for (const item of obj) {
            const found = walk(item, depth + 1);
            if (found) return found;
          }
        }
        return null;
      };
      sourceId = walk(result, 0);
    } else if (typeof result === 'string') {
      sourceId = result;
    }
  }

  // Invalidate source cache — source list has changed
  invalidateSourceCache(notebookId);

  return { sourceId };
}

/**
 * Add multiple text sources with delay between uploads.
 *
 * @param {string} notebookId
 * @param {{ title: string, content: string }[]} sources
 * @param {(i: number, total: number) => void} [onProgress]
 * @returns {Promise<string[]>} Array of source IDs
 */
export async function addTextSources(notebookId, sources, onProgress) {
  const sourceIds = [];

  for (let i = 0; i < sources.length; i++) {
    let lastError;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const { sourceId } = await addTextSource(notebookId, sources[i].title, sources[i].content);
        sourceIds.push(sourceId);
        if (onProgress) onProgress(i + 1, sources.length);
        break;
      } catch (err) {
        lastError = err;
        if (err.message.includes('rate limit')) {
          await sleep(RETRY_BASE_MS * Math.pow(2, attempt));
        } else {
          throw err;
        }
      }
    }
    if (sourceIds.length <= i) {
      throw lastError || new Error(`Failed to upload source ${i + 1}`);
    }

    if (i < sources.length - 1) {
      await sleep(SOURCE_UPLOAD_DELAY_MS);
    }
  }

  return sourceIds;
}

/**
 * Ask a question to a notebook.
 *
 * @param {string} notebookId
 * @param {string} question
 * @returns {Promise<{ answer: string, citations: { source_id: string, cited_text: string, start_char: number|null, end_char: number|null }[] }>}
 */
export async function askQuestion(notebookId, question) {
  // NotebookLM API requires explicit source IDs — empty [] causes error code [16].
  // Use cached source IDs if available, fall back to live fetch
  let sourceIds = [];
  const cached = getCachedSourceIds(notebookId);
  if (cached && !cached.stale) {
    sourceIds = cached.ids.map(id => [[id]]);
  } else {
    try {
      const sources = await listSources(notebookId);
      sourceIds = sources.map(s => [[s.id]]);
    } catch (e) {
      // listSources failed — try stale cache as last resort
      if (cached) {
        sourceIds = cached.ids.map(id => [[id]]);
        process.stderr.write(`[askQuestion] listSources failed, using stale cache (${cached.ids.length} sources)\n`);
      } else {
        process.stderr.write(`[askQuestion] Warning: could not fetch sources: ${e.message}\n`);
      }
    }
  }

  // Generate a conversation ID for new conversations (required by API)
  const conversationId = crypto.randomUUID();

  const params = [
    sourceIds,        // sources — explicit [["sourceId"]] for each source
    question,
    [],               // conversation history (empty for new conversation, not null)
    [2, null, [1], [1]],
    conversationId,   // conversation ID (required, not null)
    null,
    null,
    notebookId,
    1,
  ];

  const paramsJson = JSON.stringify(params);
  const fReq = JSON.stringify([null, paramsJson]);

  // Try proxy first — browser has full cookie jar
  // Reset stale proxy unavailability
  if (_proxyAvailable === false && Date.now() - _proxyLastCheck > PROXY_RECHECK_MS) {
    _proxyAvailable = null;
  }
  if (_proxyAvailable !== false) {
    _proxyLastCheck = Date.now();
    await ensureBridgeRunning();
    try {
      const proxyRes = await fetch(`${RPC_PROXY_URL}/rpc`, {
        method: 'POST',
        headers: bridgeHeaders(),
        body: JSON.stringify({
          type: 'streaming',
          streamBody: fReq,
        }),
        signal: AbortSignal.timeout(95000), // 90s bridge timeout + 5s buffer
      });

      if (proxyRes.ok) {
        const result = await proxyRes.json();
        process.stderr.write(`[askQuestion] proxy response: success=${result.success} len=${result.responseText?.length} status=${result.status}\n`);
        if (result.success && result.responseText) {
          if (result.responseText.length < 500) {
            process.stderr.write(`[askQuestion] proxy full response: ${result.responseText}\n`);
          } else {
            process.stderr.write(`[askQuestion] proxy preview: ${result.responseText.substring(0, 500)}\n`);
          }
          _proxyAvailable = true;
          const decoded = decodeStreamingResponse(result.responseText);
          if (!decoded.answer) {
            process.stderr.write(`[askQuestion] proxy decode EMPTY. Response (first 2000): ${result.responseText.substring(0, 2000)}\n`);
          } else {
            process.stderr.write(`[askQuestion] proxy decode OK: answer=${decoded.answer.length} chars, citations=${decoded.citations.length}, convId=${decoded.conversationId}\n`);
          }
          return decoded;
        }
        // Proxy returned error — don't poison _proxyAvailable, just fall through
        if (result.error) {
          process.stderr.write(`RPC proxy streaming error: ${result.error}\n`);
        }
      }
    } catch {
      _proxyAvailable = false;
    }
  }

  // Fall back to direct with extracted cookies
  const passphrase = requirePassphrase();
  const auth = await getAuth(passphrase);

  const body = `f.req=${encodeURIComponent(fReq)}&at=${encodeURIComponent(auth.csrfToken)}&`;

  const qs = new URLSearchParams({
    'bl': 'boq_labs-tailwind-frontend_20260329.03_p0',
    'f.sid': auth.sessionId,
    'hl': 'en',
    '_reqid': String(Math.floor(Math.random() * 9000000) + 1000000),
    'rt': 'c',
  }).toString();

  const streamHeaders = {
    'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
    'Cookie': auth.cookieHeader,
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
    'Origin': ORIGIN,
    'Referer': `${ORIGIN}/notebook/${notebookId}`,
    'x-same-domain': '1',
  };
  const streamSapisid = generateSapisidHash(auth.cookieHeader);
  if (streamSapisid) streamHeaders['Authorization'] = streamSapisid;

  const res = await fetch(`${STREAMING_URL}?${qs}`, {
    method: 'POST',
    headers: streamHeaders,
    body,
  });

  if ((res.status === 401 || res.status === 403) && !askQuestion._retried) {
    askQuestion._retried = true;
    clearAuthCache();
    const result = await askQuestion(notebookId, question);
    askQuestion._retried = false;
    return result;
  }
  askQuestion._retried = false;

  if (!res.ok) {
    throw new Error(`NotebookLM query returned ${res.status}`);
  }

  const responseText = await res.text();
  // DEBUG: log raw response to diagnose empty answer issue
  const preview = responseText.substring(0, 500);
  console.error(`[askQuestion DEBUG] status=${res.status} len=${responseText.length} preview=${preview}`);
  const result = decodeStreamingResponse(responseText);
  if (!result.answer) {
    console.error(`[askQuestion DEBUG] Empty answer. Full response (first 2000 chars): ${responseText.substring(0, 2000)}`);
  }
  return result;
}

/**
 * Delete a notebook.
 *
 * @param {string} notebookId
 * @returns {Promise<void>}
 */
export async function deleteNotebook(notebookId) {
  await rpcCall(RPC.DELETE_NOTEBOOK, [[notebookId], [2]]);
}

// ============================================================================
// Sources
// ============================================================================

/**
 * Add a source to a notebook (polymorphic: text, url, youtube, gdrive).
 *
 * @param {string} notebookId
 * @param {{ type: 'text'|'url'|'youtube'|'gdrive', title?: string, content?: string, url?: string, fileId?: string, mimeType?: string }} source
 * @returns {Promise<{ sourceId: string|null }>}
 */
export async function addSource(notebookId, source) {
  let innerSource;

  switch (source.type) {
    case 'text':
      innerSource = [null, [source.title || 'Untitled', source.content || ''], null, null, null, null, null, null];
      break;
    case 'url':
      innerSource = [null, null, [source.url], null, null, null, null, null, null, null];
      break;
    case 'youtube':
      innerSource = [null, null, null, null, null, null, null, [source.url], null, null, 1];
      break;
    case 'gdrive':
      innerSource = [[source.fileId, source.mimeType || 'application/pdf', 1, source.title || ''], null, null, null, null, null, null, null, null, null, 1];
      break;
    default:
      throw new Error(`Unknown source type: ${source.type}`);
  }

  const params = [[innerSource], notebookId, [2], null, null];
  const result = await rpcCall(RPC.ADD_SOURCE, params, {
    sourcePath: `/notebook/${notebookId}`,
  });

  let sourceId = null;
  if (result) {
    const walk = (obj, depth) => {
      if (depth > 5) return null;
      if (typeof obj === 'string' && obj.length > 5 && !obj.includes(' ')) return obj;
      if (Array.isArray(obj)) {
        for (const item of obj) {
          const found = walk(item, depth + 1);
          if (found) return found;
        }
      }
      return null;
    };
    sourceId = walk(result, 0);
  }

  // Invalidate source cache — source list has changed
  invalidateSourceCache(notebookId);

  return { sourceId };
}

/**
 * List sources in a notebook.
 *
 * @param {string} notebookId
 * @returns {Promise<{ id: string, title: string, type: string, status: string|null, url: string|null }[]>}
 */
export async function listSources(notebookId) {
  const result = await rpcCall(RPC.GET_NOTEBOOK, [notebookId, null, [2], null, 0], {
    sourcePath: `/notebook/${notebookId}`,
  });

  if (!result || !Array.isArray(result)) {
    // RPC returned empty — use cache if available (stale > wrong-empty)
    const cached = _sourceCache.get(notebookId);
    if (cached && cached.sources.length > 0) {
      process.stderr.write(`[listSources] RPC returned empty, using cached ${cached.sources.length} sources\n`);
      return cached.sources;
    }
    return [];
  }

  // Sources are at result[0][1] — array of source entries
  const rawSources = result?.[0]?.[1];
  if (!Array.isArray(rawSources)) {
    const cached = _sourceCache.get(notebookId);
    if (cached && cached.sources.length > 0) {
      process.stderr.write(`[listSources] No sources in result structure, using cached ${cached.sources.length} sources\n`);
      return cached.sources;
    }
    return [];
  }

  const sources = [];
  for (const src of rawSources) {
    if (!Array.isArray(src)) continue;
    let id = null;
    if (Array.isArray(src[0]) && typeof src[0][0] === 'string') {
      id = src[0][0];
    } else if (typeof src[0] === 'string') {
      id = src[0];
    }
    const title = typeof src[1] === 'string' ? src[1] : 'Untitled';
    if (id) {
      sources.push({
        id,
        title,
        type: detectSourceType(src),
        status: null,
        url: extractSourceUrl(src),
      });
    }
  }

  // Cache on success
  if (sources.length > 0) {
    _sourceCache.set(notebookId, { sources, fetchedAt: Date.now() });
  }

  return sources;
}

/**
 * Get cached source IDs for a notebook (no RPC call).
 * Returns null if cache is empty or expired.
 *
 * @param {string} notebookId
 * @returns {{ ids: string[], stale: boolean } | null}
 */
export function getCachedSourceIds(notebookId) {
  const cached = _sourceCache.get(notebookId);
  if (!cached || cached.sources.length === 0) return null;
  const stale = Date.now() - cached.fetchedAt > SOURCE_CACHE_TTL_MS;
  return { ids: cached.sources.map(s => s.id), stale };
}

/**
 * Invalidate the source cache for a notebook.
 * Call after adding/removing sources.
 *
 * @param {string} notebookId
 */
export function invalidateSourceCache(notebookId) {
  _sourceCache.delete(notebookId);
}

/**
 * Detect source type from the raw source array.
 */
function detectSourceType(src) {
  // Walk looking for URL patterns
  const str = JSON.stringify(src);
  if (str.includes('youtube.com') || str.includes('youtu.be')) return 'youtube';
  if (str.includes('docs.google.com') || str.includes('drive.google.com')) return 'gdrive';
  if (str.includes('http://') || str.includes('https://')) return 'url';
  return 'text';
}

/**
 * Extract URL from a source array if present.
 */
function extractSourceUrl(src) {
  const urlRe = /https?:\/\/[^\s"]+/;
  const str = JSON.stringify(src);
  const match = str.match(urlRe);
  return match ? match[0].replace(/["\\]/g, '') : null;
}

/**
 * Delete a source from a notebook.
 *
 * @param {string} notebookId
 * @param {string} sourceId
 * @returns {Promise<void>}
 */
export async function deleteSource(notebookId, sourceId) {
  await rpcCall(RPC.DELETE_SOURCE, [[[sourceId]]], {
    sourcePath: `/notebook/${notebookId}`,
  });
  // Invalidate source cache — source list has changed
  invalidateSourceCache(notebookId);
}

/**
 * Get the full text content of a source.
 *
 * @param {string} notebookId
 * @param {string} sourceId
 * @returns {Promise<{ title: string|null, content: string }>}
 */
export async function getSourceContent(notebookId, sourceId) {
  const result = await rpcCall(RPC.GET_SOURCE, [[sourceId], [2], [2]], {
    sourcePath: `/notebook/${notebookId}`,
  });

  if (!result) return { title: null, content: '' };

  // Title is often at result[1] or result[0]
  let title = null;
  if (typeof result[1] === 'string') title = result[1];
  else if (typeof result[0] === 'string') title = result[0];

  // Content is in result[3] — recursive text blocks
  const content = extractTextBlocks(result[3] || result);
  return { title, content };
}

/**
 * Recursively extract text from nested arrays (source content blocks).
 */
function extractTextBlocks(obj, depth = 0) {
  if (depth > 15) return '';
  if (typeof obj === 'string' && obj.length > 0) return obj;
  if (!Array.isArray(obj)) return '';

  const parts = [];
  for (const item of obj) {
    const text = extractTextBlocks(item, depth + 1);
    if (text) parts.push(text);
  }
  return parts.join('\n');
}

// ============================================================================
// Notebook Management
// ============================================================================

/**
 * Rename a notebook.
 *
 * @param {string} notebookId
 * @param {string} newTitle
 * @returns {Promise<void>}
 */
export async function renameNotebook(notebookId, newTitle) {
  await rpcCall(RPC.RENAME_NOTEBOOK, [notebookId, [[null, null, null, [null, newTitle]]]], {
    sourcePath: '/',
  });
}

/**
 * Get conversation history for a notebook.
 *
 * @param {string} notebookId
 * @param {number} [limit=20]
 * @returns {Promise<{ conversationId: string|null, turns: { role: string, text: string }[] }>}
 */
export async function getConversationHistory(notebookId, limit = 20) {
  // Step 1: Get conversation ID
  const convResult = await rpcCall(RPC.GET_CONVERSATION_ID, [[], null, notebookId, 1], {
    sourcePath: `/notebook/${notebookId}`,
  });

  let conversationId = null;
  if (convResult) {
    // Nested: [[[conv_id]]] or similar
    const walk = (obj, depth) => {
      if (depth > 5) return null;
      if (typeof obj === 'string' && /^[0-9a-f-]{36}$/i.test(obj)) return obj;
      if (Array.isArray(obj)) {
        for (const item of obj) {
          const found = walk(item, depth + 1);
          if (found) return found;
        }
      }
      return null;
    };
    conversationId = walk(convResult, 0);
  }

  if (!conversationId) {
    return { conversationId: null, turns: [] };
  }

  // Step 2: Get conversation turns
  const turnsResult = await rpcCall(RPC.GET_CONVERSATION_TURNS, [[], null, null, conversationId, limit], {
    sourcePath: `/notebook/${notebookId}`,
  });

  const turns = [];
  if (Array.isArray(turnsResult)) {
    for (const turn of turnsResult) {
      if (!Array.isArray(turn)) continue;
      const roleCode = turn[2]; // 1 = user, 2 = assistant
      const role = roleCode === 1 ? 'user' : roleCode === 2 ? 'assistant' : 'unknown';
      let text = '';
      if (role === 'user' && typeof turn[3] === 'string') {
        text = turn[3];
      } else if (role === 'assistant') {
        // Assistant text at turn[4][0][0]
        text = turn?.[4]?.[0]?.[0] || '';
        if (typeof text !== 'string') text = '';
      }
      if (text) {
        turns.push({ role, text });
      }
    }
  }

  // Reverse for chronological order
  turns.reverse();

  return { conversationId, turns };
}

/**
 * Get a notebook summary.
 *
 * @param {string} notebookId
 * @returns {Promise<{ summary: string, topics: string[] }>}
 */
export async function getNotebookSummary(notebookId) {
  const result = await rpcCall(RPC.SUMMARIZE, [notebookId, [2]], {
    sourcePath: `/notebook/${notebookId}`,
  });

  let summary = '';
  let topics = [];

  if (result) {
    // Summary at result[0][0][0], topics at result[0][1]
    summary = result?.[0]?.[0]?.[0] || '';
    if (typeof summary !== 'string') summary = '';
    const rawTopics = result?.[0]?.[1];
    if (Array.isArray(rawTopics)) {
      topics = rawTopics.filter(t => typeof t === 'string');
    }
  }

  return { summary, topics };
}

// ============================================================================
// Artifacts
// ============================================================================

/** Normalize user-supplied enum string: uppercase + hyphens to underscores. */
function normalizeEnumKey(val) {
  return val ? val.toUpperCase().replace(/-/g, '_') : null;
}

/**
 * Build type-specific artifact params.
 */
function buildArtifactParams(typeCode, sourceIds, options = {}) {
  const tripleNested = sourceIds.map(id => [[id]]);
  const doubleNested = sourceIds.map(id => [id]);
  const lang = options.language || 'en';
  const instructions = options.instructions || null;

  // Each artifact type has its type-specific array at a DIFFERENT position
  // in the inner array. Verified against Python reference:
  // /tmp/notebooklm-py/src/notebooklm/_artifacts.py

  switch (typeCode) {
    case ARTIFACT_TYPE.AUDIO: {
      // Python: _artifacts.py:384-408 — position [6]
      const format = AUDIO_FORMAT[normalizeEnumKey(options.format)] || null;
      const length = AUDIO_LENGTH[normalizeEnumKey(options.length)] || null;
      return [
        null, null, 1, tripleNested, null, null,
        [null, [instructions, length, null, doubleNested, lang, null, format]],
      ];
    }
    case ARTIFACT_TYPE.REPORT: {
      // Python: _artifacts.py:602-627 — position [8]
      const title = options.title || 'Briefing Doc';
      const desc = options.description || 'Key insights and important quotes';
      const prompt = instructions || 'Create a comprehensive briefing document that includes an Executive Summary, detailed analysis of key themes, important quotes with context, and actionable insights.';
      return [
        null, null, 2, tripleNested, null, null, null, null,
        [null, [title, desc, null, doubleNested, lang, prompt, null, true]],
      ];
    }
    case ARTIFACT_TYPE.VIDEO: {
      // Python: _artifacts.py:441-467 — position [8], inner at [2]
      const format = VIDEO_FORMAT[normalizeEnumKey(options.format)] || null;
      const style = VIDEO_STYLE[normalizeEnumKey(options.style)] || null;
      return [
        null, null, 3, tripleNested, null, null, null, null,
        [null, null, [doubleNested, lang, instructions, null, format, style]],
      ];
    }
    case ARTIFACT_TYPE.QUIZ: {
      // Python: _artifacts.py:685-713 — position [9]
      const variant = QUIZ_VARIANT[normalizeEnumKey(options.variant)] || QUIZ_VARIANT.QUIZ;
      const quantity = QUIZ_QUANTITY[normalizeEnumKey(options.quantity)] || null;
      const difficulty = QUIZ_DIFFICULTY[normalizeEnumKey(options.difficulty)] || null;
      return [
        null, null, 4, tripleNested, null, null, null, null, null,
        [null, [variant, null, instructions, null, null, null, null, [quantity, difficulty]]],
      ];
    }
    case ARTIFACT_TYPE.INFOGRAPHIC: {
      // Python: _artifacts.py:803-824 — position [14]
      const orientation = INFOGRAPHIC_ORIENTATION[normalizeEnumKey(options.orientation)] || null;
      const detail = INFOGRAPHIC_DETAIL[normalizeEnumKey(options.detail)] || null;
      const style = INFOGRAPHIC_STYLE[normalizeEnumKey(options.style)] || null;
      return [
        null, null, 7, tripleNested,
        null, null, null, null, null, null, null, null, null, null,
        [[instructions, lang, null, orientation, detail, style]],
      ];
    }
    case ARTIFACT_TYPE.SLIDE_DECK: {
      // Python: _artifacts.py:855-878 — position [16]
      const format = SLIDE_DECK_FORMAT[normalizeEnumKey(options.format)] || null;
      const length = SLIDE_DECK_LENGTH[normalizeEnumKey(options.length)] || null;
      return [
        null, null, 8, tripleNested,
        null, null, null, null, null, null, null, null, null, null, null, null,
        [[instructions, lang, format, length]],
      ];
    }
    case ARTIFACT_TYPE.DATA_TABLE:
      // Python: _artifacts.py:953-978 — position [18]
      return [
        null, null, 9, tripleNested,
        null, null, null, null, null, null, null, null, null, null, null, null, null, null,
        [null, [instructions, lang]],
      ];
    default:
      throw new Error(`Unknown artifact type code: ${typeCode}`);
  }
}

/**
 * Generate an artifact in a notebook.
 *
 * @param {string} notebookId
 * @param {number} typeCode - ARTIFACT_TYPE value
 * @param {string[]} sourceIds
 * @param {object} [options]
 * @returns {Promise<{ artifactId: string|null, taskId: string|null }>}
 */
export async function generateArtifact(notebookId, typeCode, sourceIds, options = {}) {
  const innerParams = buildArtifactParams(typeCode, sourceIds, options);
  const params = [[2], notebookId, innerParams];

  const result = await rpcCall(RPC.CREATE_ARTIFACT, params, {
    sourcePath: `/notebook/${notebookId}`,
  });

  let artifactId = null;
  let taskId = null;

  if (result) {
    const ids = extractIds(result);
    if (ids.length >= 1) artifactId = ids[0];
    if (ids.length >= 2) taskId = ids[1];
  }

  // If RPC returned null (error [3]/[13]), fall back to Python CLI
  // Node.js fetch has an incompatibility with some Google batchexecute endpoints
  // that httpx doesn't have. The Python CLI works for all artifact types.
  if (!artifactId) {
    const cliResult = await generateArtifactViaCli(notebookId, typeCode, sourceIds, options);
    if (cliResult) return cliResult;
  }

  return { artifactId, taskId };
}

/** Extract string IDs from nested response arrays. */
function extractIds(obj, depth = 0) {
  const found = [];
  if (depth > 5) return found;
  if (typeof obj === 'string' && obj.length > 5 && !obj.includes(' ')) found.push(obj);
  if (Array.isArray(obj)) for (const item of obj) found.push(...extractIds(item, depth + 1));
  return found;
}

/** CLI type names for the Python notebooklm-py CLI. */
const CLI_TYPE_MAP = {
  [ARTIFACT_TYPE.AUDIO]: 'audio',
  [ARTIFACT_TYPE.REPORT]: 'report',
  [ARTIFACT_TYPE.VIDEO]: 'video',
  [ARTIFACT_TYPE.QUIZ]: 'quiz',
  [ARTIFACT_TYPE.INFOGRAPHIC]: 'infographic',
  [ARTIFACT_TYPE.SLIDE_DECK]: 'slide-deck',
  [ARTIFACT_TYPE.DATA_TABLE]: 'data-table',
};

/**
 * Fall back to the Python notebooklm-py CLI for artifact generation.
 * Some Google endpoints reject Node.js fetch but work with Python httpx.
 */
async function generateArtifactViaCli(notebookId, typeCode, sourceIds, options = {}) {
  const typeName = CLI_TYPE_MAP[typeCode];
  if (!typeName) return null;

  try {
    const args = ['notebooklm', 'generate', typeName];

    // Add type-specific options
    if (typeCode === ARTIFACT_TYPE.REPORT) {
      args.push('--format', options.format || 'briefing-doc');
      if (options.instructions) args.push('--append', options.instructions);
    } else if (typeCode === ARTIFACT_TYPE.AUDIO) {
      if (options.instructions) args.push(options.instructions);
      if (options.format) args.push('--format', options.format);
      if (options.length) args.push('--length', options.length);
    } else if (typeCode === ARTIFACT_TYPE.VIDEO) {
      if (options.instructions) args.push(options.instructions);
      if (options.format) args.push('--format', options.format);
      if (options.style) args.push('--style', options.style);
    } else if (typeCode === ARTIFACT_TYPE.QUIZ) {
      if (options.difficulty) args.push('--difficulty', options.difficulty);
      if (options.quantity) args.push('--quantity', options.quantity);
    } else if (typeCode === ARTIFACT_TYPE.INFOGRAPHIC) {
      if (options.orientation) args.push('--orientation', options.orientation);
      if (options.detail) args.push('--detail', options.detail);
      if (options.style) args.push('--style', options.style);
    } else if (typeCode === ARTIFACT_TYPE.SLIDE_DECK) {
      if (options.format) args.push('--format', options.format);
      if (options.length) args.push('--length', options.length);
    } else if (typeCode === ARTIFACT_TYPE.DATA_TABLE && options.instructions) {
      args.push(options.instructions);
    }

    // Add source IDs
    for (const sid of sourceIds) args.push('-s', sid);
    args.push('-n', notebookId, '--json');

    if (options.language) args.push('--language', options.language);

    // Validate inputs to prevent injection (execFileSync is safe but belt+suspenders)
    if (notebookId && !/^[0-9a-f-]{36}$/i.test(notebookId)) {
      throw new Error('Invalid notebook ID format');
    }
    for (const sid of sourceIds) {
      if (!/^[0-9a-f-]{36}$/i.test(sid)) throw new Error('Invalid source ID format');
    }

    // execFileSync with array args — no shell, immune to command injection
    const { execFileSync } = await import('child_process');
    const output = execFileSync(args[0], args.slice(1), { timeout: 30000, encoding: 'utf-8' });
    const parsed = JSON.parse(output.trim());
    return { artifactId: parsed.task_id || null, taskId: parsed.task_id || null };
  } catch {
    return null;
  }
}

/**
 * List artifacts in a notebook.
 *
 * @param {string} notebookId
 * @returns {Promise<{ id: string, title: string, type: string, typeLabel: string, status: number, statusLabel: string }[]>}
 */
export async function listArtifacts(notebookId) {
  const result = await rpcCall(RPC.LIST_ARTIFACTS,
    [[2], notebookId, 'NOT artifact.status = "ARTIFACT_STATUS_SUGGESTED"'],
    { sourcePath: `/notebook/${notebookId}` },
  );

  if (!result || !Array.isArray(result)) return [];

  const artifacts = [];
  const entries = Array.isArray(result[0]) ? result[0] : result;

  for (const entry of entries) {
    if (!Array.isArray(entry)) continue;
    const id = typeof entry[0] === 'string' ? entry[0] : null;
    const title = typeof entry[1] === 'string' ? entry[1] : 'Untitled';
    const typeCode = typeof entry[2] === 'number' ? entry[2] : null;
    const status = typeof entry[3] === 'number' ? entry[3] : null;

    if (id) {
      artifacts.push({
        id,
        title,
        type: typeCode,
        typeLabel: ARTIFACT_TYPE_LABEL[typeCode] || `type_${typeCode}`,
        status,
        statusLabel: ARTIFACT_STATUS_LABEL[status] || `status_${status}`,
      });
    }
  }

  return artifacts;
}

/**
 * Delete an artifact from a notebook.
 *
 * @param {string} notebookId
 * @param {string} artifactId
 * @returns {Promise<void>}
 */
export async function deleteArtifact(notebookId, artifactId) {
  await rpcCall(RPC.DELETE_ARTIFACT, [notebookId, artifactId], {
    sourcePath: `/notebook/${notebookId}`,
  });
}

/**
 * Get artifact content (interactive HTML for quiz/flashcards, or metadata).
 *
 * @param {string} notebookId
 * @param {string} artifactId
 * @returns {Promise<{ html: string|null, data: object|null }>}
 */
export async function getArtifactContent(notebookId, artifactId) {
  const result = await rpcCall(RPC.GET_INTERACTIVE_HTML, [notebookId, artifactId], {
    sourcePath: `/notebook/${notebookId}`,
  });

  let html = null;
  let data = null;

  if (result) {
    // HTML is typically a string in the result
    if (typeof result === 'string') {
      html = result;
    } else if (Array.isArray(result)) {
      // Walk for HTML string
      const walk = (obj, depth) => {
        if (depth > 5) return null;
        if (typeof obj === 'string' && obj.includes('data-app-data')) return obj;
        if (typeof obj === 'string' && obj.length > 100) return obj;
        if (Array.isArray(obj)) {
          for (const item of obj) {
            const found = walk(item, depth + 1);
            if (found) return found;
          }
        }
        return null;
      };
      html = walk(result, 0);
    }

    // Parse data-app-data JSON if present
    if (html) {
      const dataMatch = html.match(/data-app-data="([^"]+)"/);
      if (dataMatch) {
        try {
          const decoded = dataMatch[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#39;/g, "'");
          data = JSON.parse(decoded);
        } catch { /* ignore parse errors */ }
      }
    }
  }

  return { html, data };
}

// ============================================================================
// Research
// ============================================================================

/**
 * Poll helper — retries a check function until it returns truthy.
 *
 * @param {() => Promise<any>} checkFn
 * @param {{ maxWaitMs?: number, intervalMs?: number }} [opts]
 * @returns {Promise<any>}
 */
export async function pollUntilDone(checkFn, { maxWaitMs = 120_000, intervalMs = 5_000 } = {}) {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const result = await checkFn();
    if (result?.done) return result;
    await sleep(intervalMs);
  }
  throw new Error(`Polling timed out after ${maxWaitMs / 1000}s`);
}

/**
 * Start a research task (fast or deep).
 *
 * @param {string} notebookId
 * @param {string} query
 * @param {number} [sourceType=1] - 1=web, 2=drive
 * @param {boolean} [deep=false]
 * @returns {Promise<{ taskId: string|null }>}
 */
export async function startResearch(notebookId, query, sourceType = 1, deep = false) {
  let params;
  let methodId;

  if (deep) {
    methodId = RPC.START_DEEP_RESEARCH;
    params = [null, [1], [query, sourceType], 5, notebookId];
  } else {
    methodId = RPC.START_FAST_RESEARCH;
    params = [[query, sourceType], null, 1, notebookId];
  }

  const result = await rpcCall(methodId, params, {
    sourcePath: `/notebook/${notebookId}`,
  });

  let taskId = null;
  if (result) {
    const walk = (obj, depth) => {
      if (depth > 5) return null;
      if (typeof obj === 'string' && obj.length > 5 && !obj.includes(' ')) return obj;
      if (Array.isArray(obj)) {
        for (const item of obj) {
          const found = walk(item, depth + 1);
          if (found) return found;
        }
      }
      return null;
    };
    taskId = walk(result, 0);
  }

  return { taskId };
}

/**
 * Poll research task status.
 *
 * @param {string} notebookId
 * @returns {Promise<{ status: number, statusLabel: string, summary: string|null, sources: object[]|null, taskId: string|null, done: boolean }>}
 */
export async function pollResearch(notebookId, targetTaskId = null) {
  const result = await rpcCall(RPC.POLL_RESEARCH, [null, null, notebookId], {
    sourcePath: `/notebook/${notebookId}`,
  });

  if (!result) {
    return { status: 0, statusLabel: 'unknown', summary: null, sources: null, taskId: null, done: false };
  }

  // Verified response structure (2026-03-22):
  //   result = [task0, task1, ..., taskN]     — flat array of research tasks
  //   task[0] = taskId (UUID string)
  //   task[1] = details array:
  //     [0] = notebookId
  //     [1] = [query, sourceType]
  //     [2] = statusInner (1=in_progress, 5=completed)
  //     [3] = [sourcesArray]  — sources at [3][0], each source:
  //            source[0] = url (null for generated report)
  //            source[1] = title
  //            source[2] = description
  //            source[3] = type (1=web, 5=generated_report)
  //     [4] = statusOuter (2=fast_done, 5=deep_done, 6=completed_with_deep)
  //     [5] = [deepSubTaskId, base64data, deepStatus] (only for deep research)

  let status = 0;
  let summary = null;
  let taskId = null;
  let sources = null;

  if (!Array.isArray(result)) {
    return { status: 0, statusLabel: 'unknown', summary, sources, taskId, done: false };
  }

  // result[0] is the task list — each element is [taskId, details, ...]
  const tasks = Array.isArray(result[0]) && Array.isArray(result[0][0]) ? result[0] : result;

  // Find the right task
  let task = null;
  if (targetTaskId) {
    // Match by main taskId OR deep research sub-taskId
    task = tasks.find(t =>
      Array.isArray(t) && (
        t[0] === targetTaskId ||
        (Array.isArray(t[1]) && Array.isArray(t[1][5]) && t[1][5][0] === targetTaskId)
      )
    );
  }

  if (!task) {
    // Prefer in-progress task, then most recently completed
    const inProgress = tasks.find(t =>
      Array.isArray(t) && Array.isArray(t[1]) && t[1][2] === 1
    );
    task = inProgress || tasks[0];
  }

  if (!Array.isArray(task)) {
    return { status: 0, statusLabel: 'unknown', summary, sources, taskId, done: false };
  }

  // Extract taskId
  if (typeof task[0] === 'string') {
    taskId = task[0];
  }

  const inner = Array.isArray(task[1]) ? task[1] : null;
  if (inner) {
    // Status: take the higher of inner[2] and inner[4]
    const statusInner = typeof inner[2] === 'number' ? inner[2] : 0;
    const statusOuter = typeof inner[4] === 'number' ? inner[4] : 0;
    status = Math.max(statusInner, statusOuter);

    // Sources at inner[3][0]
    if (Array.isArray(inner[3]) && Array.isArray(inner[3][0])) {
      sources = inner[3][0].map(s => ({
        url: s[0] || null,
        title: s[1] || null,
        description: s[2] || null,
        type: s[3] === 5 ? 'generated_report' : 'web',
      }));
    }

    // Summary: query text as fallback
    if (Array.isArray(inner[1]) && typeof inner[1][0] === 'string') {
      summary = inner[1][0];
    }

    // Deep research sub-task info
    if (Array.isArray(inner[5]) && typeof inner[5][0] === 'string') {
      // Attach deep sub-task ID for reference
      if (!taskId) taskId = inner[5][0];
    }
  }

  const done = status >= 2 && status !== 3; // 2=fast_done, 5=completed, 6=completed_with_deep (3=error)
  const statusLabel = done ? 'completed' : status === 1 ? 'in_progress' : status === 0 ? 'unknown' : `status_${status}`;

  return { status, statusLabel, summary, sources, taskId, done };
}

/**
 * Import research results as sources into a notebook.
 *
 * @param {string} notebookId
 * @param {string} taskId
 * @param {{ url: string, title: string }[]} sources
 * @returns {Promise<void>}
 */
export async function importResearch(notebookId, taskId, sources) {
  const sourceArray = sources.map(s => [null, null, [s.url, s.title], null, null, null, null, null, null, null, 2]);

  await rpcCall(RPC.IMPORT_RESEARCH, [null, [1], taskId, notebookId, sourceArray], {
    sourcePath: `/notebook/${notebookId}`,
  });
}

// ============================================================================
// Notes & Mind Maps
// ============================================================================

/**
 * Create a note in a notebook (two-step: create + update with content).
 *
 * @param {string} notebookId
 * @param {string} title
 * @param {string} content
 * @returns {Promise<{ noteId: string|null }>}
 */
export async function createNote(notebookId, title, content) {
  // Step 1: Create empty note
  const createResult = await rpcCall(RPC.CREATE_NOTE, [notebookId, '', [1], null, 'New Note'], {
    sourcePath: `/notebook/${notebookId}`,
  });

  let noteId = null;
  if (createResult) {
    const walk = (obj, depth) => {
      if (depth > 5) return null;
      if (typeof obj === 'string' && obj.length > 5 && !obj.includes(' ')) return obj;
      if (Array.isArray(obj)) {
        for (const item of obj) {
          const found = walk(item, depth + 1);
          if (found) return found;
        }
      }
      return null;
    };
    noteId = walk(createResult, 0);
  }

  if (!noteId) {
    throw new Error('Failed to extract note ID from createNote response');
  }

  // Step 2: Update with title and content
  await updateNote(notebookId, noteId, title, content);

  return { noteId };
}

/**
 * List notes and mind maps in a notebook.
 *
 * @param {string} notebookId
 * @returns {Promise<{ notes: { id: string, title: string, content: string }[], mindMaps: { id: string, title: string }[] }>}
 */
export async function listNotes(notebookId) {
  const result = await rpcCall(RPC.GET_NOTES_AND_MIND_MAPS, [notebookId], {
    sourcePath: `/notebook/${notebookId}`,
  });

  const notes = [];
  const mindMaps = [];

  if (!result || !Array.isArray(result)) return { notes, mindMaps };

  const entries = Array.isArray(result[0]) ? result[0] : result;

  for (const entry of entries) {
    if (!Array.isArray(entry)) continue;

    const id = typeof entry[0] === 'string' ? entry[0] : null;
    if (!id) continue;

    // Skip deleted notes (status 2 at entry[2] when entry is short [id, null, 2])
    if (entry.length <= 3 && entry[2] === 2) continue;

    // For active notes: [id, [title, content, ...], ...] or [id, title, content, ...]
    // Detect structure — entry[1] can be an array (nested) or string (flat)
    let title = 'Untitled';
    let contentStr = '';
    if (Array.isArray(entry[1])) {
      title = typeof entry[1][0] === 'string' ? entry[1][0] : 'Untitled';
      contentStr = typeof entry[1][1] === 'string' ? entry[1][1] : '';
    } else {
      title = typeof entry[1] === 'string' ? entry[1] : 'Untitled';
      contentStr = typeof entry[2] === 'string' ? entry[2] : '';
    }

    let isMindMap = false;
    if (contentStr) {
      try {
        const parsed = JSON.parse(contentStr);
        if (parsed.children || parsed.nodes) isMindMap = true;
      } catch { /* not JSON, it's a regular note */ }
    }

    if (isMindMap) {
      mindMaps.push({ id, title });
    } else {
      notes.push({ id, title, content: contentStr });
    }
  }

  return { notes, mindMaps };
}

/**
 * Update a note's title and/or content.
 *
 * @param {string} notebookId
 * @param {string} noteId
 * @param {string} title
 * @param {string} content
 * @returns {Promise<void>}
 */
export async function updateNote(notebookId, noteId, title, content) {
  await rpcCall(RPC.UPDATE_NOTE, [notebookId, noteId, [[[content, title, [], 0]]]], {
    sourcePath: `/notebook/${notebookId}`,
  });
}

/**
 * Delete a note (soft delete).
 *
 * @param {string} notebookId
 * @param {string} noteId
 * @returns {Promise<void>}
 */
export async function deleteNote(notebookId, noteId) {
  await rpcCall(RPC.DELETE_NOTE, [notebookId, null, [noteId]], {
    sourcePath: `/notebook/${notebookId}`,
  });
}

/**
 * Generate a mind map for selected sources.
 *
 * @param {string} notebookId
 * @param {string[]} sourceIds
 * @returns {Promise<{ taskId: string|null }>}
 */
export async function generateMindMap(notebookId, sourceIds) {
  const tripleNested = sourceIds.map(id => [[id]]);

  // GENERATE_MIND_MAP returns mind map JSON but does NOT persist it.
  // We must create a note with the returned content to save it.
  const params = [
    tripleNested,
    null,
    null,
    null,
    null,
    ['interactive_mindmap', [['[CONTEXT]', '']], ''],
    null,
    [2, null, [1]],
  ];

  const result = await rpcCall(RPC.GENERATE_MIND_MAP, params, {
    sourcePath: `/notebook/${notebookId}`,
  });

  if (!result || !Array.isArray(result) || result.length === 0) {
    return { mindMap: null, noteId: null };
  }

  // Extract mind map JSON from result[0][0]
  const inner = result[0];
  let mindMapJson = null;
  let mindMapData = null;

  if (Array.isArray(inner) && inner.length > 0) {
    const raw = inner[0];
    if (typeof raw === 'string') {
      try { mindMapData = JSON.parse(raw); } catch { mindMapData = raw; }
      mindMapJson = raw;
    } else if (raw && typeof raw === 'object') {
      mindMapData = raw;
      mindMapJson = JSON.stringify(raw);
    }
  }

  if (!mindMapJson) {
    return { mindMap: null, noteId: null };
  }

  // Extract title from mind map data
  let title = 'Mind Map';
  if (mindMapData && typeof mindMapData === 'object' && mindMapData.name) {
    title = mindMapData.name;
  }

  // Persist as a note (GENERATE_MIND_MAP only generates, doesn't save)
  const { noteId } = await createNote(notebookId, title, mindMapJson);

  return { mindMap: mindMapData, noteId };
}

// --- Exports for testing ---
export const __testing__ = { buildArtifactParams };
