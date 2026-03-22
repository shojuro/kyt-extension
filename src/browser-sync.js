/**
 * KYT Day 2: Browser-Compatible Sync Module
 *
 * Syncs messages from Chrome storage to Supabase with OpenAI embeddings
 * Uses fetch() and chrome.storage APIs (works in extension context)
 *
 * Phase 5: Dual-write strategy
 * - Syncs to 'messages' table (existing, message-level)
 * - Syncs to 'chat_turns' table (new, conversation-turn chunks)
 *
 * Phase 8: HyDE Preprocessing
 * - Generates hypothetical questions for turn chunks
 * - Improves retrieval quality with question-based indexing
 */

import { messagesToTurnChunks } from './conversation-chunker.js';
import { generateHypotheticalQuestions } from './hyde-preprocessor.js';
import {
  isEmbeddingCircuitOpen,
  recordEmbeddingSuccess,
  recordEmbeddingFailure
} from './embedding-circuit-breaker.js';
import { fetchWithTimeout } from './utils/fetch.js';
import { normalizePlatform } from './utils/normalize-platform.js';
import { callEdgeFunction } from './api-client.js';
import { getActiveProfileId } from './profile-manager.js';
import { refreshSession } from './auth/auth-service.js';

// Defensive flag: set after first error indicating profile_id column doesn't exist on chat_turns.
// Once set, all subsequent syncs skip profile_id for this SW lifecycle.
let _syncProfileIdUnavailable = false;

// SYNC LOCK: Prevent race conditions when multiple syncs happen in parallel
let syncInProgress = false;

// API timeout settings (prevent Chrome message channel timeout)
const SYNC_API_TIMEOUT_MS = 30000; // 30 seconds for sync (batch operations need more time)

/**
 * Get API configuration from chrome.storage
 * @returns {Promise<Object>} Configuration object
 */
async function getConfig() {
  const result = await chrome.storage.local.get(['api_config', 'user_id', 'auth_session']);
  if (!result.api_config) {
    throw new Error('API configuration not found. Please set up API keys first.');
  }
  const config = result.api_config;
  const session = result.auth_session;
  const nowSec = Math.floor(Date.now() / 1000);

  // Proactive refresh if token expired or within 5min of expiry
  if (session?.access_token && session.refresh_token &&
      session.expires_at <= nowSec + 300) {
    try {
      const refreshed = await refreshSession(session.refresh_token);
      config.accessToken = refreshed.access_token;
      config.refreshToken = refreshed.refresh_token;
      config.userId = refreshed.user?.id || result.user_id || null;
      return config;
    } catch (e) {
      console.warn('Token refresh failed in getConfig:', e.message);
    }
  }

  // IMPORTANT: When a valid JWT session exists, ALWAYS use its user_id.
  // auth.uid() in RLS resolves from the JWT, so config.userId must match.
  // Legacy api_config.userId may differ (e.g. old test user) — override it.
  const authUserId = session?.user?.id;
  const storedUserId = result.user_id;
  if (session?.access_token && session.expires_at > nowSec && authUserId) {
    config.userId = authUserId;
  } else {
    config.userId = config.userId || authUserId || storedUserId || null;
  }
  config.accessToken = session?.access_token || null;
  config.refreshToken = session?.refresh_token || null;

  console.log(`🔑 Sync config: userId=${config.userId || 'NULL'}, auth=${config.accessToken ? 'jwt' : 'anon'}, sessionUser=${session?.user?.id || 'none'}, expires=${session?.expires_at ? new Date(session.expires_at * 1000).toISOString() : 'none'}`);
  return config;
}

/**
 * Build auth headers for Supabase REST calls.
 * Uses JWT access_token when available (enables auth.uid() RLS policies).
 */
function getAuthHeaders(config) {
  return {
    'Content-Type': 'application/json',
    'apikey': config.supabaseKey,
    'Authorization': `Bearer ${config.accessToken || config.supabaseKey}`,
  };
}

/**
 * Refresh the JWT in config by calling auth-service refreshSession().
 * Updates config in-place and returns true on success.
 */
async function refreshConfigToken(config) {
  if (!config.refreshToken) return false;
  try {
    const session = await refreshSession(config.refreshToken);
    config.accessToken = session.access_token;
    config.refreshToken = session.refresh_token;
    return true;
  } catch (err) {
    console.warn('Token refresh failed during 401 retry:', err.message);
    return false;
  }
}

/**
 * Fetch with automatic 401 retry. On 401, refreshes JWT and retries once.
 * @param {string} url
 * @param {Object} config - API config (mutated on refresh)
 * @param {Object} fetchOptions - fetch options (without auth headers)
 * @returns {Promise<Response>}
 */
async function fetchWithAuthRetry(url, config, fetchOptions) {
  const res = await fetch(url, {
    ...fetchOptions,
    headers: { ...getAuthHeaders(config), ...fetchOptions.headers },
  });

  if (res.status === 401) {
    const refreshed = await refreshConfigToken(config);
    if (refreshed) {
      return fetch(url, {
        ...fetchOptions,
        headers: { ...getAuthHeaders(config), ...fetchOptions.headers },
      });
    }
  }

  return res;
}

/**
 * Estimate tokens for text (rough approximation: 1 token ≈ 4 chars)
 * @param {string} text - Text to estimate
 * @returns {number} Estimated token count
 */
function estimateTokens(text) {
  return Math.ceil((text?.length || 0) / 4);
}

