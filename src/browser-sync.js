/**
 * KYT Day 2: Browser-Compatible Sync Module
 *
 * Syncs messages from Chrome storage to Supabase with OpenAI embeddings
 * Uses fetch() and chrome.storage APIs (works in extension context)
 */

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
 * Generate embeddings for messages using OpenAI API
 * @param {string[]} texts - Array of message content strings
 * @param {string} apiKey - OpenAI API key
 * @returns {Promise<number[][]>} Array of 1536-dimensional embeddings
 */
async function generateEmbeddings(texts, apiKey) {
  const BATCH_SIZE = 100;
  const allEmbeddings = [];

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);

    console.log(`📊 Generating embeddings: batch ${Math.floor(i / BATCH_SIZE) + 1} (${batch.length} messages)`);

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
    if (i + BATCH_SIZE < texts.length) {
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

    // Prepare data for Supabase
    const messagesWithEmbeddings = messagesToSync.map((msg, idx) => ({
      content: msg.content,
      role: msg.role || 'unknown',
      conversation_id: msg.conversationId || null,
      model: msg.model || null,
      timestamp: msg.timestamp || msg.capturedAt,
      message_id: msg.messageId,
      embedding: embeddings[idx],
      source: 'chatgpt', // Mark as ChatGPT source
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

    console.log(`✅ Sync complete: ${messagesToSync.length} messages synced`);

    return {
      success: true,
      synced: messagesToSync.length,
      message: `Successfully synced ${messagesToSync.length} messages`
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
