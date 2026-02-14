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

// SYNC LOCK: Prevent race conditions when multiple syncs happen in parallel
let syncInProgress = false;

// API timeout settings (prevent Chrome message channel timeout)
const SYNC_API_TIMEOUT_MS = 30000; // 30 seconds for sync (batch operations need more time)

/**
 * Get API configuration from chrome.storage
 * @returns {Promise<Object>} Configuration object
 */
async function getConfig() {
  const result = await chrome.storage.local.get(['api_config']);
  if (!result.api_config) {
    throw new Error('API configuration not found. Please set up API keys first.');
  }
  return result.api_config;
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
 * Generate embeddings using Qwen3-Embedding-8B via HuggingFace Inference Providers
 * Produces 4096-dimensional embeddings (matches database schema)
 * Routes through HuggingFace's router to Scaleway backend (OpenAI-compatible format)
 *
 * @param {string[]} texts - Array of message content strings
 * @param {string} _apiKey - Unused (kept for backward compatibility)
 * @returns {Promise<number[][]>} Array of 4096-dimensional embeddings
 * @throws {Error} If circuit breaker is open or API fails
 */
async function generateEmbeddings(texts, _apiKey) {
  // Check circuit breaker FIRST
  const circuitStatus = await isEmbeddingCircuitOpen();
  if (circuitStatus.open) {
    throw new Error(`Embedding circuit breaker open: ${circuitStatus.reason}`);
  }

  // Get HuggingFace key from config
  const config = await getConfig();
  const HF_API_KEY = config.huggingfaceKey;

  if (!HF_API_KEY) {
    throw new Error('HuggingFace API key not configured. Please add it in extension setup.');
  }

  const allEmbeddings = [];

  // Batch by tokens (Qwen3 has similar limits)
  const batches = batchByTokens(texts, 4000);

  // HuggingFace Inference Providers router endpoint (routes to Scaleway backend)
  const HF_ROUTER_URL = 'https://router.huggingface.co/scaleway/v1/embeddings';

  console.log(`📊 Generating Qwen3 embeddings via HuggingFace: ${batches.length} batches for ${texts.length} messages`);

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    const batchTokens = batch.reduce((sum, text) => sum + estimateTokens(text), 0);

    console.log(`📊 Batch ${i + 1}/${batches.length}: ${batch.length} messages (~${batchTokens} tokens)`);

    // HuggingFace router uses OpenAI-compatible format
    const response = await fetchWithTimeout(
      HF_ROUTER_URL,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${HF_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'qwen3-embedding-8b',
          input: batch
        })
      },
      SYNC_API_TIMEOUT_MS
    );

    // Handle non-OK responses with circuit breaker
    if (!response.ok) {
      const errorText = await response.text();

      // Record failure in circuit breaker
      await recordEmbeddingFailure(response.status, errorText);

      // For 429, attempt one retry after delay (if circuit hasn't tripped)
      if (response.status === 429) {
        console.warn(`   ⏳ Rate limited (429), waiting 10s and retrying...`);
        await new Promise(resolve => setTimeout(resolve, 10000));

        const retryResponse = await fetchWithTimeout(
          HF_ROUTER_URL,
          {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${HF_API_KEY}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              model: 'qwen3-embedding-8b',
              input: batch
            })
          },
          SYNC_API_TIMEOUT_MS * 2
        );

        if (!retryResponse.ok) {
          const retryErrorText = await retryResponse.text();
          await recordEmbeddingFailure(retryResponse.status, retryErrorText);
          throw new Error(`HuggingFace API error on retry: ${retryResponse.status} - ${retryErrorText}`);
        }

        // Retry succeeded
        await recordEmbeddingSuccess();
        const retryData = await retryResponse.json();
        const retryEmbeddings = retryData.data.map(item => item.embedding);
        allEmbeddings.push(...retryEmbeddings);
        continue;
      }

      throw new Error(`HuggingFace API error: ${response.status} - ${errorText}`);
    }

    const responseData = await response.json();

    // OpenAI-compatible format: { data: [{ embedding: [...] }, ...] }
    if (responseData.data && Array.isArray(responseData.data)) {
      const embeddings = responseData.data.map(item => item.embedding);
      allEmbeddings.push(...embeddings);
    } else {
      throw new Error('Unexpected embedding response format from HuggingFace');
    }

    // Rate limit protection
    if (i < batches.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }

  // All batches succeeded - record success
  await recordEmbeddingSuccess();
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
      headers: {
        'apikey': config.supabaseKey,
        'Authorization': `Bearer ${config.supabaseKey}`
      }
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
          headers: {
            'apikey': config.supabaseKey,
            'Authorization': `Bearer ${config.supabaseKey}`
          }
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
  const candidateMessages = allMessages.filter(msg => {
    if (!msg.messageId) return false;
    const messageTime = msg.capturedAt ?? msg.timestamp ?? 0;
    return messageTime > lastSyncTime;
  });

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
      embeddings = await generateEmbeddings(texts, config.openaiKey);
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

    // Log each message's role for verification
    messagesToSync.forEach((msg, idx) => {
      console.log(`📊 SYNC DEBUG [${idx}]:`, {
        messageId: msg.messageId?.substring(0, 20) || 'no-id',
        role: msg.role || 'MISSING',
        platform: normalizePlatform(msg.platform),
        content_preview: msg.content?.substring(0, 30) + '...'
      });
    });

    // Prepare data for Supabase
    const messagesWithEmbeddings = messagesToSync.map((msg, idx) => ({
      content: msg.content,
      role: msg.role || 'user', // Default to 'user' (DB constraint: user|assistant|system)
      conversation_id: msg.conversationId || null,
      model: msg.model || null,
      timestamp: msg.timestamp || msg.capturedAt,
      message_id: msg.messageId,
      embedding: embeddings[idx],
      source: normalizePlatform(msg.platform),
      user_id: config.userId || '00000000-0000-0000-0000-000000000000', // Add user_id
      synced_from_extension: new Date().toISOString()
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

      const response = await fetch(`${config.supabaseUrl}/rest/v1/messages?on_conflict=message_id`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': config.supabaseKey,
          'Authorization': `Bearer ${config.supabaseKey}`,
          'Prefer': 'resolution=merge-duplicates,return=representation'  // Add return=representation to see what was inserted
        },
        body: JSON.stringify(batch)
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(`Supabase error (batch ${i + 1}): ${error.message || response.statusText}`);
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

    console.log(`✅ Messages synced to 'messages' table: ${messagesToSync.length}`);

    // PHASE 5: Sync to chat_turns table (conversation-turn chunks)
    // Use userId from config or default to temp ID
    const userId = config.userId || '00000000-0000-0000-0000-000000000000';

    console.log('📦 Creating conversation-turn chunks...');
    const turnChunks = messagesToTurnChunks(messagesToSync, userId);

    if (turnChunks.length > 0) {
      // PHASE 8: HyDE Preprocessing - Generate hypothetical questions
      // This improves retrieval by indexing what users MIGHT ask about the content
      console.log('🔮 Generating hypothetical questions for chunks...');

      const chunksWithHyDE = [];
      for (const chunk of turnChunks) {
        let questions = [];
        try {
          const hydeResult = await generateHypotheticalQuestions(chunk, config.openaiKey, 5);
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

      // Generate embeddings for turn chunks (graceful degradation: null if unavailable)
      const turnTexts = chunksWithHyDE.map(chunk => chunk.content);
      let turnEmbeddings;
      try {
        turnEmbeddings = await generateEmbeddings(turnTexts, config.openaiKey);
      } catch (turnEmbedError) {
        console.warn(`⚠️ Turn embeddings unavailable, syncing without: ${turnEmbedError.message}`);
        turnEmbeddings = new Array(turnTexts.length).fill(null);
      }

      // Prepare turn chunks with embeddings and HyDE questions
      const chunksWithEmbeddings = chunksWithHyDE.map((chunk, idx) => ({
        ...chunk,
        embedding: turnEmbeddings[idx],
      }));

      // Insert to chat_turns table
      const turnsResponse = await fetch(
        `${config.supabaseUrl}/rest/v1/chat_turns?on_conflict=user_id,conversation_id,platform,start_timestamp`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'apikey': config.supabaseKey,
            'Authorization': `Bearer ${config.supabaseKey}`,
            'Prefer': 'resolution=ignore-duplicates,return=minimal'
          },
          body: JSON.stringify(chunksWithEmbeddings)
        }
      );

      if (!turnsResponse.ok) {
        const turnError = await turnsResponse.json();
        console.warn(`⚠️ Chat turns sync failed: ${turnError.message || turnsResponse.statusText}`);
        console.warn('Continuing with message-level sync only...');
      } else {
        console.log(`✅ Chat turns synced to 'chat_turns' table: ${turnChunks.length} chunks`);
      }
    } else {
      console.log('📊 No conversation turns created (insufficient messages for chunking)');
    }

    // Update sync status - use timestamp-based tracking (no more accumulating syncedMessageIds)
    // The database is now the source of truth for which messages exist
    const syncTimestamp = Date.now();
    await chrome.storage.local.set({
      last_successful_sync_time: syncTimestamp,
      last_sync_status: {
        lastSyncTime: syncTimestamp,
        syncedCount: messagesToSync.length,
        // Keep minimal status for UI/debugging, but NOT used for sync decisions
        lastSyncedMessageIds: messagesToSync.slice(-10).map(m => m.messageId) // Only last 10 for debugging
      }
    });

    const chunkCount = turnChunks.length;
    console.log(`✅ Sync complete: ${messagesToSync.length} messages + ${chunkCount} turn chunks (embeddings: ${embeddingsAvailable})`);

    // Entity backfill: trigger server-side entity extraction for synced turn IDs
    // Fire-and-forget — don't block the sync result. Only for authenticated users.
    triggerEntityBackfill(config).catch(err =>
      console.warn('⚠️ Entity backfill trigger failed (non-fatal):', err.message)
    );

    return {
      success: true,
      synced: messagesToSync.length,
      chunks: chunkCount,
      embeddingsGenerated: embeddingsAvailable,
      message: `Successfully synced ${messagesToSync.length} messages + ${chunkCount} turn chunks`
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
 * Calls the backfill_entities edge function if authenticated.
 * Fire-and-forget: errors are logged but don't affect sync result.
 *
 * @param {Object} config - API config with supabaseUrl, supabaseKey
 */
async function triggerEntityBackfill(config) {
  // Only trigger for authenticated users (edge function requires auth)
  const storageResult = await chrome.storage.local.get(['auth_session']);
  const session = storageResult.auth_session;
  if (!session?.access_token) {
    return; // Legacy mode — entity extraction happens via save_chat_turn edge function
  }

  try {
    const { callEdgeFunction } = await import('./api-client.js');
    const response = await callEdgeFunction('backfill_entities', {
      limit: 20 // Process up to 20 turns per sync cycle
    }, { timeoutMs: 15000 });

    if (response.success) {
      const count = response.processed || 0;
      if (count > 0) {
        console.log(`🔗 Entity backfill: ${count} turns processed`);
      }
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
          headers: {
            'apikey': config.supabaseKey,
            'Authorization': `Bearer ${config.supabaseKey}`
          }
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
        embeddings = await generateEmbeddings(texts, config.openaiKey);
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
                'Content-Type': 'application/json',
                'apikey': config.supabaseKey,
                'Authorization': `Bearer ${config.supabaseKey}`,
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
        // Don't increment offset — we're patching nulls, so the next query
        // at offset=0 will return the next batch of unpatched rows
        // But guard against infinite loops if patches aren't taking effect
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
 * Set API configuration
 * @param {Object} config - API configuration
 * @param {string} config.supabaseUrl - Supabase project URL
 * @param {string} config.supabaseKey - Supabase anon key
 * @param {string} config.supabaseKey - Supabase anon key
 * @param {string} config.openaiKey - OpenAI API key
 * @param {string} [config.userId] - Optional User ID (UUID)
 */
export async function setApiConfig(config) {
  await chrome.storage.local.set({ api_config: config });
  console.log('✅ API configuration saved');
}