/**
 * Batch texts by token limit (not count) to avoid OpenAI API errors
 * @param {string[]} texts - Array of message contents
 * @param {number} maxTokensPerBatch - Max tokens per batch (default 8000 with safety buffer)
 * @returns {string[][]} Array of batches
 */
function batchByTokens(texts, maxTokensPerBatch = 8000) {
  const batches = [];
  let currentBatch = [];
  let currentTokens = 0;

  for (const text of texts) {
    const textTokens = estimateTokens(text);

    // If single message exceeds limit, truncate it
    if (textTokens > maxTokensPerBatch) {
      console.warn(`⚠️ Message too long (${textTokens} tokens), truncating to ${maxTokensPerBatch} tokens`);
      const truncated = text.substring(0, maxTokensPerBatch * 4);

      // Start new batch if current has content
      if (currentBatch.length > 0) {
        batches.push(currentBatch);
        currentBatch = [];
        currentTokens = 0;
      }

      batches.push([truncated]);
      continue;
    }

    // If adding this text would exceed limit, start new batch
    if (currentTokens + textTokens > maxTokensPerBatch && currentBatch.length > 0) {
      batches.push(currentBatch);
      currentBatch = [];
      currentTokens = 0;
      currentTokens = 0;
    }

    currentBatch.push(text);
    currentTokens += textTokens;
  }

  // Push remaining batch
  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }

  return batches;
}

/**
 * Generate embeddings via server-side edge function (HF key stays server-side).
 * Produces 1024-dimensional Matryoshka-truncated Qwen3 embeddings.
 *
 * @param {string[]} texts - Array of message content strings
 * @param {string} _apiKey - Unused (kept for backward compatibility)
 * @returns {Promise<number[][]>} Array of 1024-dimensional embeddings
 * @throws {Error} If circuit breaker is open or API fails
 */
async function generateEmbeddings(texts, _apiKey) {
  // Check circuit breaker FIRST
  const circuitStatus = await isEmbeddingCircuitOpen();
  if (circuitStatus.open) {
    throw new Error(`Embedding circuit breaker open: ${circuitStatus.reason}`);
  }

  const allEmbeddings = [];
  const batches = batchByTokens(texts, 4000);

  console.log(`Generating embeddings via edge function: ${batches.length} batches for ${texts.length} messages`);

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    console.log(`   Batch ${i + 1}/${batches.length}: ${batch.length} texts`);

    try {
      const result = await callEdgeFunction('generate_embeddings', {
        texts: batch,
      }, { timeoutMs: SYNC_API_TIMEOUT_MS });

      if (!result.embeddings || !Array.isArray(result.embeddings)) {
        throw new Error('Unexpected response format from generate_embeddings');
      }

      await recordEmbeddingSuccess();
      allEmbeddings.push(...result.embeddings);
    } catch (err) {
      await recordEmbeddingFailure(0, err.message);
      throw err;
    }

    // Rate limit protection between batches
    if (i < batches.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }

  return allEmbeddings;
}

/**
 * Query existing message IDs from Supabase (single request for small sets)
 * Used when message count is <= 50 to avoid chunking overhead
 *
 * @param {string[]} messageIds - Array of message IDs to check
 * @param {Object} config - API configuration with supabaseUrl and supabaseKey
 * @returns {Promise<Set<string>>} Set of existing message IDs in database
 */
async function queryExistingIdsSingle(messageIds, config) {
  if (messageIds.length === 0) {
    return new Set();
  }

  const quotedIds = messageIds.map(id => `"${id}"`).join(',');
  const response = await fetchWithTimeout(
    `${config.supabaseUrl}/rest/v1/messages?message_id=in.(${quotedIds})&select=message_id`,
    {
      headers: getAuthHeaders(config)
    },
    10000 // 10 second timeout for this check
  );

  if (!response.ok) {
    throw new Error(`DB query failed: ${response.status}`);
  }

  const data = await response.json();
  return new Set(data.map(m => m.message_id));
}

/**
 * Query existing message IDs from Supabase in chunks
 * Prevents URL length overflow with large message sets (50 IDs per chunk)
 *
 * @param {string[]} messageIds - Array of message IDs to check
 * @param {Object} config - API configuration with supabaseUrl and supabaseKey
 * @param {number} chunkSize - Max IDs per request (default 50)
 * @returns {Promise<Set<string>>} Set of existing message IDs in database
 */
