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
import { getAuth, clearAuthCache } from './notebooklm-auth.js';
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

const ORIGIN = 'https://notebooklm.google.com';

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

// --- Passphrase management (in-memory only) ---

let _passphrase = null;

/**
 * Set the passphrase for decrypting stored cookies.
 * Held in memory only — never persisted.
 * Falls back to NOTEBOOKLM_PASSPHRASE env var if not explicitly set.
 *
 * @param {string} passphrase
 */
export function setPassphrase(passphrase) {
  _passphrase = passphrase;
}

// Auto-load from env on startup (so .env works without explicit passphrase param)
if (!_passphrase && process.env.NOTEBOOKLM_PASSPHRASE) {
  _passphrase = process.env.NOTEBOOKLM_PASSPHRASE;
}

/**
 * Check if passphrase has been set for this session.
 */
export function hasPassphrase() {
  return _passphrase !== null && _passphrase.length > 0;
}

/**
 * Clear the in-memory passphrase.
 */
export function clearPassphrase() {
  _passphrase = null;
}

function requirePassphrase() {
  if (!_passphrase) {
    throw new Error(
      'NotebookLM passphrase not set. Call any NotebookLM tool with the `passphrase` parameter first, ' +
      'or run the login flow.'
    );
  }
  return _passphrase;
}

/**
 * Make an authenticated batchexecute RPC call.
 *
 * @param {string} methodId
 * @param {any[]} params
 * @param {object} [opts]
 * @param {string} [opts.sourcePath] - Source-path query param
 * @param {boolean} [opts._isRetry] - Internal: prevent infinite retry loop
 * @returns {Promise<any>} Decoded result
 */
async function rpcCall(methodId, params, opts = {}) {
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
  const result = await rpcCall(RPC.LIST_NOTEBOOKS, []);

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
  const result = await rpcCall(RPC.CREATE_NOTEBOOK, [title]);

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
  const passphrase = requirePassphrase();
  const auth = await getAuth(passphrase);

  const params = [
    [], // sources (empty = use all)
    question,
    null, // no conversation history
    [2, null, [1], [1]],
    null, // no conversation ID (new conversation)
    null,
    null,
    notebookId,
    1,
  ];

  const paramsJson = JSON.stringify(params);
  const fReq = JSON.stringify([null, paramsJson]);
  const body = `f.req=${encodeURIComponent(fReq)}&at=${encodeURIComponent(auth.csrfToken)}&`;

  const qs = new URLSearchParams({
    'hl': 'en',
    'f.sid': auth.sessionId,
    'rt': 'c',
  }).toString();

  const streamHeaders = {
    'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
    'Cookie': auth.cookieHeader,
    'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Origin': ORIGIN,
    'Referer': `${ORIGIN}/notebook/${notebookId}`,
  };
  const streamSapisid = generateSapisidHash(auth.cookieHeader);
  if (streamSapisid) streamHeaders['Authorization'] = streamSapisid;

  const res = await fetch(`${STREAMING_URL}?${qs}`, {
    method: 'POST',
    headers: streamHeaders,
  });

  if ((res.status === 401 || res.status === 403)) {
    clearAuthCache();
    return askQuestion(notebookId, question);
  }

  if (!res.ok) {
    throw new Error(`NotebookLM query returned ${res.status}`);
  }

  const responseText = await res.text();
  return decodeStreamingResponse(responseText);
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
