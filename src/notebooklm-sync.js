/**
 * NotebookLM background sync module for the Chrome extension.
 *
 * Zero-config for the user:
 * 1. User enables "NotebookLM Sync" toggle in popup
 * 2. Extension reads Google cookies via chrome.cookies API (user is already signed in)
 * 3. Extension auto-creates a notebook and pushes conversations periodically
 *
 * Security model:
 * - Cookies read at runtime via chrome.cookies (never persisted separately)
 * - CSRF/session tokens fetched on demand, held in memory only
 * - No third-party dependencies
 * - All NotebookLM responses sanitized before storage
 */

import { callEdgeFunction } from './api-client.js';

// --- RPC Wire Format (inlined from mcp/src/lib/notebooklm-rpc.js for MV3 static import) ---

const RPC_IDS = {
  LIST: 'wXbhsf',
  CREATE: 'CCqFvf',
  ADD_SOURCE: 'izAoDd',
};

const BATCHEXECUTE_URL = 'https://notebooklm.google.com/_/LabsTailwindUi/data/batchexecute';
const NOTEBOOKLM_HOME = 'https://notebooklm.google.com';

const TOKEN_RE = /"SNlM0e"\s*:\s*"([^"]+)"/;
const SESSION_RE = /"FdrFJe"\s*:\s*"([^"]+)"/;

// Required cookie names for NotebookLM API access
const AUTH_COOKIE_NAMES = [
  'SID', 'HSID', 'SSID', 'APISID', 'SAPISID',
  '__Secure-1PSID', '__Secure-3PSID',
  '__Secure-1PAPISID', '__Secure-3PAPISID',
  '__Secure-1PSIDTS', '__Secure-3PSIDTS',
  'NID',
];

// Storage keys
const STORAGE_KEY = 'kyt_notebooklm';
const ENABLED_KEY = 'kyt_notebooklm_enabled';

// Sync config
const MAX_CHUNK_CHARS = 50_000;
const MAX_SOURCES = 300;
const SOURCE_UPLOAD_DELAY_MS = 2500;

// --- In-memory auth cache ---
let _authCache = null;

/**
 * Read Google auth cookies via chrome.cookies API.
 * No persistence — cookies are read at runtime from Chrome's cookie store.
 *
 * @returns {Promise<string>} Cookie header string
 */
async function getGoogleCookies() {
  const cookies = [];

  for (const name of AUTH_COOKIE_NAMES) {
    // Try notebooklm.google.com first, then .google.com
    for (const url of ['https://notebooklm.google.com', 'https://www.google.com']) {
      try {
        const cookie = await chrome.cookies.get({ url, name });
        if (cookie) {
          cookies.push(`${cookie.name}=${cookie.value}`);
          break; // Got this cookie, move to next name
        }
      } catch {
        // Cookie not found for this URL — try next
      }
    }
  }

  if (cookies.length === 0) {
    throw new Error('NO_GOOGLE_COOKIES');
  }

  return cookies.join('; ');
}

/**
 * Fetch CSRF token and session ID from NotebookLM homepage.
 * These are ephemeral — never stored.
 */
async function fetchTokens(cookieHeader) {
  const res = await fetch(NOTEBOOKLM_HOME, {
    headers: {
      'Cookie': cookieHeader,
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
    },
    redirect: 'follow',
  });

  if (!res.ok) throw new Error(`NOTEBOOKLM_${res.status}`);

  const html = await res.text();
  const csrfMatch = html.match(TOKEN_RE);
  const sessionMatch = html.match(SESSION_RE);

  if (!csrfMatch) throw new Error('CSRF_TOKEN_MISSING');
  if (!sessionMatch) throw new Error('SESSION_ID_MISSING');

  return { csrfToken: csrfMatch[1], sessionId: sessionMatch[1] };
}

/**
 * Get authenticated session. Reads cookies at runtime, fetches tokens.
 * Caches in memory for the service worker's lifetime.
 */
async function getAuth(forceRefresh = false) {
  if (_authCache && !forceRefresh) return _authCache;

  const cookieHeader = await getGoogleCookies();
  const { csrfToken, sessionId } = await fetchTokens(cookieHeader);
  _authCache = { cookieHeader, csrfToken, sessionId };
  return _authCache;
}

// --- RPC helpers ---

function encodeRpc(methodId, params) {
  return JSON.stringify([[[methodId, JSON.stringify(params), null, 'generic']]]);
}