async function queryExistingIdsChunked(messageIds, config, chunkSize = 50) {
  const existingIds = new Set();

  for (let i = 0; i < messageIds.length; i += chunkSize) {
    const chunk = messageIds.slice(i, i + chunkSize);
    const quotedIds = chunk.map(id => `"${id}"`).join(',');

    try {
      const response = await fetchWithTimeout(
        `${config.supabaseUrl}/rest/v1/messages?message_id=in.(${quotedIds})&select=message_id`,
        {
          headers: getAuthHeaders(config)
        },
        10000 // 10 second timeout per chunk
      );

      if (response.ok) {
        const data = await response.json();
        data.forEach(m => existingIds.add(m.message_id));
      } else {
        console.warn(`⚠️ Chunk ${Math.floor(i / chunkSize) + 1} query failed: ${response.status}`);
        // Continue with other chunks - partial data is better than none
      }
    } catch (chunkError) {
      console.warn(`⚠️ Chunk ${Math.floor(i / chunkSize) + 1} error:`, chunkError.message);
      // Continue with other chunks
    }

    // Small delay between chunks to avoid rate limiting
    if (i + chunkSize < messageIds.length) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  return existingIds;
}

/**
 * Get messages that need syncing using database-first approach
 *
 * ARCHITECTURE FIX: Replaces stale local syncedMessageIds cache with direct DB queries
 *
 * Problem solved:
 * - Previous implementation used local syncedMessageIds that accumulated forever
 * - Same API message IDs (e.g., from Claude) caused false "already synced" detection
 * - Result: Messages lost when page refreshed and same conversation re-captured
 *
 * Solution:
 * - Pre-filter by timestamp for performance (only check recent messages)
 * - Query Supabase directly to check which messages actually exist
 * - Use chunked queries to avoid URL length limits (50 IDs per request)
 * - Safe fallback: if DB unreachable, send all and let Supabase upsert handle duplicates
 *
 * @returns {Promise<Object[]>} Messages to sync
 */
async function getMessagesToSync() {
  const result = await chrome.storage.local.get([
    'captured_messages',
    'last_successful_sync_time'
  ]);

  const allMessages = result.captured_messages || [];

  if (allMessages.length === 0) {
    console.log('📦 No local messages to sync');
    return [];
  }

  // Defensive: Prevent future timestamps from blocking all syncs
  const now = Date.now();
  const lastSyncTime = Math.min(
    result.last_successful_sync_time || 0,
    now
  );

  // Pre-filter by timestamp + validate messageId (INSIDE callback for correct scoping)
  // Use >= (not >) to avoid skipping messages saved in the same millisecond as the cursor.
  // Dedup: exclude IDs from the last sync batch to prevent re-syncing the boundary messages.
  const lastSyncedIds = new Set(result.last_sync_status?.lastSyncedMessageIds || []);
  const candidateMessages = allMessages.filter(msg => {
    if (!msg.messageId) return false;
    if (lastSyncedIds.has(msg.messageId)) return false; // already synced in last batch
    const messageTime = msg.capturedAt ?? msg.timestamp ?? 0;
    return messageTime >= lastSyncTime; // >= not > — prevents timestamp-gap drops
  });

  // Diagnostic: log assistant messages filtered out by timestamp (potential sync gap victims)
  const skippedByTimestamp = allMessages.filter(msg => {
    if (!msg.messageId) return false;
    if (lastSyncedIds.has(msg.messageId)) return false;
    const messageTime = msg.capturedAt ?? msg.timestamp ?? 0;
    return messageTime < lastSyncTime && msg.role === 'assistant';
  });
  if (skippedByTimestamp.length > 0) {
    console.warn(`⚠️ ${skippedByTimestamp.length} assistant message(s) behind sync cursor:`,
      skippedByTimestamp.map(m => ({
        id: m.messageId?.substring(0, 20),
        capturedAt: m.capturedAt,
        lastSyncTime,
        gap: lastSyncTime - (m.capturedAt ?? 0) + 'ms'
      }))
    );
  }

  if (candidateMessages.length === 0) {
    console.log(`✅ No new messages since last sync (${new Date(lastSyncTime).toISOString()})`);
    return [];
  }

  console.log(`🔍 Checking ${candidateMessages.length} candidates (since ${new Date(lastSyncTime).toISOString()})`);

  try {
    const config = await getConfig();
    const messageIds = candidateMessages.map(m => m.messageId);

    // Fast path for small sets, chunked for large sets
    const existingIds = messageIds.length <= 50
      ? await queryExistingIdsSingle(messageIds, config)
      : await queryExistingIdsChunked(messageIds, config, 50);

    const newMessages = candidateMessages.filter(
      msg => !existingIds.has(msg.messageId)
    );

    console.log(`📦 Found ${newMessages.length} new messages to sync (${existingIds.size} already in DB, ${allMessages.length} total local)`);
    return newMessages;

  } catch (error) {
    console.warn('⚠️ DB check failed, using safe fallback:', error.message);
    // SAFE FALLBACK: Return all candidates, let Supabase upsert handle duplicates
    // This works because we use on_conflict=message_id with merge-duplicates
    console.log(`📦 Fallback: syncing all ${candidateMessages.length} candidates (Supabase will dedupe)`);
    return candidateMessages;
  }
}

/**
 * Sync specific messages to Supabase
 * @param {Object[]} messagesToSync - Array of messages to sync
 * @returns {Promise<Object>} Sync result
 */
export async function syncMessages(messagesToSync) {
  try {
    console.log('🔄 Starting syncMessages...');

    // Get config
    const config = await getConfig();

    // GUARD: Fail fast if no JWT — anon key always triggers RLS violation
    if (!config.accessToken) {
      console.error('🔒 Sync blocked: no JWT access token. User must sign in via setup.html');
      return {
        success: false,
        synced: 0,
        message: 'Not authenticated — sign in required'
      };
    }

    if (!messagesToSync || messagesToSync.length === 0) {
      return {
        success: true,
        synced: 0,
        message: 'No messages to sync'
      };
    }

    // Generate embeddings (graceful degradation: null if unavailable)
    const texts = messagesToSync.map(m => m.content);
    let embeddings;
    let embeddingsAvailable = false;
    try {
      embeddings = await generateEmbeddings(texts, null);
      embeddingsAvailable = true;
    } catch (embeddingError) {
      console.warn(`⚠️ Embeddings unavailable, syncing without: ${embeddingError.message}`);
      embeddings = new Array(texts.length).fill(null);
    }

    // Log platform distribution for diagnostics
    const platformCounts = messagesToSync.reduce((acc, m) => {
      const platform = normalizePlatform(m.platform);
      acc[platform] = (acc[platform] || 0) + 1;
      return acc;
    }, {});
    console.log(`📊 KYT Sync: Syncing ${messagesToSync.length} messages -`, platformCounts);

    // DIAGNOSTIC: Log role distribution and each message's role
    const roleCounts = messagesToSync.reduce((acc, m) => {
      const role = m.role || 'undefined';
      acc[role] = (acc[role] || 0) + 1;
      return acc;
    }, {});
    console.log(`📊 KYT Sync: Role distribution -`, roleCounts);

    // Log each message's role for verification — flag deferred DOM captures
    messagesToSync.forEach((msg, idx) => {
      const isDeferred = msg.source === 'deferred-dom' || msg.captureMethod === 'deferred-dom';
      console.log(`📊 SYNC DEBUG [${idx}]:`, {
        messageId: msg.messageId?.substring(0, 25) || 'no-id',
        role: msg.role || 'MISSING',
        platform: normalizePlatform(msg.platform),
        captureMethod: msg.captureMethod || msg.source || 'unknown',
        content_preview: msg.content?.substring(0, 40) + '...',
        ...(isDeferred ? { FLAG: '🔍 DEFERRED DOM CAPTURE' } : {})
      });
    });

    // P3 fix: Filter out high-confidence deflections before sync
    const deflectionFiltered = messagesToSync.filter(msg => {
      if (msg.deflection >= 0.70) {
        console.log(`🗑️ Sync filter: dropping high-confidence deflection (${msg.deflection.toFixed(2)}): "${msg.content?.substring(0, 40)}..."`);
        return false;
      }
      return true;
    });

    if (deflectionFiltered.length < messagesToSync.length) {
      console.log(`🗑️ Sync filter: dropped ${messagesToSync.length - deflectionFiltered.length} deflection(s), ${deflectionFiltered.length} remaining`);
      // Regenerate embeddings for filtered set
      const filteredTexts = deflectionFiltered.map(m => m.content);
      try {
        embeddings = await generateEmbeddings(filteredTexts, null);
        embeddingsAvailable = true;
      } catch (embeddingError) {
        console.warn(`⚠️ Embeddings unavailable after deflection filter: ${embeddingError.message}`);
        embeddings = new Array(filteredTexts.length).fill(null);
      }
    }

    // Resolve profile ID for this sync batch
    const profileId = await getActiveProfileId() || config.userId || '00000000-0000-0000-0000-000000000000';

    // Prepare data for Supabase
    const messagesWithEmbeddings = deflectionFiltered.map((msg, idx) => ({
      content: msg.content,
      role: msg.role || 'user', // Default to 'user' (DB constraint: user|assistant|system)
      conversation_id: msg.conversationId || null,
      model: msg.model || null,
      timestamp: msg.timestamp || msg.capturedAt,
      message_id: msg.messageId,
      embedding: embeddings[idx],
      source: normalizePlatform(msg.platform),
      user_id: config.userId || '00000000-0000-0000-0000-000000000000', // Add user_id
      synced_from_extension: new Date().toISOString(),
      is_question: msg.is_question || false,
      deflection: msg.deflection || null,
    }));

    // Insert to Supabase (UPSERT for idempotency)
    // Batch inserts to prevent statement timeouts with large payloads
    // Reduced to 5 to handle large "Rescan" payloads without choking Supabase
    const BATCH_SIZE = 5;
    const batches = [];
    for (let i = 0; i < messagesWithEmbeddings.length; i += BATCH_SIZE) {
      batches.push(messagesWithEmbeddings.slice(i, i + BATCH_SIZE));
    }

    let successCount = 0;
    let failCount = 0;

    console.log(`📦 Syncing ${messagesWithEmbeddings.length} messages in ${batches.length} batches...`);

    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];

      // Log roles in this batch
      const batchRoles = batch.map(m => m.role);
      console.log(`   Processing batch ${i + 1}/${batches.length}: ${batch.length} messages, roles: [${batchRoles.join(', ')}]`);

      // Add a small delay between batches to prevent rate limiting/timeouts
      if (i > 0) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }

      const response = await fetchWithAuthRetry(
        `${config.supabaseUrl}/rest/v1/messages?on_conflict=message_id`,
        config,
        {
          method: 'POST',
          headers: { 'Prefer': 'resolution=merge-duplicates,return=representation' },
          body: JSON.stringify(batch)
        }
      );

      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        console.error(`❌ Batch ${i + 1}/${batches.length} failed: ${error.message || response.statusText}`);
        failCount += batch.length;
        continue;
      }

      // Log Supabase response to verify what was actually inserted
      const responseData = await response.json();
      console.log(`   ✅ Batch ${i + 1} response: ${responseData.length} records inserted/updated`);
      if (responseData.length > 0) {
        responseData.forEach((r, j) => {
          console.log(`      [${j}] role=${r.role}, message_id=${r.message_id?.substring(0, 15)}...`);
        });
      }

      successCount += batch.length;
    }

    console.log(`✅ Messages synced to 'messages' table: ${deflectionFiltered.length}`);

    // PHASE 5: Sync to chat_turns table (conversation-turn chunks)
    // Use userId from config or default to temp ID
    const userId = config.userId;
    if (!userId) {
      console.warn('⚠️ No userId available — skipping chat_turns sync');
      return { success: true, synced: successCount, failed: failCount, message: 'Messages synced, chat_turns skipped (no userId)' };
    }

    console.log('📦 Creating conversation-turn chunks...');
    const turnChunks = messagesToTurnChunks(deflectionFiltered, userId);

    if (turnChunks.length > 0) {
      // PHASE 8: HyDE Preprocessing - Generate hypothetical questions
      // This improves retrieval by indexing what users MIGHT ask about the content
      console.log('🔮 Generating hypothetical questions for chunks...');

      const chunksWithHyDE = [];
      for (const chunk of turnChunks) {
        let questions = [];
        try {
          const hydeResult = await generateHypotheticalQuestions(chunk, null, 5);
          questions = hydeResult.success ? hydeResult.questions : [];
        } catch (hydeError) {
          console.warn('⚠️ HyDE generation failed for chunk (skipping questions):', hydeError.message);
        }

        chunksWithHyDE.push({
          ...chunk,
          hypothetical_questions: questions
        });

        // Small delay to avoid rate limits
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      console.log(`✅ HyDE preprocessing complete for ${chunksWithHyDE.length} chunks`);

      // Skip embedding for content-poor chunks (short user-only prompts)
      // These are preserved for history but won't pollute vector search
      const embeddableChunks = [];
      const skipEmbeddingIndexes = new Set();
      for (let i = 0; i < chunksWithHyDE.length; i++) {
        const content = (chunksWithHyDE[i].content || '').trim();
        if (content.length < 100 && !chunksWithHyDE[i].speakers?.includes('assistant')) {
          console.log(`⏭️ Skipping embedding for short user-only chunk: "${content.substring(0, 60)}..."`);
          skipEmbeddingIndexes.add(i);
        } else {
          embeddableChunks.push(chunksWithHyDE[i]);
        }
      }

      // Generate embeddings only for content-rich chunks (graceful degradation: null if unavailable)
      const turnTexts = embeddableChunks.map(chunk => chunk.content);
      let turnEmbeddings;
      try {
        turnEmbeddings = turnTexts.length > 0
          ? await generateEmbeddings(turnTexts, null)
          : [];
      } catch (turnEmbedError) {
        console.warn(`⚠️ Turn embeddings unavailable, syncing without: ${turnEmbedError.message}`);
        turnEmbeddings = new Array(turnTexts.length).fill(null);
      }

      // Reassemble: embeddable chunks get their embeddings, skipped chunks get null
      let embIdx = 0;
      const includeProfileId = !_syncProfileIdUnavailable && profileId;
      const chunksWithEmbeddings = chunksWithHyDE.map((chunk, idx) => {
        const payload = {
          ...chunk,
          embedding: skipEmbeddingIndexes.has(idx) ? null : (turnEmbeddings[embIdx++] || null),
          is_question: chunk.is_question || false,
          deflection: chunk.deflection || null,
          entities_extracted: false,
          preferences_extracted: false,
        };
        if (includeProfileId) {
          payload.profile_id = profileId;
        }
        return payload;
      });

      // Insert to chat_turns table
      let turnsResponse = await fetchWithAuthRetry(
        `${config.supabaseUrl}/rest/v1/chat_turns?on_conflict=user_id,conversation_id,platform,start_timestamp`,
        config,
        {
          method: 'POST',
          headers: { 'Prefer': 'resolution=ignore-duplicates,return=minimal' },
          body: JSON.stringify(chunksWithEmbeddings)
        }
      );

      // Retry without profile_id if column doesn't exist (migration pending)
      if (!turnsResponse.ok && includeProfileId) {
        const turnError = await turnsResponse.json();
        if (turnError.message?.includes('profile_id')) {
          console.warn('⚠️ chat_turns missing profile_id column — retrying without (migration pending)');
          _syncProfileIdUnavailable = true;
          const fallbackChunks = chunksWithEmbeddings.map(c => {
            const { profile_id: _drop, ...rest } = c;
            return rest;
          });
          turnsResponse = await fetchWithAuthRetry(
            `${config.supabaseUrl}/rest/v1/chat_turns?on_conflict=user_id,conversation_id,platform,start_timestamp`,
            config,
            {
              method: 'POST',
              headers: { 'Prefer': 'resolution=ignore-duplicates,return=minimal' },
              body: JSON.stringify(fallbackChunks)
            }
          );
        } else {
          console.warn(`⚠️ Chat turns sync failed: ${turnError.message || turnsResponse.statusText}`);
          console.warn('Continuing with message-level sync only...');
          turnsResponse = null; // skip the ok check below
        }
      }

      if (turnsResponse && !turnsResponse.ok) {
        const turnError = await turnsResponse.json().catch(() => ({}));
        console.warn(`⚠️ Chat turns sync failed: ${turnError.message || turnsResponse.statusText}`);
        console.warn('Continuing with message-level sync only...');
      } else if (turnsResponse) {
        console.log(`✅ Chat turns synced to 'chat_turns' table: ${turnChunks.length} chunks`);

        // Schedule backfill alarm if any chat_turns were synced with null embeddings
        // (circuit breaker tripped, rate limit, missing HF key, etc.)
        const hasNullTurnEmbeddings = turnEmbeddings.some(e => e === null);
        if (hasNullTurnEmbeddings) {
          console.log('⏰ Scheduling backfillEmbeddings alarm (chat_turns have null embeddings)');
          chrome.alarms.create('backfillEmbeddings', { delayInMinutes: 5 });
        }
      }
    } else {
      console.log('📊 No conversation turns created (insufficient messages for chunking)');
    }

    // Update sync status - advance cursor to MAX capturedAt of synced batch (not Date.now()).
    // This prevents messages saved to chrome.storage DURING the sync from falling behind the cursor.
    // Cap to Date.now() to prevent future-timestamp DoS from buggy content scripts.
    const result_sync = await chrome.storage.local.get(['last_successful_sync_time']);
    const previousCursor = result_sync.last_successful_sync_time || 0;
    const maxBatchTimestamp = deflectionFiltered.length > 0
      ? Math.max(...deflectionFiltered.map(m => m.capturedAt ?? m.timestamp ?? 0))
      : previousCursor;
    const syncTimestamp = Math.min(
      Date.now(),                        // SEC: never advance past current time
      Math.max(maxBatchTimestamp, previousCursor)  // never go backward
    );
    await chrome.storage.local.set({
      last_successful_sync_time: syncTimestamp,
      last_sync_status: {
        lastSyncTime: syncTimestamp,
        syncedCount: deflectionFiltered.length,
        // Used by getMessagesToSync to exclude boundary messages (>= filter + ID exclusion)
        lastSyncedMessageIds: deflectionFiltered.slice(-10).map(m => m.messageId)
      }
    });

    const chunkCount = turnChunks.length;
    console.log(`✅ Sync complete: ${deflectionFiltered.length} messages + ${chunkCount} turn chunks (embeddings: ${embeddingsAvailable})`);

    // Entity backfill: trigger server-side entity extraction for synced turn IDs.
    // Fire-and-forget — don't block the sync result.
    // No delay needed: PostgREST commits before responding, so data is available.
    // No setTimeout: unreliable in MV3 (SW may terminate before timer fires).
    // Check pause flag before triggering entity backfill
    chrome.storage.local.get('kyt_backfill_paused', ({ kyt_backfill_paused }) => {
      if (!kyt_backfill_paused) {
        triggerEntityBackfill(config).catch(err =>
          console.warn('⚠️ Entity backfill trigger failed (non-fatal):', err.message)
        );
      } else {
        console.log('⏸️ Entity backfill paused — skipping post-sync trigger');
      }
    });

    return {
      success: true,
      synced: deflectionFiltered.length,
      failed: failCount,
      chunks: chunkCount,
      embeddingsGenerated: embeddingsAvailable,
      message: `Successfully synced ${deflectionFiltered.length} messages + ${chunkCount} turn chunks`
    };

  } catch (error) {
    console.error('❌ Sync failed:', error);
    return {
      success: false,
      synced: 0,
      error: error.message
    };
  }
}

