/**
 * KYT Memory Extension - Background Service Worker (Day 1-2)
 *
 * Purpose: Receive captured messages from content script and store in chrome.storage
 * Day 2: Added sync and search capabilities for unified memory
 *
 * Compliance: CLAUDE.md Anti-Theater Rules
 * - Real storage verification (not console.log theater)
 * - Actual error handling
 * - Health monitoring for API fragility
 */

'use strict';

// Day 2: Import browser-compatible sync and search modules
// TEMPORARY: Commented out due to Chrome service worker module loading issue
// These will be re-enabled after moving to root directory or using dynamic import
// import { syncToSupabase, setApiConfig } from './src/browser-sync.js';
// import { searchMessages, findSimilarMessages } from './src/browser-search.js';

console.log('🚀 KYT Background: Service worker starting...');

// Track storage health
let totalMessagesSaved = 0;
let totalErrors = 0;
let lastSaveTime = Date.now();

/**
 * Save captured message to chrome.storage.local
 * @param {Object} messageData - Extracted message data from content script
 * @returns {Promise<boolean>} Success status
 */
async function saveMessage(messageData) {
  try {
    // Validate input
    if (!messageData || typeof messageData !== 'object') {
      throw new Error('Invalid message data: expected object');
    }

    if (!messageData.content || typeof messageData.content !== 'string') {
      throw new Error('Invalid message content: expected non-empty string');
    }

    // Get existing messages
    const result = await chrome.storage.local.get(['captured_messages']);
    const messages = result.captured_messages || [];

    // Add new message
    messages.push({
      ...messageData,
      capturedAt: Date.now(),
      messageId: generateMessageId()
    });

    // Store updated array
    await chrome.storage.local.set({ captured_messages: messages });

    // Update metrics
    totalMessagesSaved++;
    lastSaveTime = Date.now();

    console.log(`✅ KYT Background: Message saved (total: ${messages.length})`);
    console.log(`   Content: "${messageData.content.substring(0, 50)}..."`);

    return true;

  } catch (error) {
    totalErrors++;
    console.error('❌ KYT Background: Failed to save message:', error.message);

    // Store error for debugging
    try {
      const errorLog = await chrome.storage.local.get(['error_log']);
      const errors = errorLog.error_log || [];

      errors.push({
        type: 'STORAGE_ERROR',
        message: error.message,
        timestamp: Date.now()
      });

      // Keep only last 100 errors
      if (errors.length > 100) {
        errors.splice(0, errors.length - 100);
      }

      await chrome.storage.local.set({ error_log: errors });
    } catch (logError) {
      console.error('❌ Failed to log error:', logError);
    }

    return false;
  }
}

/**
 * Generate unique message ID
 * @returns {string} Unique ID (timestamp + random)
 */
