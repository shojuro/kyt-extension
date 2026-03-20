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

/**
 * Check if passphrase has been set for this session.
 * Lazily loads from env var on first check (dotenv runs after ES module imports).
 */
export function hasPassphrase() {
  if (!_passphrase && process.env.NOTEBOOKLM_PASSPHRASE) {
    _passphrase = process.env.NOTEBOOKLM_PASSPHRASE;
  }
  return _passphrase !== null && _passphrase.length > 0;
}

/**
 * Clear the in-memory passphrase.
 */
export function clearPassphrase() {
  _passphrase = null;
}

function requirePassphrase() {
  if (!_passphrase && process.env.NOTEBOOKLM_PASSPHRASE) {
    _passphrase = process.env.NOTEBOOKLM_PASSPHRASE;
  }
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

  if (!result || !Array.isArray(result)) return [];

  // Sources are at result[0][1] — array of source entries
  const rawSources = result?.[0]?.[1];
  if (!Array.isArray(rawSources)) return [];

  const sources = [];
  for (const src of rawSources) {
    if (!Array.isArray(src)) continue;
    // Source ID is nested: [[sourceId], title, ...] or [sourceId, title, ...]
    let id = null;
    if (Array.isArray(src[0]) && typeof src[0][0] === 'string') {
      id = src[0][0]; // [[sourceId]]
    } else if (typeof src[0] === 'string') {
      id = src[0]; // [sourceId]
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

  return sources;
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

/**
 * Build type-specific artifact params.
 */
function buildArtifactParams(typeCode, sourceIds, options = {}) {
  const tripleNested = sourceIds.map(id => [[id]]);
  const lang = options.language || 'en';
  const instructions = options.instructions || '';

  switch (typeCode) {
    case ARTIFACT_TYPE.AUDIO: {
      const format = AUDIO_FORMAT[options.format?.toUpperCase()] || AUDIO_FORMAT.DEEP_DIVE;
      const length = AUDIO_LENGTH[options.length?.toUpperCase()] || AUDIO_LENGTH.DEFAULT;
      return [null, null, typeCode, tripleNested, null, null,
        [null, [instructions, length, null, tripleNested, lang, null, format]]];
    }
    case ARTIFACT_TYPE.REPORT:
      return [null, null, typeCode, tripleNested, null, null, null, null,
        [null, [instructions, null, null, tripleNested, lang]]];
    case ARTIFACT_TYPE.VIDEO: {
      const format = VIDEO_FORMAT[options.format?.toUpperCase()] || VIDEO_FORMAT.LECTURE;
      const style = VIDEO_STYLE[options.style?.toUpperCase()] || VIDEO_STYLE.REALISTIC;
      return [null, null, typeCode, tripleNested, null, null, null, null,
        [null, [instructions, null, null, tripleNested, lang, null, format, style]]];
    }
    case ARTIFACT_TYPE.QUIZ: {
      const variant = QUIZ_VARIANT[options.variant?.toUpperCase()] || QUIZ_VARIANT.QUIZ;
      const quantity = QUIZ_QUANTITY[options.quantity?.toUpperCase()] || QUIZ_QUANTITY.STANDARD;
      const difficulty = QUIZ_DIFFICULTY[options.difficulty?.toUpperCase()] || QUIZ_DIFFICULTY.MEDIUM;
      return [null, null, typeCode, tripleNested, null, null, null, null,
        [null, null, tripleNested, lang, quantity, difficulty, variant]];
    }
    case ARTIFACT_TYPE.INFOGRAPHIC: {
      const orientation = INFOGRAPHIC_ORIENTATION[options.orientation?.toUpperCase()] || INFOGRAPHIC_ORIENTATION.PORTRAIT;
      const detail = INFOGRAPHIC_DETAIL[options.detail?.toUpperCase()] || INFOGRAPHIC_DETAIL.DETAILED;
      const style = INFOGRAPHIC_STYLE[options.style?.toUpperCase()] || INFOGRAPHIC_STYLE.MODERN;
      return [null, null, typeCode, tripleNested, null, null, null, null, null,
        [null, null, tripleNested, lang, orientation, detail, style]];
    }
    case ARTIFACT_TYPE.SLIDE_DECK: {
      const format = SLIDE_DECK_FORMAT[options.format?.toUpperCase()] || SLIDE_DECK_FORMAT.PRESENTATION;
      const length = SLIDE_DECK_LENGTH[options.length?.toUpperCase()] || SLIDE_DECK_LENGTH.MEDIUM;
      return [null, null, typeCode, tripleNested, null, null, null, null,
        [null, tripleNested, lang, format, length]];
    }
    case ARTIFACT_TYPE.DATA_TABLE:
      return [null, null, typeCode, tripleNested, null, null, null, null,
        [null, tripleNested, lang, null]];
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
    // Walk for IDs — artifact ID is usually a long string, task ID may be separate
    const walk = (obj, depth, found) => {
      if (depth > 5) return;
      if (typeof obj === 'string' && obj.length > 5 && !obj.includes(' ')) {
        found.push(obj);
      }
      if (Array.isArray(obj)) {
        for (const item of obj) walk(item, depth + 1, found);
      }
    };
    const ids = [];
    walk(result, 0, ids);
    if (ids.length >= 1) artifactId = ids[0];
    if (ids.length >= 2) taskId = ids[1];
  }

  return { artifactId, taskId };
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
export async function pollResearch(notebookId) {
  const result = await rpcCall(RPC.POLL_RESEARCH, [null, null, notebookId], {
    sourcePath: `/notebook/${notebookId}`,
  });

  if (!result) {
    return { status: 0, statusLabel: 'unknown', summary: null, sources: null, taskId: null, done: false };
  }

  // Parse status code and summary from result
  let status = 0;
  let summary = null;
  let taskId = null;
  let sources = null;

  if (Array.isArray(result)) {
    // Walk for status code (small number), summary (long string), task ID
    const walk = (obj, depth) => {
      if (depth > 8) return;
      if (typeof obj === 'number' && obj >= 1 && obj <= 10 && status === 0) status = obj;
      if (typeof obj === 'string' && obj.length > 50 && !summary) summary = obj;
      if (typeof obj === 'string' && obj.length > 5 && obj.length < 50 && !obj.includes(' ') && !taskId) taskId = obj;
      if (Array.isArray(obj)) {
        for (const item of obj) walk(item, depth + 1);
      }
    };
    walk(result, 0);
  }

  const done = status === 2 || status === 6; // COMPLETED_FAST or COMPLETED_DEEP
  const statusLabel = done ? 'completed' : status === 1 ? 'in_progress' : `status_${status}`;

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

    // Detect mind maps by checking for JSON content with "children" or "nodes"
    const contentStr = typeof entry[2] === 'string' ? entry[2] : '';
    const title = typeof entry[1] === 'string' ? entry[1] : 'Untitled';

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
  const result = await rpcCall(RPC.GENERATE_MIND_MAP, [notebookId, tripleNested], {
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
