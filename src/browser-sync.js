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
 * Generate embeddings for messages using OpenAI API
 * Now uses token-aware batching to prevent "max context length" errors
 * @param {string[]} texts - Array of message content strings
 * @param {string} apiKey - OpenAI API key
 * @returns {Promise<number[][]>} Array of 1536-dimensional embeddings
 */
async function generateEmbeddings(texts, apiKey) {
  const allEmbeddings = [];

  // Batch by tokens, not count (fixes 26,916 token error)
  // REDUCED from 8000→6000→4000: OpenAI's actual tokenizer counts ~1.85x higher than our estimate
  // 4000 estimated tokens × 1.85 = ~7400 actual tokens (800 token safety margin below 8192 limit)
  const batches = batchByTokens(texts, 4000); // 4k tokens per batch (safe for actual tokenizer variance)

  console.log(`📊 Generating embeddings: ${batches.length} batches for ${texts.length} messages`);

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    const batchTokens = batch.reduce((sum, text) => sum + estimateTokens(text), 0);

    console.log(`📊 Batch ${i + 1}/${batches.length}: ${batch.length} messages (~${batchTokens} tokens)`);

    const response = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: 'text-embedding-3-small',
        input: batch,
        encoding_format: 'float'
      })
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(`OpenAI API error: ${error.error?.message || response.statusText}`);
    }

    const data = await response.json();
    const embeddings = data.data.map(item => item.embedding);
    allEmbeddings.push(...embeddings);

    // Rate limit protection
    if (i < batches.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 100));
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
 * Sync messages to Supabase with embeddings
 * @returns {Promise<Object>} Sync result
 */
export async function syncToSupabase() {
  try {
    console.log('🔄 Starting sync to Supabase...');

    // Get config and messages
    const config = await getConfig();
    const messagesToSync = await getMessagesToSync();

    if (messagesToSync.length === 0) {
      return {
        success: true,
        synced: 0,
        message: 'No new messages to sync'
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
    messagesToSync.forEach(msg => {
      console.log('📊 SYNC DEBUG:', {
        messageId: msg.messageId.substring(0, 20),
        original_platform: msg.platform,
        will_store_as: msg.platform || 'chatgpt',
        timestamp: new Date(msg.timestamp).toISOString()
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
      source: msg.platform || 'chatgpt', // Use actual platform or default to chatgpt
      synced_from_extension: new Date().toISOString()
    }));

    // Insert to Supabase (UPSERT for idempotency)
    // on_conflict=message_id tells PostgREST which column to check for duplicates
    const response = await fetch(`${config.supabaseUrl}/rest/v1/messages?on_conflict=message_id`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': config.supabaseKey,
        'Authorization': `Bearer ${config.supabaseKey}`,
        'Prefer': 'resolution=merge-duplicates'
      },
      body: JSON.stringify(messagesWithEmbeddings)
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(`Supabase error: ${error.message || response.statusText}`);
    }

    console.log(`✅ Messages synced to 'messages' table: ${messagesToSync.length}`);

    // PHASE 5: Sync to chat_turns table (conversation-turn chunks)
    // Note: user_id will be 'temp-user' until Supabase Auth is implemented (Day 2 task)
    // Use a valid UUID for temp user (all zeros - reserved for system/anonymous users)
    // TODO: Replace with auth.uid() after Day 2 Supabase Auth implementation
    const tempUserId = '00000000-0000-0000-0000-000000000000';

    console.log('📦 Creating conversation-turn chunks...');
    const turnChunks = messagesToTurnChunks(messagesToSync, tempUserId);

    if (turnChunks.length > 0) {
      // PHASE 8: HyDE Preprocessing - Generate hypothetical questions
      // This improves retrieval by indexing what users MIGHT ask about the content
      console.log('🔮 Generating hypothetical questions for chunks...');

      const chunksWithHyDE = [];
      for (const chunk of turnChunks) {
        const hydeResult = await generateHypotheticalQuestions(chunk, config.openaiKey, 3);

        chunksWithHyDE.push({
          ...chunk,
          hypothetical_questions: hydeResult.success ? hydeResult.questions : []
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
 * Set API configuration
 * @param {Object} config - API configuration
 * @param {string} config.supabaseUrl - Supabase project URL
 * @param {string} config.supabaseKey - Supabase anon key
 * @param {string} config.openaiKey - OpenAI API key
 */
export async function setApiConfig(config) {
  await chrome.storage.local.set({ api_config: config });
  console.log('✅ API configuration saved');
}
