/**
 * Background Conversation Poller
 *
 * Fetches new conversations from ChatGPT, Claude, and Gemini APIs in the
 * background using chrome.cookies — no browser tab needed. Phone/app
 * conversations appear in K.Y.T. within 15-25 minutes automatically.
 *
 * Gemini uses Google's batchexecute protocol (RPC ID: MaZiqc for conversation
 * list, hNvQHb for detail). Auth tokens (XSRF, build label) extracted from
 * homepage HTML, cached with 30-min TTL.
 *
 * On first run, imports 90 days of history (paginated, 20 conversations/page).
 *
 * IMPORTANT (MV3): All imports must be static. No dynamic import().
 */

import { syncViaEdgeFunction } from './edge-sync.js';
import { getMemoryMode } from './memory-mode.js';
import { getGeminiAuth, clearGeminiAuthCache, fetchConversationsSince, callBatchExecute } from './gemini-auth.js';

// ── Storage Keys ─────────────────────────────────────────────

const POLLER_STATE_KEY = 'kyt_poller_state';

/** @returns {Promise<Object>} Platform poll states */
async function loadState() {
  const { [POLLER_STATE_KEY]: state } = await chrome.storage.local.get(POLLER_STATE_KEY);
  return state || {};
}

function defaultPlatformState() {
  return {
    lastPollAt: null,
    lastSuccessAt: null,
    lastUpdateTime: null,    // Platform-native timestamp of newest conversation seen
    consecutiveFailures: 0,
    backoffUntil: null,
    lastError: null,
    totalPolled: 0,
    totalNewTurns: 0,
  };
}

async function savePlatformState(platform, updates) {
  const state = await loadState();
  state[platform] = { ...(state[platform] || defaultPlatformState()), ...updates };
  await chrome.storage.local.set({ [POLLER_STATE_KEY]: state });
}

// ── Backoff ──────────────────────────────────────────────────

function calculateBackoff(failures, baseMinutes = 5, maxMinutes = 480) {
  return Math.min(Math.pow(2, failures) * baseMinutes, maxMinutes);
}

function isInBackoff(platformState) {
  if (!platformState?.backoffUntil) return false;
  return Date.now() < platformState.backoffUntil;
}

// ── ChatGPT Poller ───────────────────────────────────────────

const CHATGPT_BASE = 'https://chatgpt.com';
const CHATGPT_LIMIT = 20;

async function getChatGPTCookies() {
  const cookies = await chrome.cookies.getAll({ url: CHATGPT_BASE });
  if (cookies.length === 0) throw new Error('NO_CHATGPT_COOKIES');
  return cookies.map(c => `${c.name}=${c.value}`).join('; ');
}

async function getChatGPTAccessToken(cookieHeader) {
  const res = await fetch(`${CHATGPT_BASE}/api/auth/session`, {
    headers: { 'Cookie': cookieHeader },
  });
  if (!res.ok) throw new Error(`CHATGPT_AUTH_${res.status}`);
  const data = await res.json();
  if (!data.accessToken) throw new Error('CHATGPT_NO_TOKEN');
  return data.accessToken;
}

/**
 * Parse ChatGPT conversation mapping into messages.
 * Replicates logic from history-import/chatgpt-fetcher.js:parseConversation()
 * and platforms/chatgpt/inject.js:extractTextFromParts()
 */
function parseChatGPTConversation(data, title) {
  const messages = [];
  const mapping = data.mapping;
  if (!mapping) return messages;

  for (const nodeId in mapping) {
    const node = mapping[nodeId];
    const msg = node.message;
    if (!msg) continue;

    const role = msg.author?.role;
    if (role !== 'user' && role !== 'assistant') continue;
    if (msg.metadata?.is_visually_hidden_from_conversation) continue;
    if (msg.metadata?.is_user_system_message) continue;

    const parts = msg.content?.parts;
    if (!Array.isArray(parts) || parts.length === 0) continue;

    // Extract text, handling audio transcription objects
    const texts = [];
    for (const part of parts) {
      if (typeof part === 'string') {
        if (part.startsWith('{') && part.includes('content_type')) {
          try {
            const obj = JSON.parse(part);
            if (obj.content_type === 'audio_transcription' && obj.text) {
              texts.push(obj.text);
              continue;
            }
            if (obj.content_type && obj.content_type !== 'text') continue;
          } catch { /* not JSON, treat as text */ }
        }
        if (part.trim().length > 0) texts.push(part);
      } else if (part && typeof part === 'object') {
        if (part.content_type === 'audio_transcription' && part.text) {
          texts.push(part.text);
        } else if (part.content_type === 'text' && part.text) {
          texts.push(part.text);
        }
        // Skip audio_asset_pointer and other non-text objects
      }
    }

    const content = texts.join('\n\n').trim();
    if (!content) continue;

    // Timestamp: seconds → ms if needed
    let ts = msg.create_time || data.create_time || 0;
    if (typeof ts === 'number' && ts > 0 && ts < 10000000000) ts *= 1000;

    messages.push({
      id: msg.id || nodeId,
      conversationId: data.id || data.conversation_id,
      conversationTitle: title || data.title || 'Untitled',
      content,
      role,
      timestamp: ts,
      platform: 'chatgpt',
      model: msg.metadata?.model_slug,
    });
  }

  return messages.sort((a, b) => a.timestamp - b.timestamp);
}