/**
 * Trigger entity extraction backfill for turns without entities.
 * Calls the backfill_entities edge function via callEdgeFunction(),
 * which handles auth internally (JWT → anon key fallback).
 * Fire-and-forget: errors are logged but don't affect sync result.
 *
 * @param {Object} config - API config with supabaseUrl, supabaseKey
 */
async function triggerEntityBackfill(config) {
  console.log('🔗 Triggering entity backfill...');
  try {
    const response = await callEdgeFunction('backfill_entities', {
      limit: 10 // Process up to 10 turns per sync cycle (20 timed out at 30s)
    }, { timeoutMs: 30000 });

    if (response.success) {
      const count = response.processed || 0;
      const remaining = response.remaining || 0;
      console.log(`🔗 Entity backfill: ${count} processed, ${response.entities_created || 0} entities, ${remaining} remaining`);
    } else {
      console.warn('⚠️ Entity backfill returned error:', response.error || 'unknown');
    }
  } catch (err) {
    // Graceful: if the edge function doesn't exist yet, just skip
    if (err.message?.includes('404') || err.message?.includes('not found')) {
      return; // Edge function not deployed yet
    }
    throw err;
  }
}

/**
 * Sync messages to Supabase with embeddings
 * Uses a lock to prevent concurrent syncs. No recursive retry loop -
 * retry scheduling is owned by the debounce logic in background.js.
 * @returns {Promise<Object>} Sync result
 */
