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

// API timeout settings (prevent Chrome message channel timeout)
const SYNC_API_TIMEOUT_MS = 30000; // 30 seconds for sync (batch operations need more time)

/**
 * Fetch with timeout to prevent hung operations during sync
 * @param {string} url - URL to fetch
 * @param {Object} options - Fetch options
 * @param {number} timeoutMs - Timeout in milliseconds
 * @returns {Promise<Response>} - Fetch response or throws on timeout
 */
async function fetchWithTimeout(url, options, timeoutMs = SYNC_API_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    return response;
  } catch (error) {
    clearTimeout(timeoutId);
    if (error.name === 'AbortError') {
      throw new Error(`API request timed out after ${timeoutMs}ms`);
    }
    throw error;
  }
}

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
 * Generate embeddings using Qwen3-Embedding-8B via HuggingFace API
 * Produces 4096-dimensional embeddings (matches database schema)
 * @param {string[]} texts - Array of message content strings
 * @param {string} _apiKey - Unused (kept for backward compatibility)
 * @returns {Promise<number[][]>} Array of 4096-dimensional embeddings
 */
async function generateEmbeddings(texts, _apiKey) {
  // Get HuggingFace key from config
  const config = await getConfig();
  const HF_API_KEY = config.huggingfaceKey;

  if (!HF_API_KEY) {
    throw new Error('HuggingFace API key not configured. Please add it in extension setup.');
  }

  const allEmbeddings = [];

  // Batch by tokens (Qwen3 has similar limits)
  const batches = batchByTokens(texts, 4000);

  console.log(`📊 Generating Qwen3 embeddings: ${batches.length} batches for ${texts.length} messages`);

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    const batchTokens = batch.reduce((sum, text) => sum + estimateTokens(text), 0);

    console.log(`📊 Batch ${i + 1}/${batches.length}: ${batch.length} messages (~${batchTokens} tokens)`);

    const response = await fetchWithTimeout(
      'https://router.huggingface.co/hf-inference/models/Qwen/Qwen3-Embedding-8B',
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${HF_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          inputs: batch,
          options: { wait_for_model: false } // Don't wait - faster, handle 503 separately
        })
      },
      SYNC_API_TIMEOUT_MS
    );

    // Handle model loading (503) - wait and retry
    if (response.status === 503) {
      console.warn(`   ⏳ Model loading (503), waiting 5s and retrying...`);
      await new Promise(resolve => setTimeout(resolve, 5000));
      // Retry with wait_for_model this time
      const retryResponse = await fetchWithTimeout(
        'https://router.huggingface.co/hf-inference/models/Qwen/Qwen3-Embedding-8B',
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${HF_API_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            inputs: batch,
            options: { wait_for_model: true }
          })
        },
        SYNC_API_TIMEOUT_MS * 2 // Double timeout for retry
      );

      if (!retryResponse.ok) {
        const errorText = await retryResponse.text();
        throw new Error(`HuggingFace API error on retry: ${retryResponse.status} - ${errorText}`);
      }

      const retryEmbeddings = await retryResponse.json();
      if (Array.isArray(retryEmbeddings) && Array.isArray(retryEmbeddings[0])) {
        allEmbeddings.push(...retryEmbeddings);
      } else if (Array.isArray(retryEmbeddings)) {
        allEmbeddings.push(retryEmbeddings);
      }
      continue; // Skip the rest of the loop iteration
    }

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`HuggingFace API error: ${response.status} - ${errorText}`);
    }

    const embeddings = await response.json();

    // Handle response format - HuggingFace returns array of embeddings
    if (Array.isArray(embeddings) && Array.isArray(embeddings[0])) {
      allEmbeddings.push(...embeddings);
    } else if (Array.isArray(embeddings)) {
      allEmbeddings.push(embeddings);
    } else {
      throw new Error('Unexpected embedding response format from HuggingFace');
    }

    // Rate limit protection (slightly longer for HuggingFace)
    if (i < batches.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }

  return allEmbeddings;
}

/**
 * Get messages that need syncing (not yet synced)
 * @returns {Promise<Object[]>} Messages to sync
 */