async function pollChatGPT(platformState) {
  const cookieHeader = await getChatGPTCookies();
  const accessToken = await getChatGPTAccessToken(cookieHeader);

  const headers = {
    'Authorization': `Bearer ${accessToken}`,
    'Cookie': cookieHeader,
  };

  // Fetch conversation list (newest first)
  const listRes = await fetch(
    `${CHATGPT_BASE}/backend-api/conversations?offset=0&limit=${CHATGPT_LIMIT}&order=updated`,
    { headers }
  );
  if (!listRes.ok) throw new Error(`CHATGPT_LIST_${listRes.status}`);
  const listData = await listRes.json();
  const conversations = listData.items || [];

  if (conversations.length === 0) return { newTurns: 0, conversationsChecked: 0 };

  let newTurns = 0;
  let conversationsChecked = 0;
  let newestUpdateTime = platformState.lastUpdateTime;

  for (const conv of conversations) {
    // Normalize update_time to ms
    let updateTime = conv.update_time;
    if (typeof updateTime === 'number' && updateTime < 10000000000) updateTime *= 1000;

    // Stop when we reach conversations older than our checkpoint
    if (platformState.lastUpdateTime && updateTime <= platformState.lastUpdateTime) {
      break;
    }

    // Track newest for checkpoint
    if (!newestUpdateTime || updateTime > newestUpdateTime) {
      newestUpdateTime = updateTime;
    }

    // Fetch full conversation
    try {
      const convRes = await fetch(
        `${CHATGPT_BASE}/backend-api/conversation/${conv.id}`,
        { headers }
      );
      if (!convRes.ok) {
        console.warn(`⚠️ [Poller] ChatGPT conversation ${conv.id} fetch failed: ${convRes.status}`);
        continue;
      }
      const convData = await convRes.json();
      const messages = parseChatGPTConversation(convData, conv.title);

      if (messages.length > 0) {
        await syncViaEdgeFunction(messages);
        newTurns += messages.length;
      }
      conversationsChecked++;

      // Rate limit: 1s between conversation fetches
      await new Promise(r => setTimeout(r, 1000));
    } catch (err) {
      console.warn(`⚠️ [Poller] ChatGPT conversation ${conv.id} error:`, err.message);
    }

    // Save checkpoint after each conversation (MV3 resilience)
    await savePlatformState('chatgpt', { lastUpdateTime: newestUpdateTime });
  }

  return { newTurns, conversationsChecked, lastUpdateTime: newestUpdateTime };
}

// ── Claude Poller ────────────────────────────────────────────

const CLAUDE_BASE = 'https://claude.ai';

async function getClaudeCookies() {
  const cookies = await chrome.cookies.getAll({ url: CLAUDE_BASE });
  if (cookies.length === 0) throw new Error('NO_CLAUDE_COOKIES');
  return cookies.map(c => `${c.name}=${c.value}`).join('; ');
}

async function getClaudeOrgId(cookieHeader) {
  const res = await fetch(`${CLAUDE_BASE}/api/organizations`, {
    headers: { 'Cookie': cookieHeader },
  });
  if (!res.ok) throw new Error(`CLAUDE_ORG_${res.status}`);
  const orgs = await res.json();
  if (!Array.isArray(orgs) || orgs.length === 0) throw new Error('CLAUDE_NO_ORGS');
  return orgs[0].uuid;
}