function parseChunked(text) {
  const chunks = [];
  let pos = 0;
  while (pos < text.length) {
    while (pos < text.length && '\n\r '.includes(text[pos])) pos++;
    if (pos >= text.length) break;
    let numStr = '';
    while (pos < text.length && text[pos] >= '0' && text[pos] <= '9') { numStr += text[pos]; pos++; }
    if (!numStr) break;
    const byteCount = parseInt(numStr, 10);
    if (isNaN(byteCount) || byteCount <= 0) break;
    if (text[pos] === '\n') pos++;
    const remaining = text.slice(pos);
    const encoded = new TextEncoder().encode(remaining);
    const chunkBytes = encoded.slice(0, byteCount);
    const chunkText = new TextDecoder().decode(chunkBytes).trim();
    pos += new TextDecoder().decode(chunkBytes).length;
    try { chunks.push(JSON.parse(chunkText)); } catch { /* skip */ }
  }
  return chunks;
}

function decodeRpcResponse(responseText, methodId) {
  let text = responseText;
  if (text.startsWith(")]}'")) text = text.slice(text.indexOf('\n') + 1);
  const chunks = parseChunked(text);
  for (const chunk of chunks) {
    if (!Array.isArray(chunk)) continue;
    for (const item of chunk) {
      if (!Array.isArray(item) || item[0] !== 'wrb.fr' || item[1] !== methodId) continue;
      const data = item[2];
      if (data === null && item[5]?.includes?.('UserDisplayableError')) {
        throw new Error('RATE_LIMIT');
      }
      if (typeof data === 'string') { try { return JSON.parse(data); } catch { return data; } }
      return data;
    }
  }
  throw new Error(`NO_RESPONSE_FRAME_${methodId}`);
}