export async function syncToSupabase() {
  if (syncInProgress) {
    return { success: true, synced: 0, message: 'Sync already in progress' };
  }

  syncInProgress = true;
  try {
    const messagesToSync = await getMessagesToSync();
    return await syncMessages(messagesToSync);
  } finally {
    syncInProgress = false;
  }
}

/**
 * Backfill null embeddings in Supabase
 * Queries messages with embedding=null, generates embeddings via Scaleway,
 * and patches them back into Supabase.
 *
 * @param {Object} options - Backfill options
 * @param {number} options.batchSize - Messages per batch (default: 50)
 * @param {number} options.delayMs - Delay between batches in ms (default: 200)
 * @returns {Promise<Object>} Result with backfilled count and errors
 */
export async function backfillNullEmbeddings(options = {}) {
  const { batchSize = 50, delayMs = 200 } = options;

  console.log('🔄 Starting embedding backfill for null-embedding messages...');

  try {
    const config = await getConfig();

    if (!config.supabaseUrl || !config.supabaseKey) {
      return { success: false, error: 'Supabase not configured' };
    }

    // Check circuit breaker before starting
    const circuitStatus = await isEmbeddingCircuitOpen();
    if (circuitStatus.open) {
      console.warn(`⚠️ Backfill skipped: embedding circuit breaker open (${circuitStatus.reason})`);
      return { success: false, error: `Circuit breaker open: ${circuitStatus.reason}`, backfilled: 0 };
    }

    let totalBackfilled = 0;
    let totalErrors = 0;
    let hasMore = true;
    let offset = 0;
    let lastBatchIds = new Set();

    while (hasMore) {
      // Query messages with null embeddings
      let filterParams = `embedding=is.null&select=message_id,content&limit=${batchSize}&offset=${offset}&order=timestamp.desc`;
      // Resolve userId: prefer auth session > stored user_id > config userId
      const storageResult = await chrome.storage.local.get(['user_id', 'auth_session']);
      const userId = storageResult.auth_session?.user?.id || storageResult.user_id || config.userId;
      if (!userId) {
        console.warn('⚠️ Backfill skipped: no userId available');
        return { success: false, error: 'No userId available', backfilled: 0 };
      }
      filterParams += `&user_id=eq.${userId}`;

      const queryResponse = await fetchWithTimeout(
        `${config.supabaseUrl}/rest/v1/messages?${filterParams}`,
        {
          headers: getAuthHeaders(config)
        },
        15000
      );

      if (!queryResponse.ok) {
        const errorText = await queryResponse.text();
        console.error(`❌ Backfill query failed: ${queryResponse.status} - ${errorText}`);
        return { success: false, error: `Query failed: ${queryResponse.status}`, backfilled: totalBackfilled };
      }

      const messages = await queryResponse.json();

      if (messages.length === 0) {
        hasMore = false;
        break;
      }

      console.log(`📊 Backfill batch: ${messages.length} messages with null embeddings (offset: ${offset})`);

      // Generate embeddings for this batch
      const texts = messages.map(m => m.content);
      let embeddings;
      try {
        embeddings = await generateEmbeddings(texts, null);
      } catch (embeddingError) {
        console.error(`❌ Backfill embedding generation failed: ${embeddingError.message}`);
        // Circuit breaker likely tripped — stop backfill, let user retry later
        return {
          success: false,
          error: `Embedding generation failed: ${embeddingError.message}`,
          backfilled: totalBackfilled,
          remaining: messages.length
        };
      }

      // Patch each message with its embedding
      let batchSuccess = 0;
      for (let i = 0; i < messages.length; i++) {
        try {
          const patchResponse = await fetchWithTimeout(
            `${config.supabaseUrl}/rest/v1/messages?message_id=eq.${encodeURIComponent(messages[i].message_id)}`,
            {
              method: 'PATCH',
              headers: {
                ...getAuthHeaders(config),
                'Prefer': 'return=minimal'
              },
              body: JSON.stringify({ embedding: embeddings[i] })
            },
            10000
          );

          if (patchResponse.ok) {
            batchSuccess++;
          } else {
            console.warn(`   ⚠️ Patch failed for ${messages[i].message_id}: ${patchResponse.status}`);
            totalErrors++;
          }
        } catch (patchError) {
          console.warn(`   ⚠️ Patch error for ${messages[i].message_id}: ${patchError.message}`);
          totalErrors++;
        }
      }

      totalBackfilled += batchSuccess;
      console.log(`   ✅ Backfilled ${totalBackfilled} messages so far (${totalErrors} errors)`);

      // If we got fewer than batchSize, we're done
      if (messages.length < batchSize) {
        hasMore = false;
      } else {
        // Patched rows should vanish from is.null filter, so offset stays at 0.
        // But guard against infinite loops if patches aren't taking effect.
        const currentIds = new Set(messages.map(m => m.message_id));
        const overlap = [...currentIds].filter(id => lastBatchIds.has(id)).length;
        if (overlap > currentIds.size * 0.5) {
          console.warn(`⚠️ backfillNullEmbeddings: >50% overlap with previous batch — breaking to avoid infinite loop`);
          hasMore = false;
        }
        lastBatchIds = currentIds;
        offset = 0;
      }

      // Delay between batches to avoid rate limits
      if (hasMore) {
        await new Promise(resolve => setTimeout(resolve, delayMs));

        // Re-check circuit breaker between batches
        const midCheckCircuit = await isEmbeddingCircuitOpen();
        if (midCheckCircuit.open) {
          console.warn(`⚠️ Backfill paused: circuit breaker opened mid-backfill`);
          return {
            success: false,
            error: `Circuit breaker opened during backfill`,
            backfilled: totalBackfilled,
            willRetry: true
          };
        }
      }
    }

    console.log(`✅ Backfill complete: ${totalBackfilled} messages updated, ${totalErrors} errors`);
    return {
      success: true,
      backfilled: totalBackfilled,
      errors: totalErrors
    };

  } catch (error) {
    console.error('❌ Backfill failed:', error.message);
    return { success: false, error: error.message, backfilled: 0 };
  }
}

