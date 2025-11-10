/**
 * KYT Memory Extension - Background Service Worker (Day 1 Validation)
 *
 * Purpose: Receive captured messages from content script and store in chrome.storage
 * Strategy: Simple message relay for Day 1 (no external APIs yet)
 *
 * Compliance: CLAUDE.md Anti-Theater Rules
 * - Real storage verification (not console.log theater)
 * - Actual error handling
 * - Health monitoring for API fragility
 */

'use strict';

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
      break;

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
      break;

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

    default:
      console.warn('⚠️ Unknown message type:', message.type);
      sendResponse({ success: false, error: 'Unknown message type' });
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
 * Expose debug functions via chrome.runtime
 * Usage: chrome.runtime.sendMessage({type: 'GET_STATS'}, console.log)
 */
console.log('✅ KYT Background: Service worker ready');
console.log('   Debug: chrome.runtime.sendMessage({type: "GET_STATS"}, console.log)');
