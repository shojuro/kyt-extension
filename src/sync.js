/**
 * KYT Day 2: Sync Service
 *
 * Syncs messages from Chrome storage to Supabase with OpenAI embeddings
 * - Reads messages from chrome.storage.local
 * - Generates embeddings via OpenAI API
 * - Batch inserts to Supabase (handles duplicates)
 * - Tracks sync status
 */

import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';

// Load environment variables
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Initialize clients
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

/**
 * Generate embedding for a single text
 * @param {string} text - Text to embed
 * @returns {Promise<number[]>} - 1536-dimensional embedding vector
 */
async function generateEmbedding(text) {
  try {
    const response = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: text,
      encoding_format: 'float'
    });

    return response.data[0].embedding;
  } catch (error) {
    console.error('Error generating embedding:', error.message);
    throw error;
  }
}

/**
 * Generate embeddings for multiple texts in batch
 * OpenAI allows up to 2048 inputs per request
 * @param {string[]} texts - Array of texts to embed
 * @returns {Promise<number[][]>} - Array of embedding vectors
 */
async function generateEmbeddingsBatch(texts) {
  const BATCH_SIZE = 100; // Conservative batch size
  const embeddings = [];

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);

    try {
      const response = await openai.embeddings.create({
        model: 'text-embedding-3-small',
        input: batch,
        encoding_format: 'float'
      });

      embeddings.push(...response.data.map(d => d.embedding));

      console.log(`Generated embeddings for batch ${i / BATCH_SIZE + 1} (${batch.length} texts)`);
    } catch (error) {
      console.error(`Error in batch ${i / BATCH_SIZE + 1}:`, error.message);
      throw error;
    }
  }

  return embeddings;
}

/**
 * Sync messages from Chrome storage to Supabase
 * @param {Object[]} messages - Array of message objects from Chrome storage
 * @returns {Promise<Object>} - Sync results { synced, skipped, errors }
 */
export async function syncMessages(messages) {
  console.log(`Starting sync for ${messages.length} messages...`);

  if (!messages || messages.length === 0) {
    return { synced: 0, skipped: 0, errors: 0 };
  }

  const results = {
    synced: 0,
    skipped: 0,
    errors: 0
  };

  try {
    // Step 1: Generate embeddings for all messages
    console.log('Generating embeddings...');
    const texts = messages.map(m => m.content);
    const embeddings = await generateEmbeddingsBatch(texts);

    // Step 2: Prepare data for insertion
    const messagesWithEmbeddings = messages.map((msg, idx) => ({
      content: msg.content,
      role: msg.role,
      conversation_id: msg.conversationId || null,
      model: msg.model || null,
      timestamp: msg.timestamp,
      message_id: msg.messageId,
      embedding: embeddings[idx],
      synced_from_extension: new Date().toISOString()
    }));

    // Step 3: Insert to Supabase (upsert to handle duplicates)
    console.log('Inserting to Supabase...');
    const { data, error } = await supabase
      .from('messages')
      .upsert(messagesWithEmbeddings, {
        onConflict: 'message_id', // Skip duplicates based on message_id
        ignoreDuplicates: true
      });

    if (error) {
      console.error('Supabase insert error:', error);
      results.errors = messages.length;
      return results;
    }

    results.synced = messagesWithEmbeddings.length;
    console.log(`✅ Successfully synced ${results.synced} messages`);

    return results;

  } catch (error) {
    console.error('Sync error:', error);
    results.errors = messages.length;
    return results;
  }
}

/**
 * Get sync status from Supabase
 * @returns {Promise<Object>} - { totalMessages, lastSyncTime }
 */
export async function getSyncStatus() {
  try {
    const { count, error } = await supabase
      .from('messages')
      .select('*', { count: 'exact', head: true });

    if (error) throw error;

    // Get most recent sync time
    const { data: recentData } = await supabase
      .from('messages')
      .select('synced_from_extension')
      .order('synced_from_extension', { ascending: false })
      .limit(1);

    return {
      totalMessages: count || 0,
      lastSyncTime: recentData?.[0]?.synced_from_extension || null
    };
  } catch (error) {
    console.error('Error getting sync status:', error);
    return {
      totalMessages: 0,
      lastSyncTime: null,
      error: error.message
    };
  }
}

/**
 * Check which messages need syncing (not yet in Supabase)
 * @param {Object[]} localMessages - Messages from Chrome storage
 * @returns {Promise<Object[]>} - Messages that need syncing
 */
export async function getMessagesToSync(localMessages) {
  try {
    // Get all message IDs already in Supabase
    const { data: existingMessages, error } = await supabase
      .from('messages')
      .select('message_id');

    if (error) throw error;

    const existingIds = new Set(existingMessages.map(m => m.message_id));

    // Filter out messages that already exist
    const newMessages = localMessages.filter(m => !existingIds.has(m.messageId));

    console.log(`Found ${newMessages.length} new messages to sync (${existingIds.size} already synced)`);

    return newMessages;

  } catch (error) {
    console.error('Error checking messages to sync:', error);
    // If error, sync all messages (better to have duplicates than miss messages)
    return localMessages;
  }
}