async function pollClaude(platformState) {
  const cookieHeader = await getClaudeCookies();
  const orgId = await getClaudeOrgId(cookieHeader);
  const headers = { 'Cookie': cookieHeader };

  // Fetch conversation list
  const listRes = await fetch(
    `${CLAUDE_BASE}/api/organizations/${orgId}/chat_conversations`,
    { headers }
  );
  if (!listRes.ok) throw new Error(`CLAUDE_LIST_${listRes.status}`);
  const conversations = await listRes.json();

  if (!Array.isArray(conversations) || conversations.length === 0) {
    return { newTurns: 0, conversationsChecked: 0 };
  }

  let newTurns = 0;
  let conversationsChecked = 0;
  let newestUpdateTime = platformState.lastUpdateTime;

  for (const conv of conversations) {
    const updatedAt = new Date(conv.updated_at).getTime();

    // Skip if older than checkpoint
    if (platformState.lastUpdateTime && updatedAt <= platformState.lastUpdateTime) {
      continue;
    }

    if (!newestUpdateTime || updatedAt > newestUpdateTime) {
      newestUpdateTime = updatedAt;
    }

    // Fetch full conversation
    try {
      const convRes = await fetch(
        `${CLAUDE_BASE}/api/organizations/${orgId}/chat_conversations/${conv.uuid}`,
        { headers }
      );
      if (!convRes.ok) {
        console.warn(`⚠️ [Poller] Claude conversation ${conv.uuid} fetch failed: ${convRes.status}`);
        continue;
      }
      const convData = await convRes.json();
      const chatMessages = convData.chat_messages || [];

      const messages = chatMessages
        .filter(m => m.text && m.text.trim().length > 0)
        .map(m => ({
          id: m.uuid,
          conversationId: conv.uuid,
          conversationTitle: conv.name || 'Untitled',
          content: m.text.trim(),
          role: m.sender === 'human' ? 'user' : 'assistant',
          timestamp: new Date(m.created_at).getTime(),
          platform: 'claude',
        }));

      if (messages.length > 0) {
        await syncViaEdgeFunction(messages);
        newTurns += messages.length;
      }
      conversationsChecked++;

      // Rate limit: 1.5s between conversation fetches (Claude is stricter)
      await new Promise(r => setTimeout(r, 1500));
    } catch (err) {
      console.warn(`⚠️ [Poller] Claude conversation ${conv.uuid} error:`, err.message);
    }

    // Save checkpoint after each conversation
    await savePlatformState('claude', { lastUpdateTime: newestUpdateTime });
  }

  return { newTurns, conversationsChecked, lastUpdateTime: newestUpdateTime };
}

// ── Gemini Poller ───────────────────────────────────────────

// Conversation detail RPC — fetches full message history for a conversation.
// Response parsed by extractConversationMessages() pattern from content_test.js.
const GEMINI_CONV_DETAIL_RPC = 'hNvQHb';

async function pollGemini(ps) {
  // 1. Get auth (cookies + XSRF + build label)
  let auth;
  try {
    auth = await getGeminiAuth();
  } catch (e) {
    throw new Error(`NO_GEMINI_COOKIES`);
  }

  // 2. Determine cutoff: first run = 90 days ago, subsequent = last checkpoint
  const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;
  const cutoffMs = ps.lastUpdateTime || (Date.now() - NINETY_DAYS_MS);
  const isInitialImport = !ps.lastUpdateTime;

  if (isInitialImport) {
    console.log('📥 [Poller] gemini: initial 90-day import starting');
  }

  // 3. Fetch conversation list (paginated, stops at cutoff)
  const conversations = await fetchConversationsSince(auth, cutoffMs);

  if (conversations.length === 0) {
    return { conversationsChecked: 0, newTurns: 0, lastUpdateTime: ps.lastUpdateTime };
  }

  // 4. For each conversation, fetch messages and sync
  let totalNewTurns = 0;
  let newestTimestamp = ps.lastUpdateTime || 0;

  for (const conv of conversations) {
    try {
      // Fetch conversation detail via batchexecute
      const messages = await fetchGeminiConversationDetail(auth, conv.id);

      if (messages.length > 0) {
        // Sync to Supabase
        const turns = messages.map(m => ({
          content: m.content,
          role: m.role,
          platform: 'gemini',
          conversation_id: conv.id,
          timestamp: m.timestamp || conv.timestamp,
        }));

        await syncViaEdgeFunction(turns);
        totalNewTurns += turns.length;
      }

      // Update checkpoint
      newestTimestamp = Math.max(newestTimestamp, conv.timestamp);

      // Rate limit: 2s between conversations (Google is strict)
      await new Promise(r => setTimeout(r, 2000));

    } catch (convErr) {
      console.warn(`⚠️ [Poller] gemini: failed to fetch conversation ${conv.id}: ${convErr.message}`);
      // Continue with other conversations
    }
  }

  return {
    conversationsChecked: conversations.length,
    newTurns: totalNewTurns,
    lastUpdateTime: newestTimestamp,
  };
}