function generateMessageId() {
  return `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Get storage statistics
 * @returns {Promise<Object>} Storage stats
 */
async function getStorageStats() {
  try {
    const result = await chrome.storage.local.get(['captured_messages', 'error_log']);
    const messages = result.captured_messages || [];
    const errors = result.error_log || [];

    // Calculate storage size (approximate)
    const storageSize = JSON.stringify(messages).length;
    const storageLimitBytes = chrome.storage.local.QUOTA_BYTES;
    const usagePercent = ((storageSize / storageLimitBytes) * 100).toFixed(2);

    return {
      totalMessages: messages.length,
      totalErrors: errors.length,
      storageSize: storageSize,
      storageSizeKB: (storageSize / 1024).toFixed(2),
      storageLimitKB: (storageLimitBytes / 1024).toFixed(0),
      usagePercent: usagePercent,
      lastSaveTime: lastSaveTime,
      timeSinceLastSave: Date.now() - lastSaveTime
    };
  } catch (error) {
    console.error('❌ Failed to get storage stats:', error);
    return null;
  }
}

/**
 * Day 3: Get context for injection (CSP fix)
 * Runs in background script (no CSP restrictions)
 *
 * @param {string} userMessage - User's message text
 * @param {Object} config - Context injection configuration
 * @returns {Promise<Object>} Context data with formatted string and items
 */
async function getContextForInjection(userMessage, config) {
  const startTime = performance.now();

  try {
    // Get API configuration
    const result = await chrome.storage.local.get(['api_config']);
    if (!result.api_config) {
      throw new Error('API configuration not found');
    }

    const apiConfig = result.api_config;

    // Use provided config or defaults
    const contextConfig = {
      threshold: config?.threshold || 0.5,
      maxContextItems: config?.maxContextItems || 3,
      minDistance: config?.minDistance || 0.0,
      debugMode: config?.debugMode || false
    };

    // Generate embedding using OpenAI (no CSP in background!)
    const embeddingResponse = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiConfig.openaiKey}`
      },
      body: JSON.stringify({
        model: 'text-embedding-3-small',
        input: userMessage,
        encoding_format: 'float'
      })
    });

    if (!embeddingResponse.ok) {
      const error = await embeddingResponse.json().catch(() => ({}));
      throw new Error(`OpenAI API error: ${error.error?.message || embeddingResponse.statusText}`);
    }

    const embeddingData = await embeddingResponse.json();
    const queryEmbedding = embeddingData.data[0].embedding;

    // Search Supabase for relevant context (no CSP in background!)
    const searchResponse = await fetch(
      `${apiConfig.supabaseUrl}/rest/v1/rpc/match_messages`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': apiConfig.supabaseKey,
          'Authorization': `Bearer ${apiConfig.supabaseKey}`
        },
        body: JSON.stringify({
          query_embedding: queryEmbedding,
          match_threshold: contextConfig.threshold,
          match_count: contextConfig.maxContextItems
        })
      }
    );

    if (!searchResponse.ok) {
      const error = await searchResponse.json().catch(() => ({}));
      throw new Error(`Supabase search error: ${error.message || searchResponse.statusText}`);
    }

    const contextItems = await searchResponse.json();

    // Filter by minimum distance
    const filteredItems = contextItems.filter(r => r.distance >= contextConfig.minDistance);

    // Format context for injection
    let formattedContext = null;
    if (filteredItems.length > 0) {
      formattedContext = `[Memory Context - ${filteredItems.length} relevant item${filteredItems.length > 1 ? 's' : ''}]\n\n`;

      filteredItems.forEach((item, index) => {
        const source = item.source === 'cli' ? '📝 Terminal' : '💬 Previous conversation';
        const timestamp = new Date(item.msg_timestamp || item.timestamp).toLocaleDateString();

        formattedContext += `${index + 1}. ${source} (${timestamp})\n`;
        formattedContext += `   "${item.content}"\n`;

        if (contextConfig.debugMode) {
          formattedContext += `   [Distance: ${item.distance.toFixed(3)}, Source: ${item.source}]\n`;
        }

        formattedContext += '\n';
      });

      formattedContext += '[End of Memory Context]\n\n';
    }

    const elapsedTime = performance.now() - startTime;

    return {
      success: true,
      items: filteredItems,
      formattedContext: formattedContext,
      elapsedMs: elapsedTime
    };

  } catch (error) {
    console.error('❌ Context retrieval failed:', error);
    return {
      success: false,
      error: error.message,
      items: [],
      formattedContext: null
    };
  }
}

/**
 * Message listener - Handle messages from content script
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('📨 KYT Background: Received message:', message.type);

  // Handle different message types
  switch (message.type) {
    case 'SAVE_MESSAGE':
      // Async save - respond immediately to avoid timeout
      saveMessage(message.data)
        .then(success => {
          sendResponse({ success: success });
        })
        .catch(error => {
          console.error('❌ Save failed:', error);
          sendResponse({ success: false, error: error.message });
        });
      return true; // Keep message channel open for async response

    case 'EXTRACTION_ERROR':
      console.error('⚠️ Content script extraction error:', message.error);
      // Log extraction errors
      chrome.storage.local.get(['error_log'], (result) => {
        const errors = result.error_log || [];
        errors.push({
          type: 'EXTRACTION_ERROR',
          message: message.error,
          timestamp: message.timestamp
        });
        chrome.storage.local.set({ error_log: errors });
      });
      sendResponse({ acknowledged: true });
      return true; // Keep message channel open

    case 'HEALTH_WARNING':
      console.warn('⚠️ Health warning from content script:', message.message);
      console.warn(`   Last intercept: ${new Date(message.lastIntercept).toLocaleString()}`);
      console.warn(`   Total interceptions: ${message.totalInterceptions}`);

      // Store health warning
      chrome.storage.local.set({
        last_health_warning: {
          message: message.message,
          timestamp: Date.now(),
          lastIntercept: message.lastIntercept,
          totalInterceptions: message.totalInterceptions
        }
      });

      sendResponse({ acknowledged: true });
      return true; // Keep message channel open

    case 'GET_STATS':
      // Async stats retrieval
      getStorageStats()
        .then(stats => {
          sendResponse({ success: true, stats: stats });
        })
        .catch(error => {
          sendResponse({ success: false, error: error.message });
        });
      return true; // Keep channel open

    case 'SYNC_TO_SUPABASE':
      // Day 2: Sync messages to Supabase with embeddings
      // TEMPORARY: Disabled due to module loading issue
      console.warn('⚠️ SYNC_TO_SUPABASE temporarily disabled - module loading issue');
      sendResponse({
        success: false,
        error: 'Sync functionality temporarily disabled. Day 3 context injection works independently.'
      });
      return true;

    case 'SEARCH_MESSAGES':
      // Day 2: Search messages by semantic similarity
      // TEMPORARY: Disabled due to module loading issue
      console.warn('⚠️ SEARCH_MESSAGES temporarily disabled - module loading issue');
      sendResponse({
        success: false,
        error: 'Search functionality temporarily disabled. Use GET_CONTEXT for Day 3 context injection.'
      });
      return true;

    case 'FIND_SIMILAR':
      // Day 2: Find messages similar to a given message
      // TEMPORARY: Disabled due to module loading issue
      console.warn('⚠️ FIND_SIMILAR temporarily disabled - module loading issue');
      sendResponse({
        success: false,
        error: 'Find similar functionality temporarily disabled. Use GET_CONTEXT for Day 3 context injection.'
      });
      return true;

    case 'SET_API_CONFIG':
      // Day 2: Set API configuration (Supabase + OpenAI keys)
      // Inline implementation (no module dependency)
      console.log('🔧 Saving API configuration...');
      chrome.storage.local.set({ api_config: message.config })
        .then(() => {
          console.log('✅ API configuration saved');
          sendResponse({ success: true });
        })
        .catch(error => {
          console.error('❌ Config save error:', error);
          sendResponse({ success: false, error: error.message });
        });
      return true; // Keep channel open for async

    case 'GET_CONTEXT':
      // Day 3: Get context for RAG injection (CSP fix - runs in background, no CSP restrictions)
      console.log('🔍 KYT Background: Context request for message:', message.userMessage.substring(0, 50) + '...');
      getContextForInjection(message.userMessage, message.config)
        .then(contextData => {
          console.log('✅ Context retrieved:', contextData.items?.length || 0, 'items');
          sendResponse(contextData);
        })
        .catch(error => {
          console.error('❌ Context retrieval error:', error);
          sendResponse({ success: false, error: error.message });
        });
      return true; // Keep channel open for async

    default:
      console.warn('⚠️ Unknown message type:', message.type);
      sendResponse({ success: false, error: 'Unknown message type' });
      return true; // Keep message channel open
  }
});

/**
 * Health monitoring - Periodic storage stats logging
 */