/**
 * Backfill null embeddings in chat_turns table.
 * Mirrors backfillNullEmbeddings() but targets chat_turns — the primary retrieval table
 * used by match_messages_with_gravity RPC. Without embeddings, chat_turns rows are
 * invisible to vector search.
 *
 * Uses contextual_content (if available) || content for embedding text, matching
 * the asymmetric embedding pattern used by the backfill_contextual edge function.
 *
 * @param {Object} options - Backfill options
 * @param {number} options.batchSize - Rows per batch (default: 50)
 * @param {number} options.delayMs - Delay between batches in ms (default: 200)
 * @param {string} options.platform - Optional platform filter (e.g. 'gemini')
 * @returns {Promise<Object>} Result with backfilled count and errors
 */
export async function backfillNullChatTurnEmbeddings(options = {}) {
  const { batchSize = 50, delayMs = 200, platform = null } = options;

  console.log(`🔄 Starting embedding backfill for null-embedding chat_turns...${platform ? ` (platform: ${platform})` : ''}`);

  try {
    const config = await getConfig();

    if (!config.supabaseUrl || !config.supabaseKey) {
      return { success: false, error: 'Supabase not configured' };
    }

    // Check circuit breaker before starting
    const circuitStatus = await isEmbeddingCircuitOpen();
    if (circuitStatus.open) {
      console.warn(`⚠️ Chat turns backfill skipped: embedding circuit breaker open (${circuitStatus.reason})`);
      return { success: false, error: `Circuit breaker open: ${circuitStatus.reason}`, backfilled: 0 };
    }

    // Resolve userId
    const storageResult = await chrome.storage.local.get(['user_id', 'auth_session']);
    const userId = storageResult.auth_session?.user?.id || storageResult.user_id || config.userId;
    if (!userId) {
      console.warn('⚠️ Chat turns backfill skipped: no userId available');
      return { success: false, error: 'No userId available', backfilled: 0 };
    }

    let totalBackfilled = 0;
    let totalErrors = 0;
    let hasMore = true;
    let lastBatchIds = new Set();

    while (hasMore) {
      // Query chat_turns with null embeddings
      let filterParams = `embedding=is.null&select=id,content,contextual_content&limit=${batchSize}&offset=0&order=start_timestamp.desc`;
      filterParams += `&user_id=eq.${userId}`;
      if (platform) {
        filterParams += `&platform=eq.${platform}`;
      }

      const queryResponse = await fetchWithTimeout(
        `${config.supabaseUrl}/rest/v1/chat_turns?${filterParams}`,
        {
          headers: getAuthHeaders(config)
        },
        15000
      );

      if (!queryResponse.ok) {
        const errorText = await queryResponse.text();
        console.error(`❌ Chat turns backfill query failed: ${queryResponse.status} - ${errorText}`);
        return { success: false, error: `Query failed: ${queryResponse.status}`, backfilled: totalBackfilled };
      }

      const rows = await queryResponse.json();

      if (rows.length === 0) {
        hasMore = false;
        break;
      }

      console.log(`📊 Chat turns backfill batch: ${rows.length} rows with null embeddings`);

      // Use contextual_content (richer, includes conversation context) if available,
      // fall back to raw content — mirrors backfill_contextual edge fn pattern
      const texts = rows.map(r => (r.contextual_content || r.content || '').trim() || ' ');
      let embeddings;
      try {
        embeddings = await generateEmbeddings(texts, null);
      } catch (embeddingError) {
        console.error(`❌ Chat turns embedding generation failed: ${embeddingError.message}`);
        return {
          success: false,
          error: `Embedding generation failed: ${embeddingError.message}`,
          backfilled: totalBackfilled,
          remaining: rows.length
        };
      }

      // Patch each row with its embedding
      let batchSuccess = 0;
      for (let i = 0; i < rows.length; i++) {
        try {
          const patchResponse = await fetchWithTimeout(
            `${config.supabaseUrl}/rest/v1/chat_turns?id=eq.${encodeURIComponent(rows[i].id)}`,
            {
              method: 'PATCH',
              headers: {
                ...getAuthHeaders(config),
                'Prefer': 'return=minimal'
              },
              body: JSON.stringify({ embedding: embeddings[i] })
            },
            10000
          );

          if (patchResponse.ok) {
            batchSuccess++;
          } else {
            console.warn(`   ⚠️ Chat turn patch failed for ${rows[i].id}: ${patchResponse.status}`);
            totalErrors++;
          }
        } catch (patchError) {
          console.warn(`   ⚠️ Chat turn patch error for ${rows[i].id}: ${patchError.message}`);
          totalErrors++;
        }
      }

      totalBackfilled += batchSuccess;
      console.log(`   ✅ Chat turns backfilled ${totalBackfilled} so far (${totalErrors} errors)`);

      // If we got fewer than batchSize, we're done
      if (rows.length < batchSize) {
        hasMore = false;
      } else {
        // Patched rows should vanish from is.null filter, so offset stays at 0.
        // But guard against infinite loops if patches aren't taking effect.
        const currentIds = new Set(rows.map(r => r.id));
        const overlap = [...currentIds].filter(id => lastBatchIds.has(id)).length;
        if (overlap > currentIds.size * 0.5) {
          console.warn(`⚠️ backfillNullChatTurnEmbeddings: >50% overlap — breaking to avoid infinite loop`);
          hasMore = false;
        }
        lastBatchIds = currentIds;
      }

      // Delay between batches
      if (hasMore) {
        await new Promise(resolve => setTimeout(resolve, delayMs));

        // Re-check circuit breaker between batches
        const midCheckCircuit = await isEmbeddingCircuitOpen();
        if (midCheckCircuit.open) {
          console.warn(`⚠️ Chat turns backfill paused: circuit breaker opened mid-backfill`);
          return {
            success: false,
            error: 'Circuit breaker opened during backfill',
            backfilled: totalBackfilled,
            willRetry: true
          };
        }
      }
    }

    console.log(`✅ Chat turns backfill complete: ${totalBackfilled} rows updated, ${totalErrors} errors`);
    return {
      success: true,
      backfilled: totalBackfilled,
      errors: totalErrors
    };

  } catch (error) {
    console.error('❌ Chat turns backfill failed:', error.message);
    return { success: false, error: error.message, backfilled: 0 };
  }
}

/**
 * Set API configuration
 * @param {Object} config - API configuration
 * @param {string} config.supabaseUrl - Supabase project URL
 * @param {string} config.supabaseKey - Supabase anon key
 * @param {string} config.supabaseKey - Supabase anon key
 * @param {string} null - OpenAI API key
 * @param {string} [config.userId] - Optional User ID (UUID)
 */
export async function setApiConfig(config) {
  await chrome.storage.local.set({ api_config: config });
  console.log('✅ API configuration saved');
}