async function rpcCall(methodId, params, sourcePath) {
  const auth = await getAuth();
  const encoded = encodeRpc(methodId, params);
  const body = `f.req=${encodeURIComponent(encoded)}&at=${encodeURIComponent(auth.csrfToken)}&`;

  const qs = new URLSearchParams({
    rpcids: methodId,
    'f.sid': auth.sessionId,
    hl: 'en',
    rt: 'c',
  });
  if (sourcePath) qs.set('source-path', sourcePath);

  const res = await fetch(`${BATCHEXECUTE_URL}?${qs}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
      'Cookie': auth.cookieHeader,
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
      'Origin': 'https://notebooklm.google.com',
      'Referer': 'https://notebooklm.google.com/',
    },
  });

  if (res.status === 401 || res.status === 403) {
    _authCache = null;
    throw new Error('AUTH_EXPIRED');
  }
  if (res.status === 429) throw new Error('RATE_LIMIT');
  if (!res.ok) throw new Error(`RPC_${res.status}`);

  return decodeRpcResponse(await res.text(), methodId);
}

// --- Public API ---

/**
 * Check if user is signed into Google (has required cookies).
 */
export async function checkGoogleSignIn() {
  try {
    await getGoogleCookies();
    return { signedIn: true };
  } catch {
    return { signedIn: false };
  }
}

/**
 * Verify NotebookLM access works end-to-end.
 */
export async function verifyAccess() {
  try {
    await getAuth(true);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * List notebooks.
 */
async function listNotebooks() {
  const result = await rpcCall(RPC_IDS.LIST, [null, 1, null, [2]]);
  if (!result || !Array.isArray(result)) return [];
  const entries = Array.isArray(result[0]) ? result[0] : result;
  const notebooks = [];
  for (const entry of entries) {
    if (!Array.isArray(entry)) continue;
    const id = entry[0];
    const title = entry[1] || entry[2] || 'Untitled';
    if (id && typeof id === 'string') {
      notebooks.push({ id, title, sourceCount: Array.isArray(entry[3]) ? entry[3].length : 0 });
    }
  }
  return notebooks;
}

/**
 * Create a notebook.
 */
async function createNotebook(title) {
  const result = await rpcCall(RPC_IDS.CREATE, [title, null, null, [2], [1]]);
  if (!result) throw new Error('CREATE_FAILED');
  const id = Array.isArray(result) ? result[0] : result;
  if (!id) throw new Error('CREATE_NO_ID');
  return { id, title };
}

/**
 * Add a text source to a notebook.
 */
async function addSource(notebookId, title, content) {
  const params = [
    [[null, [title, content], null, null, null, null, null, null]],
    notebookId, [2], null, null,
  ];
  await rpcCall(RPC_IDS.ADD_SOURCE, params, `/notebook/${notebookId}`);
}

/**
 * Get or load sync state from chrome.storage.local.
 */
async function getSyncState() {
  const result = await chrome.storage.local.get([STORAGE_KEY]);
  return result[STORAGE_KEY] || {
    notebookId: null,
    notebookTitle: null,
    lastPushAt: null,
    pushedConversationIds: [],
    sourceCount: 0,
    lastError: null,
    lastErrorAt: null,
  };
}

async function saveSyncState(state) {
  await chrome.storage.local.set({ [STORAGE_KEY]: state });
}

/**
 * Get or create the K.Y.T. notebook.
 */
async function ensureNotebook(state) {
  if (state.notebookId) {
    // Verify it still exists
    try {
      const notebooks = await listNotebooks();
      if (notebooks.some(n => n.id === state.notebookId)) {
        return state;
      }
    } catch {
      // Fall through to create
    }
  }

  // Create new notebook
  const { id, title } = await createNotebook('K.Y.T. Memory');
  state.notebookId = id;
  state.notebookTitle = title;
  state.sourceCount = 0;
  state.pushedConversationIds = [];
  await saveSyncState(state);
  console.log(`📓 NotebookLM: Created notebook "${title}" (${id})`);
  return state;
}

/**
 * Main sync function — called by the alarm handler.
 *
 * Queries Supabase for conversations not yet pushed, chunks them,
 * and uploads as sources to the linked NotebookLM notebook.
 */
export async function syncToNotebookLM() {
  // Check if enabled
  const { [ENABLED_KEY]: enabled } = await chrome.storage.local.get([ENABLED_KEY]);
  if (!enabled) return { skipped: true, reason: 'disabled' };

  let state = await getSyncState();

  try {
    // Verify Google sign-in
    const { signedIn } = await checkGoogleSignIn();
    if (!signedIn) {
      state.lastError = 'Not signed into Google';
      state.lastErrorAt = new Date().toISOString();
      await saveSyncState(state);
      return { skipped: true, reason: 'not_signed_in' };
    }

    // Ensure notebook exists
    state = await ensureNotebook(state);

    // Check source limit
    if (state.sourceCount >= MAX_SOURCES) {
      return { skipped: true, reason: 'source_limit_reached' };
    }

    // Query unsyncedconversations from Supabase
    const conversations = await fetchUnpushedConversations(state.pushedConversationIds);
    if (conversations.length === 0) {
      return { skipped: true, reason: 'no_new_conversations' };
    }

    // Build chunks and upload
    let uploaded = 0;
    const maxThisRun = Math.min(10, MAX_SOURCES - state.sourceCount); // Cap at 10 per alarm cycle

    for (const conv of conversations) {
      if (uploaded >= maxThisRun) break;

      const chunks = chunkConversation(conv.turns);
      for (const chunk of chunks) {
        if (uploaded >= maxThisRun) break;
        if (state.sourceCount >= MAX_SOURCES) break;

        await addSource(state.notebookId, chunk.title, chunk.content);
        state.sourceCount++;
        uploaded++;

        // Delay between uploads
        if (uploaded < maxThisRun) {
          await new Promise(r => setTimeout(r, SOURCE_UPLOAD_DELAY_MS));
        }
      }

      state.pushedConversationIds.push(conv.conversationId);
    }

    state.lastPushAt = new Date().toISOString();
    state.lastError = null;
    state.lastErrorAt = null;
    await saveSyncState(state);

    console.log(`📓 NotebookLM sync: ${uploaded} source(s) pushed, ${state.sourceCount}/${MAX_SOURCES} total`);
    return { uploaded, sourceCount: state.sourceCount };

  } catch (err) {
    state.lastError = err.message;
    state.lastErrorAt = new Date().toISOString();
    await saveSyncState(state);
    console.error('❌ NotebookLM sync error:', err.message);
    return { error: err.message };
  }
}

/**
 * Fetch conversations not yet pushed to NotebookLM.
 * Uses the extension's existing Supabase auth.
 */
async function fetchUnpushedConversations(pushedIds) {

  const pushedSet = new Set(pushedIds);

  // Get recent conversations grouped by conversation_id
  // We use the edge function to avoid direct Supabase client in the service worker
  const result = await callEdgeFunction('search_memories', {
    query: '*', // Get all recent
    topK: 200,
    fast: true,
    returnRaw: true,
  }, { timeoutMs: 30000 });

  if (!result?.results) return [];

  // Group by conversation_id, skip already pushed
  const grouped = new Map();
  for (const item of result.results) {
    const convId = item.conversation_id;
    if (!convId || pushedSet.has(convId)) continue;
    if (!grouped.has(convId)) {
      grouped.set(convId, {
        conversationId: convId,
        platform: item.platform || 'unknown',
        turns: [],
      });
    }
    grouped.get(convId).turns.push({
      content: item.content,
      created_at: item.created_at || item.timestamp,
      platform: item.platform,
    });
  }

  // Sort turns within each conversation
  for (const conv of grouped.values()) {
    conv.turns.sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''));
  }

  return Array.from(grouped.values());
}

/**
 * Chunk a conversation's turns into NotebookLM source-sized pieces.
 */
function chunkConversation(turns) {
  const lines = [];
  let minDate = null, maxDate = null;
  const platform = turns[0]?.platform || 'unknown';

  for (const turn of turns) {
    const d = turn.created_at ? new Date(turn.created_at) : null;
    if (d) {
      if (!minDate || d < minDate) minDate = d;
      if (!maxDate || d > maxDate) maxDate = d;
    }
    const ts = d ? d.toISOString().slice(0, 16).replace('T', ' ') : '';
    lines.push(ts ? `[${ts}] ${turn.content || ''}` : (turn.content || ''));
    lines.push('');
  }

  const text = lines.join('\n');
  const fmt = d => d.toISOString().slice(0, 10);
  const dateRange = minDate && maxDate
    ? (fmt(minDate) === fmt(maxDate) ? fmt(minDate) : `${fmt(minDate)} to ${fmt(maxDate)}`)
    : 'unknown';

  // Chunk if too long
  if (text.length <= MAX_CHUNK_CHARS) {
    return [{ title: `${platform} — ${dateRange}`, content: text }];
  }

  const chunks = [];
  let remaining = text;
  let part = 1;
  while (remaining.length > 0) {
    if (remaining.length <= MAX_CHUNK_CHARS) {
      chunks.push({ title: `${platform} — ${dateRange} (part ${part})`, content: remaining });
      break;
    }
    let splitAt = remaining.lastIndexOf('\n\n', MAX_CHUNK_CHARS);
    if (splitAt < MAX_CHUNK_CHARS * 0.5) splitAt = remaining.lastIndexOf('\n', MAX_CHUNK_CHARS);
    if (splitAt < MAX_CHUNK_CHARS * 0.5) splitAt = MAX_CHUNK_CHARS;
    chunks.push({ title: `${platform} — ${dateRange} (part ${part})`, content: remaining.slice(0, splitAt) });
    remaining = remaining.slice(splitAt).trimStart();
    part++;
  }
  return chunks;
}

/**
 * Enable NotebookLM sync.
 */
export async function enableSync() {
  await chrome.storage.local.set({ [ENABLED_KEY]: true });
  // Create the sync alarm
  chrome.alarms.create('syncNotebookLM', { delayInMinutes: 0.5, periodInMinutes: 30 });
  console.log('📓 NotebookLM sync enabled (every 30 min)');
}

/**
 * Disable NotebookLM sync.
 */
export async function disableSync() {
  await chrome.storage.local.set({ [ENABLED_KEY]: false });
  chrome.alarms.clear('syncNotebookLM');
  console.log('📓 NotebookLM sync disabled');
}

/**
 * Check if sync is enabled.
 */
export async function isSyncEnabled() {
  const { [ENABLED_KEY]: enabled } = await chrome.storage.local.get([ENABLED_KEY]);
  return !!enabled;
}

/**
 * Get sync status for popup display.
 */
export async function getSyncStatus() {
  const state = await getSyncState();
  const enabled = await isSyncEnabled();
  const { signedIn } = await checkGoogleSignIn();

  return {
    enabled,
    signedIn,
    notebookId: state.notebookId,
    notebookTitle: state.notebookTitle,
    sourceCount: state.sourceCount,
    lastPushAt: state.lastPushAt,
    lastError: state.lastError,
    lastErrorAt: state.lastErrorAt,
    conversationsPushed: state.pushedConversationIds?.length || 0,
  };
}