async function getMessagesToSync() {
  const result = await chrome.storage.local.get(['captured_messages', 'last_sync_status']);
  const allMessages = result.captured_messages || [];
  const lastSync = result.last_sync_status || { lastSyncTime: 0, syncedMessageIds: [] };

  // Filter out already synced messages
  const syncedIds = new Set(lastSync.syncedMessageIds || []);
  const newMessages = allMessages.filter(msg => !syncedIds.has(msg.messageId));

  console.log(`📦 Found ${newMessages.length} new messages to sync (${allMessages.length} total)`);
  return newMessages;
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

    // Generate embeddings
    const texts = messagesToSync.map(m => m.content);
    const embeddings = await generateEmbeddings(texts, config.openaiKey);

    // Log platform distribution for diagnostics
    const platformCounts = messagesToSync.reduce((acc, m) => {
      const platform = m.platform || 'unknown';
      acc[platform] = (acc[platform] || 0) + 1;
      return acc;
    }, {});
    console.log(`📊 KYT Sync: Syncing ${messagesToSync.length} messages -`, platformCounts);

    // PHASE 0 DIAGNOSTIC: Log source field attribution for each message
    // messagesToSync.forEach(msg => {
    //   console.log('📊 SYNC DEBUG:', {
    //     messageId: msg.messageId.substring(0, 20),
    //     user_id: config.userId || 'DEFAULT',
    //     original_platform: msg.platform,
    //     will_store_as: msg.platform || 'chatgpt',
    //     role: msg.role, // CRITICAL DIAGNOSTIC
    //     content_preview: msg.content?.substring(0, 20),
    //     timestamp: new Date(msg.timestamp).toISOString()
    //   });
    // });

    // Prepare data for Supabase
    const messagesWithEmbeddings = messagesToSync.map((msg, idx) => ({
      content: msg.content,
      role: msg.role || 'user', // Default to 'user' (DB constraint: user|assistant|system)
      conversation_id: msg.conversationId || null,
      model: msg.model || null,
      timestamp: msg.timestamp || msg.capturedAt,
      message_id: msg.messageId,
      embedding: embeddings[idx],
      source: msg.platform || 'chatgpt', // Use actual platform or default to chatgpt
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
      console.log(`   Processing batch ${i + 1}/${batches.length} (${batch.length} messages)...`);

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
          'Prefer': 'resolution=merge-duplicates'
        },
        body: JSON.stringify(batch)
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(`Supabase error (batch ${i + 1}): ${error.message || response.statusText}`);
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
          const hydeResult = await generateHypotheticalQuestions(chunk, config.openaiKey, 3);
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

      // Generate embeddings for turn chunks
      const turnTexts = chunksWithHyDE.map(chunk => chunk.content);
      const turnEmbeddings = await generateEmbeddings(turnTexts, config.openaiKey);

      // Prepare turn chunks with embeddings and HyDE questions
      const chunksWithEmbeddings = chunksWithHyDE.map((chunk, idx) => ({
        ...chunk,
        embedding: turnEmbeddings[idx],
      }));

      // Insert to chat_turns table
      const turnsResponse = await fetch(`${config.supabaseUrl}/rest/v1/chat_turns`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': config.supabaseKey,
          'Authorization': `Bearer ${config.supabaseKey}`,
          'Prefer': 'return=minimal'
        },
        body: JSON.stringify(chunksWithEmbeddings)
      });

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

    // Update sync status
    const result = await chrome.storage.local.get(['last_sync_status']);
    const syncStatus = result.last_sync_status || { syncedMessageIds: [] };

    syncStatus.lastSyncTime = Date.now();
    syncStatus.syncedCount = messagesToSync.length;
    syncStatus.syncedMessageIds = [
      ...(syncStatus.syncedMessageIds || []),
      ...messagesToSync.map(m => m.messageId)
    ];

    await chrome.storage.local.set({ last_sync_status: syncStatus });

    const chunkCount = turnChunks.length;
    console.log(`✅ Sync complete: ${messagesToSync.length} messages + ${chunkCount} turn chunks`);

    return {
      success: true,
      synced: messagesToSync.length,
      chunks: chunkCount,
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
 * Sync messages to Supabase with embeddings (Legacy/Default wrapper)
 * @returns {Promise<Object>} Sync result
 */
export async function syncToSupabase() {
  const messagesToSync = await getMessagesToSync();
  return syncMessages(messagesToSync);
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