/**
 * Fetch full message history for a single Gemini conversation.
 * Uses the hNvQHb RPC to get conversation detail.
 *
 * @param {object} auth - Auth context from getGeminiAuth()
 * @param {string} conversationId - Gemini conversation ID (c_<hex>)
 * @returns {Promise<Array<{content: string, role: string, timestamp: number}>>}
 */
async function fetchGeminiConversationDetail(auth, conversationId) {
  // The conversation detail RPC takes the conversation ID as a parameter
  const params = [null, null, conversationId];
  const data = await callBatchExecute(GEMINI_CONV_DETAIL_RPC, params, auth);

  if (!data) return [];

  // Extract messages from the response structure.
  // The response format for hNvQHb has turn data at various positions.
  // Walk the nested arrays to find user/assistant message pairs.
  const messages = [];

  try {
    // Conversation turns are typically in data[0][2] or data[4]
    const turns = findConversationTurns(data);

    for (const turn of turns) {
      // User message: typically at turn[2][0][0] or turn[0]
      const userText = extractTurnText(turn, 'user');
      if (userText) {
        messages.push({ content: userText, role: 'user', timestamp: null });
      }

      // Assistant response: typically at turn[3][0][0][1][0] or turn[1]
      const assistantText = extractTurnText(turn, 'assistant');
      if (assistantText) {
        messages.push({ content: assistantText, role: 'assistant', timestamp: null });
      }
    }
  } catch (e) {
    console.warn(`⚠️ Gemini conversation parse error: ${e.message}`);
    // Fallback: extract all long strings as potential message content
    const fallbackMessages = extractStringsHeuristic(data);
    messages.push(...fallbackMessages);
  }

  return messages;
}

/**
 * Find conversation turns in the nested Gemini response structure.
 * The exact positions vary by response format.
 */
function findConversationTurns(data) {
  // Try known positions for turn arrays
  if (Array.isArray(data?.[0]?.[2])) return data[0][2];
  if (Array.isArray(data?.[4])) return data[4];
  if (Array.isArray(data?.[0]?.[0]?.[2])) return data[0][0][2];
  // Walk looking for arrays of arrays (turns are typically arrays of 4+ elements)
  return walkForTurns(data, 0) || [];
}

function walkForTurns(obj, depth) {
  if (depth > 5 || !Array.isArray(obj)) return null;
  // A turns array is an array of arrays where each inner array has 4+ elements
  if (obj.length >= 2 && obj.every(item => Array.isArray(item) && item.length >= 3)) {
    return obj;
  }
  for (const item of obj) {
    const result = walkForTurns(item, depth + 1);
    if (result) return result;
  }
  return null;
}

/**
 * Extract text content from a turn for a given role.
 */
function extractTurnText(turn, role) {
  try {
    if (role === 'user') {
      // Position [2][0][0] is common for user text
      if (typeof turn?.[2]?.[0]?.[0] === 'string') return turn[2][0][0];
      // Position [0] direct
      if (typeof turn?.[0] === 'string' && turn[0].length > 5) return turn[0];
    } else {
      // Position [3][0][0][1][0] is common for assistant text
      if (typeof turn?.[3]?.[0]?.[0]?.[1]?.[0] === 'string') return turn[3][0][0][1][0];
      // Position [1] direct
      if (typeof turn?.[1] === 'string' && turn[1].length > 5) return turn[1];
    }
  } catch { /* structure mismatch */ }
  return null;
}

/**
 * Fallback: extract all strings > 20 chars from nested structure.
 * Assigns alternating user/assistant roles (heuristic).
 */
function extractStringsHeuristic(data) {
  const strings = [];
  function walk(obj, depth) {
    if (depth > 8) return;
    if (typeof obj === 'string' && obj.length > 20 && !obj.match(/^[a-f0-9-]{20,}$/)) {
      strings.push(obj);
    }
    if (Array.isArray(obj)) {
      for (const item of obj) walk(item, depth + 1);
    }
  }
  walk(data, 0);

  return strings.map((s, i) => ({
    content: s,
    role: i % 2 === 0 ? 'user' : 'assistant',
    timestamp: null,
  }));
}

// ── Orchestration ────────────────────────────────────────────