chrome.alarms.create('health_check', { periodInMinutes: 5 });

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'health_check') {
    const stats = await getStorageStats();

    if (stats) {
      console.log('📊 KYT Health Check:', {
        messages: stats.totalMessages,
        errors: stats.totalErrors,
        storage: `${stats.storageSizeKB}KB / ${stats.storageLimitKB}KB (${stats.usagePercent}%)`,
        lastSave: `${Math.floor(stats.timeSinceLastSave / 1000)}s ago`
      });

      // Warn if storage > 80%
      if (parseFloat(stats.usagePercent) > 80) {
        console.warn('⚠️ WARNING: Storage usage > 80%! Consider archiving old messages.');
      }

      // Warn if no saves for 10 minutes
      if (stats.timeSinceLastSave > 10 * 60 * 1000 && stats.totalMessages > 0) {
        console.warn('⚠️ WARNING: No messages saved in 10+ minutes. User inactive or API broken?');
      }
    }
  }
});

/**
 * Extension installation - Initialize storage
 */
chrome.runtime.onInstalled.addListener((details) => {
  console.log('🔧 KYT: Extension installed/updated:', details.reason);

  if (details.reason === 'install') {
    // Initialize storage on first install
    chrome.storage.local.set({
      captured_messages: [],
      error_log: [],
      install_date: Date.now(),
      version: chrome.runtime.getManifest().version
    }).then(() => {
      console.log('✅ KYT: Storage initialized');
    }).catch(error => {
      console.error('❌ KYT: Failed to initialize storage:', error);
    });
  }
});

/**
 * Expose debug functions for service worker console testing
 * Note: chrome.runtime.sendMessage() doesn't work from service worker to itself
 * Use these direct function calls instead:
 */
globalThis.KYT_DEBUG = {
  // Get storage statistics
  getStats: () => getStorageStats().then(console.log),

  // Get context for a test message
  getContext: (message) => getContextForInjection(message, {}).then(console.log),

  // View current storage
  viewStorage: () => chrome.storage.local.get(null).then(console.log),

  // Clear all storage (use with caution!)
  clearStorage: () => chrome.storage.local.clear().then(() => console.log('✅ Storage cleared'))
};

console.log('✅ KYT Background: Service worker ready');
console.log('   Debug: Use KYT_DEBUG object for testing');
console.log('   - KYT_DEBUG.getStats() - View storage statistics');
console.log('   - KYT_DEBUG.getContext("test message") - Test context retrieval');
console.log('   - KYT_DEBUG.viewStorage() - View all storage');
console.log('   Note: chrome.runtime.sendMessage() from service worker to itself does not work');