const PLATFORM_MAP = {
  pollChatGPT: { platform: 'chatgpt', fn: pollChatGPT },
  pollClaude:  { platform: 'claude',  fn: pollClaude },
  pollGemini:  { platform: 'gemini',  fn: pollGemini },
};

/**
 * Handle a poll alarm. Called from background.js alarm handler.
 * @param {string} alarmName - 'pollChatGPT' or 'pollClaude'
 */
export async function handlePollAlarm(alarmName) {
  const entry = PLATFORM_MAP[alarmName];
  if (!entry) return;

  const { platform, fn } = entry;

  // Gate: memory mode
  const mode = await getMemoryMode();
  if (mode === 'incognito') {
    console.log(`🔕 [Poller] ${platform}: skipped (incognito mode)`);
    return;
  }

  // Gate: K.Y.T. auth
  const { auth_session } = await chrome.storage.local.get('auth_session');
  if (!auth_session?.user?.id) {
    console.log(`🔕 [Poller] ${platform}: skipped (not authenticated)`);
    return;
  }

  // Load state
  const state = await loadState();
  const ps = state[platform] || defaultPlatformState();

  // Gate: backoff
  if (isInBackoff(ps)) {
    const remaining = Math.ceil((ps.backoffUntil - Date.now()) / 60000);
    console.log(`🔕 [Poller] ${platform}: skipped (backoff, ${remaining}m remaining)`);
    return;
  }

  console.log(`🔄 [Poller] ${platform}: polling (last success: ${ps.lastSuccessAt ? new Date(ps.lastSuccessAt).toISOString() : 'never'})`);

  try {
    const result = await fn(ps);

    // Success
    await savePlatformState(platform, {
      lastPollAt: Date.now(),
      lastSuccessAt: Date.now(),
      lastUpdateTime: result.lastUpdateTime || ps.lastUpdateTime,
      consecutiveFailures: 0,
      backoffUntil: null,
      lastError: null,
      totalPolled: (ps.totalPolled || 0) + result.conversationsChecked,
      totalNewTurns: (ps.totalNewTurns || 0) + result.newTurns,
    });

    if (result.newTurns > 0) {
      console.log(`✅ [Poller] ${platform}: ${result.newTurns} new turns from ${result.conversationsChecked} conversations`);
    } else {
      console.log(`✅ [Poller] ${platform}: up to date (checked ${result.conversationsChecked} conversations)`);
    }

  } catch (err) {
    const failures = (ps.consecutiveFailures || 0) + 1;
    const errMsg = err.message || 'unknown';

    // Determine backoff
    let backoffMinutes;
    if (errMsg.includes('401') || errMsg.includes('403') || errMsg.includes('AUTH')) {
      backoffMinutes = 60; // Auth failure: long backoff
    } else if (errMsg.includes('429')) {
      backoffMinutes = platform === 'claude' ? 30 : 15; // Rate limit
    } else {
      backoffMinutes = calculateBackoff(failures); // Exponential
    }

    await savePlatformState(platform, {
      lastPollAt: Date.now(),
      consecutiveFailures: failures,
      backoffUntil: Date.now() + backoffMinutes * 60000,
      lastError: errMsg,
    });

    console.warn(`❌ [Poller] ${platform}: ${errMsg} (failure #${failures}, backoff ${backoffMinutes}m)`);
  }
}

/**
 * Get poller status for debugging.
 * @returns {Promise<Object>}
 */
export async function getPollerStatus() {
  const state = await loadState();
  const result = {};
  for (const platform of ['chatgpt', 'claude']) {
    const ps = state[platform] || defaultPlatformState();
    result[platform] = {
      ...ps,
      lastPollAt: ps.lastPollAt ? new Date(ps.lastPollAt).toISOString() : null,
      lastSuccessAt: ps.lastSuccessAt ? new Date(ps.lastSuccessAt).toISOString() : null,
      backoffUntil: ps.backoffUntil ? new Date(ps.backoffUntil).toISOString() : null,
      inBackoff: isInBackoff(ps),
    };
  }
  return result;
}

/**
 * Manually trigger a poll for testing.
 * @param {string} platform - 'chatgpt' or 'claude'
 */
export async function pollPlatformNow(platform) {
  const alarmName = platform === 'chatgpt' ? 'pollChatGPT' : platform === 'claude' ? 'pollClaude' : null;
  if (!alarmName) return `Unknown platform: ${platform}`;
  await handlePollAlarm(alarmName);
  return `Poll complete for ${platform}. Check console for results.`;
}
