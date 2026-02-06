/**
 * KYT Memory Extension - Background Service Worker (Day 1-2)
 * Initialized: true
 *
 * Purpose: Receive captured messages from content script and store in chrome.storage
 * Day 2: Added sync and search capabilities for unified memory
 *
 * Compliance: CLAUDE.md Anti-Theater Rules
 * - Real storage verification (not console.log theater)
 * - Actual error handling
 * - Health monitoring for API fragility
 */

// Day 2: Import browser-compatible sync and search modules
import { syncToSupabase, setApiConfig } from './src/browser-sync.js';
import { searchMessages, findSimilarMessages, searchHybrid } from './src/browser-search.js';
import { applyMMR, MMR_PRESETS } from './src/mmr.js';
import { transformQuery, extractRecentTopics, fetchRecentTopicsFromSupabase } from './src/query-transformer.js';
import { queueProcessor } from './src/background/queue-processor.js';
import { buildMemoryInjection, buildEmptyInjection, buildErrorInjection } from './kyt-memory-injection-builder.js';
import { classifyContent } from './src/taxonomy-classifier.js';
import { applyKeywordBoost } from './src/keyword-boost.js';
import { filterByConfidence } from './src/confidence-filter.js';
import { HistoryImporter } from './src/history-import/index.js';
self.HistoryImporter = HistoryImporter; // Expose for debugging

let activeImporter = null;

// ===== DEBOUNCED SYNC SCHEDULING =====
// Replaces per-message immediate sync with batched debounce
let syncDebounceTimer = null;
let syncMaxWaitTimer = null;
const SYNC_DEBOUNCE_MS = 5000;   // 5 seconds after last save
const SYNC_MAX_WAIT_MS = 30000;  // Force sync after 30 seconds of continuous saves

/**
 * Schedule a debounced sync to Supabase.
 * Resets the 5s debounce timer on each call. Forces sync after 30s max-wait.
 * Persists kyt_sync_pending flag for service worker restart recovery.
 */
function scheduleDebouncedSync() {
  // Persist pending flag for crash recovery
  chrome.storage.local.set({ kyt_sync_pending: true });

  // Reset debounce timer
  if (syncDebounceTimer) {
    clearTimeout(syncDebounceTimer);
  }

  syncDebounceTimer = setTimeout(async () => {
    syncDebounceTimer = null;
    if (syncMaxWaitTimer) {
      clearTimeout(syncMaxWaitTimer);
      syncMaxWaitTimer = null;
    }
    await executeDebouncedSync();
  }, SYNC_DEBOUNCE_MS);

  // Start max-wait timer if not already running
  if (!syncMaxWaitTimer) {
    syncMaxWaitTimer = setTimeout(async () => {
      syncMaxWaitTimer = null;
      if (syncDebounceTimer) {
        clearTimeout(syncDebounceTimer);
        syncDebounceTimer = null;
      }
      await executeDebouncedSync();
    }, SYNC_MAX_WAIT_MS);
  }
}

/**
 * Execute the actual sync (called by debounce/max-wait timers)
 */
async function executeDebouncedSync() {
  try {
    console.log('🔄 Debounced sync triggered');
    const syncResult = await syncToSupabase();
    if (syncResult.success) {
      console.log(`✅ Debounced sync: ${syncResult.synced} messages synced (embeddings: ${syncResult.embeddingsGenerated ?? 'n/a'})`);
    } else {
      console.warn('⚠️ Debounced sync failed:', syncResult.error);
    }
  } catch (err) {
    console.warn('⚠️ Debounced sync error:', err.message);
  } finally {
    chrome.storage.local.set({ kyt_sync_pending: false });
  }
}

// Counter for throttling storage quota checks
let saveMessageCounter = 0;

// Initialize queue processor on startup
chrome.runtime.onStartup.addListener(() => {
  try {
    queueProcessor.initialize();
    queueProcessor.processQueue();
    // Also process any pending local queues (context invalidation recovery)
    processPendingLocalQueues();
  } catch (error) {
    console.error('❌ Failed to initialize queue processor on startup:', error);
    // Store error for later diagnosis
    chrome.storage.local.get(['error_log'], (result) => {
      const errors = result.error_log || [];
      errors.push({
        timestamp: Date.now(),
        context: 'queue_processor_startup',
        error: error.message,
        stack: error.stack
      });
      chrome.storage.local.set({ error_log: errors });
    });
  }
});

// Also initialize on install
chrome.runtime.onInstalled.addListener(() => {
  try {
    queueProcessor.initialize();
    queueProcessor.processQueue();
    // Also process any pending local queues (context invalidation recovery)
    processPendingLocalQueues();
  } catch (error) {
    console.error('❌ Failed to initialize queue processor on install:', error);
    // Store error for later diagnosis
    chrome.storage.local.get(['error_log'], (result) => {
      const errors = result.error_log || [];
      errors.push({
        timestamp: Date.now(),
        context: 'queue_processor_install',
        error: error.message,
        stack: error.stack
      });
      chrome.storage.local.set({ error_log: errors });
    });
  }
});

// Periodic queue processing (every 1 min - more aggressive for MV3 service worker keepalive)
chrome.alarms.create('processQueue', { periodInMinutes: 1 });

/**
 * Process pending local queues (context invalidation recovery)
 * Handles messages that were stored when service worker was unavailable
 */
async function processPendingLocalQueues() {
  try {
    // Process emergency queue (from content script fallback)
    const emergencyKey = 'kyt_emergency_queue';
    const emergencyResult = await chrome.storage.local.get([emergencyKey]);
    const emergencyQueue = emergencyResult[emergencyKey] || [];

    if (emergencyQueue.length > 0) {
      console.log(`🔄 Processing ${emergencyQueue.length} messages from emergency queue`);
      const failed = [];

      for (const message of emergencyQueue) {
        try {
          await saveMessage(message);
          console.log(`✅ Recovered emergency message: ${message.id}`);
        } catch (error) {
          console.error(`❌ Failed to recover emergency message ${message.id}:`, error);
          failed.push(message);
        }
      }

      // Update queue with any failed items
      await chrome.storage.local.set({ [emergencyKey]: failed });

      if (failed.length === 0) {
        console.log('✅ Emergency queue fully processed');
      } else {
        console.warn(`⚠️ ${failed.length} emergency messages failed, will retry later`);
      }
    }

    // Process unencrypted fallback queue (from queue-manager.js)
    const unencryptedKey = 'kyt_pending_unencrypted_queue';
    const unencryptedResult = await chrome.storage.local.get([unencryptedKey]);
    const unencryptedQueue = unencryptedResult[unencryptedKey] || [];

    if (unencryptedQueue.length > 0) {
      console.log(`🔄 Processing ${unencryptedQueue.length} messages from unencrypted queue`);
      const failed = [];

      for (const message of unencryptedQueue) {
        try {
          await saveMessage(message);
          console.log(`✅ Recovered unencrypted message: ${message.id}`);
        } catch (error) {
          console.error(`❌ Failed to recover unencrypted message ${message.id}:`, error);
          failed.push(message);
        }
      }

      // Update queue with any failed items
      await chrome.storage.local.set({ [unencryptedKey]: failed });

      if (failed.length === 0) {
        console.log('✅ Unencrypted queue fully processed');
      } else {
        console.warn(`⚠️ ${failed.length} unencrypted messages failed, will retry later`);
      }
    }
  } catch (error) {
    console.error('❌ Failed to process pending local queues:', error);
  }
}

// ... existing code ...

// ... existing code ...



// Day 4: Extension lifecycle - sync existing messages on install/update
chrome.runtime.onInstalled.addListener(async (details) => {
  console.log('🔄 KYT Background: Extension installed/updated');
  console.log(`   Reason: ${details.reason}`);

  // Sync all existing messages on extension install/update
  try {
    const syncResult = await syncToSupabase();
    if (syncResult.success) {
      console.log(`✅ Initial sync completed: ${syncResult.synced} messages synced`);
    } else {
      console.warn('⚠️ Initial sync failed:', syncResult.error);
    }
  } catch (error) {
    console.error('❌ Error during initial sync:', error);
  }
});



// PHASE 1 FIX #2: Service worker state preservation
let cachedApiConfig = null;
let configLoadTime = 0;
const CONFIG_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// VALIDATION FIX: Circuit breaker and retry logic for API resilience
let consecutiveApiFailures = 0;
let circuitBreakerOpenUntil = 0;
const CIRCUIT_BREAKER_THRESHOLD = 5; // Open circuit after 5 consecutive failures
const CIRCUIT_BREAKER_RESET_MS = 60 * 1000; // Reset after 60 seconds
const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY_MS = 1000; // 1 second

// Performance metrics
let apiMetrics = {
  totalAttempts: 0,
  successfulAttempts: 0,
  failedAttempts: 0,
  retriedAttempts: 0,
  circuitBreakerTrips: 0
};

// Storage metrics
let totalMessagesSaved = 0;
let lastSaveTime = 0;
let totalErrors = 0;

/**
 * Check if circuit breaker is open
 * @returns {boolean} True if circuit is open (API calls should be skipped)
 */
function isCircuitBreakerOpen() {
  const now = Date.now();
  if (circuitBreakerOpenUntil > now) {
    return true;
  }

  // Auto-reset if cooldown period has passed
  if (circuitBreakerOpenUntil > 0 && now >= circuitBreakerOpenUntil) {
    console.log('🔄 Circuit breaker auto-reset - resuming API calls');
    consecutiveApiFailures = 0;
    circuitBreakerOpenUntil = 0;
  }

  return false;
}

/**
 * Record API success (resets circuit breaker)
 */
function recordApiSuccess() {
  consecutiveApiFailures = 0;
  circuitBreakerOpenUntil = 0;
  apiMetrics.successfulAttempts++;
}

/**
 * Record API failure (may trip circuit breaker)
 */
function recordApiFailure() {
  consecutiveApiFailures++;
  apiMetrics.failedAttempts++;

  if (consecutiveApiFailures >= CIRCUIT_BREAKER_THRESHOLD && circuitBreakerOpenUntil === 0) {
    circuitBreakerOpenUntil = Date.now() + CIRCUIT_BREAKER_RESET_MS;
    apiMetrics.circuitBreakerTrips++;
    console.error(
      `⚠️ Circuit breaker OPENED - ${consecutiveApiFailures} consecutive failures. ` +
      `API calls suspended for ${CIRCUIT_BREAKER_RESET_MS / 1000}s`
    );
  }
}

/**
 * Retry a function with exponential backoff
 * @param {Function} fn - Async function to retry
 * @param {Object} options - Retry options
 * @returns {Promise<any>} Result from successful execution
 */
async function retryWithBackoff(fn, options = {}) {
  const {
    maxRetries = MAX_RETRIES,
    initialDelay = INITIAL_RETRY_DELAY_MS,
    shouldRetry = (error) => {
      // Retry on network errors and 503 (service unavailable)
      if (error.message?.includes('503') || error.message?.includes('Overloaded')) {
        return true;
      }
      // Retry on 500 (internal server error)
      if (error.message?.includes('500') || error.message?.includes('Internal server error')) {
        return true;
      }
      // Don't retry on 400-level errors (bad request, unauthorized, etc.)
      return false;
    },
    onRetry = (attempt, error, delay) => {
      console.warn(
        `⚠️ Retry attempt ${attempt}/${maxRetries} after ${delay}ms delay. ` +
        `Error: ${error.message}`
      );
    }
  } = options;

  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      apiMetrics.totalAttempts++;
      const result = await fn();

      // Success! Record it and reset retries
      if (attempt > 0) {
        apiMetrics.retriedAttempts++;
        console.log(`✅ Retry successful on attempt ${attempt + 1}`);
      }
      recordApiSuccess();
      return result;

    } catch (error) {
      lastError = error;

      // Don't retry if this is the last attempt or error is not retryable
      if (attempt === maxRetries || !shouldRetry(error)) {
        recordApiFailure();
        throw error;
      }

      // Calculate exponential backoff delay: 1s, 2s, 4s
      const delay = initialDelay * Math.pow(2, attempt);
      onRetry(attempt + 1, error, delay);

      // Wait before retrying
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  // This should never be reached, but just in case
  throw lastError;
}

/**
 * Log API performance metrics
 */
function logApiMetrics() {
  const successRate = apiMetrics.totalAttempts > 0
    ? ((apiMetrics.successfulAttempts / apiMetrics.totalAttempts) * 100).toFixed(1)
    : 0;

  const retryRate = apiMetrics.successfulAttempts > 0
    ? ((apiMetrics.retriedAttempts / apiMetrics.successfulAttempts) * 100).toFixed(1)
    : 0;

  console.log(
    `📊 API Metrics: ${apiMetrics.successfulAttempts}/${apiMetrics.totalAttempts} successful (${successRate}%), ` +
    `${apiMetrics.retriedAttempts} retried (${retryRate}%), ` +
    `${apiMetrics.failedAttempts} failed, ` +
    `${apiMetrics.circuitBreakerTrips} circuit breaker trips`
  );
}

/**
 * Get API config with caching to survive service worker sleep
 */
async function getApiConfig() {
  if (cachedApiConfig && (Date.now() - configLoadTime) < CONFIG_CACHE_TTL) {
    console.log('📦 Using cached API config');
    return cachedApiConfig;
  }

  console.log('📥 Loading API config from storage');
  const result = await chrome.storage.local.get(['api_config']);
  if (!result.api_config) {
    throw new Error('API configuration not found - run setup.html');
  }

  cachedApiConfig = result.api_config;
  configLoadTime = Date.now();
  return cachedApiConfig;
}

// Clear cache before service worker suspends
chrome.runtime.onSuspend.addListener(() => {
  console.log('⏸️ Service worker suspending - clearing config cache');
  cachedApiConfig = null;
  configLoadTime = 0;
});

// Day 4: Extension lifecycle - sync existing messages on install/update
chrome.runtime.onInstalled.addListener(async (details) => {
  console.log('🔄 KYT Background: Extension installed/updated');
  console.log(`   Reason: ${details.reason}`);

  // Sync all existing messages
  try {
    // const syncResult = await syncToSupabase();
    // if (syncResult.success) {
    //   console.log(`✅ Initial sync completed: ${syncResult.synced} messages synced`);
    // } else {
    //   console.warn('⚠️ Initial sync failed:', syncResult.error);
    // }
  } catch (error) {
    console.error('❌ Initial sync error:', error);
  }

  // Set up periodic sync alarm (every 5 minutes)
  await chrome.alarms.create('periodicSync', { periodInMinutes: 5 });
  console.log('⏰ Periodic sync alarm created (5 minute interval)');
});

// Periodic sync handler is in the consolidated alarm listener below

// Day 4: Check API configuration on startup
chrome.runtime.onStartup.addListener(async () => {
  console.log('🔍 KYT Background: Extension startup - checking API config');

  const result = await chrome.storage.local.get(['api_config', 'kyt_sync_pending']);
  if (!result.api_config) {
    console.warn('⚠️ API config not found - sync will fail until configured');
    console.warn('   Use SET_API_CONFIG message to configure Supabase + OpenAI keys');
  } else {
    console.log('✅ API config found');

    // Recover pending sync from a previous service worker that was terminated mid-debounce
    if (result.kyt_sync_pending) {
      console.log('🔄 Recovering pending sync from previous session');
      await chrome.storage.local.set({ kyt_sync_pending: false });
      try {
        const syncResult = await syncToSupabase();
        if (syncResult.success) {
          console.log(`✅ Startup recovery sync: ${syncResult.synced} messages synced`);
        }
      } catch (err) {
        console.warn('⚠️ Startup recovery sync failed:', err.message);
      }
    }
  }
});

/**
 * Save captured message to chrome.storage.local
 * @param {Object} messageData - Extracted message data from content script
 * @returns {Promise<boolean>} Success status
 */
/**
 * Generate content-only hash for deduplication
 * CRITICAL: Uses content only (no timestamp) to detect duplicates across sources
 * @param {string} content - Message content
 * @returns {Promise<string>} SHA-256 hash (hex)
 */
async function hashContent(content) {
  // Normalize content first
  const normalized = content.trim().normalize('NFC');

  // Convert to UTF-8 bytes
  const encoder = new TextEncoder();
  const data = encoder.encode(normalized);

  // SHA-256 hash
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);

  // Convert to hex string
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

  return hashHex;
}

/**
 * Check for duplicate message within time window
 * @param {Array} messages - Existing messages
 * @param {string} contentHash - Hash of new message content
 * @param {number} timestamp - New message timestamp
 * @param {number} windowMs - Dedup window in milliseconds (default 5000)
 * @returns {Object|null} Duplicate message if found, null otherwise
 */
function findDuplicate(messages, contentHash, timestamp, windowMs = 5000) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];

    // Check if within time window
    const timeDiff = Math.abs(timestamp - (msg.timestamp || msg.capturedAt));
    if (timeDiff > windowMs) {
      // Messages are sorted by time, so we can stop here
      break;
    }

    // Check hash match
    if (msg.contentHash === contentHash) {
      return msg;
    }
  }

  return null;
}

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
    const result = await chrome.storage.local.get(['captured_messages', 'kyt_stats']);
    const messages = result.captured_messages || [];
    const stats = {
      messagesCaptured: { api: 0, dom: 0 },
      lastCapture: { api: null, dom: null },
      duplicatesBlocked: 0,
      ...(result.kyt_stats || {})
    };

    // Ensure nested objects exist (in case of partial corruption)
    if (!stats.messagesCaptured) stats.messagesCaptured = { api: 0, dom: 0 };
    if (!stats.lastCapture) stats.lastCapture = { api: null, dom: null };

    // Generate content-only hash for deduplication
    const contentHash = await hashContent(messageData.content);
    const timestamp = messageData.timestamp || Date.now();

    // Check for duplicates within 5-second window (or infinite for rescan)
    // If source is 'dom_rescan', we check entire history to prevent duplicates of already-synced messages
    const windowMs = messageData.source === 'dom_rescan' ? Infinity : 5000;
    const duplicate = findDuplicate(messages, contentHash, timestamp, windowMs);

    if (duplicate) {
      console.log(`🔄 KYT Background: Duplicate detected (blocked)`);
      console.log(`   Content: "${messageData.content.substring(0, 50)}..."`);
      console.log(`   Hash: ${contentHash.substring(0, 16)}...`);
      console.log(`   Original source: ${duplicate.source || 'unknown'}`);
      console.log(`   New source: ${messageData.source || 'unknown'}`);

      stats.duplicatesBlocked = (stats.duplicatesBlocked || 0) + 1;
      await chrome.storage.local.set({ kyt_stats: stats });

      return { saved: false, reason: 'duplicate', duplicateOf: duplicate.messageId };
    }

    // Add new message with content hash
    const newMessage = {
      ...messageData,
      contentHash,
      capturedAt: Date.now(),
      messageId: messageData.messageId || generateMessageId(),
      timestamp: timestamp
    };

    messages.push(newMessage);

    // Update stats by source
    const source = messageData.source || 'api';
    stats.messagesCaptured[source] = (stats.messagesCaptured[source] || 0) + 1;
    stats.lastCapture[source] = Date.now();

    // Store updated array and stats
    await chrome.storage.local.set({
      captured_messages: messages,
      kyt_stats: stats
    });

    // Update metrics
    totalMessagesSaved++;
    lastSaveTime = Date.now();

    console.log(`✅ KYT Background: Message saved (total: ${messages.length})`);
    console.log(`   Content: "${messageData.content.substring(0, 50)}..."`);
    console.log(`   Source: ${source}`);
    console.log(`   Hash: ${contentHash.substring(0, 16)}...`);

    // Check storage quota and evict if needed (every 50th save to reduce noise)
    saveMessageCounter++;
    const shouldCheckQuota = saveMessageCounter % 50 === 0;
    const quotaStatus = shouldCheckQuota ? await checkStorageQuota() : null;
    if (quotaStatus) {
      console.log(`📊 Storage: ${quotaStatus.usagePercent.toFixed(1)}% (${quotaStatus.messageCount} messages)`);
    }

    if (quotaStatus && quotaStatus.isExceeded) {
      console.warn(`⚠️  Storage quota exceeded (${quotaStatus.usagePercent.toFixed(1)}% > ${STORAGE_CONFIG.MAX_USAGE_PERCENT}%)`);
      const evictionResult = await evictOldMessages();

      if (evictionResult.evicted > 0) {
        console.log(`✅ Evicted ${evictionResult.evicted} old messages`);
        console.log(`   Storage reduced: ${evictionResult.oldUsagePercent.toFixed(1)}% → ${evictionResult.newUsagePercent.toFixed(1)}%`);
      } else if (evictionResult.reason === 'at_minimum') {
        console.warn(`⚠️  Cannot evict - at minimum message threshold (${STORAGE_CONFIG.MIN_MESSAGES_TO_KEEP})`);
      }
    }

    return { saved: true, messageId: newMessage.messageId };

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

    return { saved: false, reason: 'error', error: error.message };
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
 * Storage Quota Management
 * Implements LRU eviction to prevent hitting chrome.storage.local 10MB limit
 */
const STORAGE_CONFIG = {
  MAX_USAGE_PERCENT: 80,  // Start eviction at 80% capacity
  TARGET_USAGE_PERCENT: 70, // Evict down to 70% capacity
  MIN_MESSAGES_TO_KEEP: 100 // Always keep at least 100 recent messages
};

/**
 * Check if storage quota is exceeded
 * @returns {Promise<Object>} Status object with usage info
 */
async function checkStorageQuota() {
  try {
    const result = await chrome.storage.local.get(['captured_messages']);
    const messages = result.captured_messages || [];

    // Calculate storage size (approximate)
    const storageSize = JSON.stringify(messages).length;
    const storageLimitBytes = chrome.storage.local.QUOTA_BYTES;
    const usagePercent = (storageSize / storageLimitBytes) * 100;

    return {
      isExceeded: usagePercent > STORAGE_CONFIG.MAX_USAGE_PERCENT,
      usagePercent: usagePercent,
      storageSize: storageSize,
      storageLimitBytes: storageLimitBytes,
      messageCount: messages.length
    };
  } catch (error) {
    console.error('❌ Failed to check storage quota:', error);
    return { isExceeded: false, error: error.message };
  }
}

/**
 * Evict old messages using LRU (Least Recently Used) strategy
 * @returns {Promise<Object>} Eviction result
 */
async function evictOldMessages() {
  try {
    console.log('🗑️  Storage quota exceeded - starting LRU eviction...');

    const result = await chrome.storage.local.get(['captured_messages']);
    const messages = result.captured_messages || [];

    if (messages.length <= STORAGE_CONFIG.MIN_MESSAGES_TO_KEEP) {
      console.warn('⚠️  Cannot evict - already at minimum message count');
      return { evicted: 0, reason: 'at_minimum' };
    }

    // Sort by timestamp (oldest first)
    const sorted = [...messages].sort((a, b) => {
      const timeA = a.capturedAt || a.timestamp || 0;
      const timeB = b.capturedAt || b.timestamp || 0;
      return timeA - timeB;
    });

    // Calculate target size
    const currentSize = JSON.stringify(messages).length;
    const targetSize = chrome.storage.local.QUOTA_BYTES * (STORAGE_CONFIG.TARGET_USAGE_PERCENT / 100);

    // Evict oldest messages until we reach target
    let evictedCount = 0;
    let currentMessages = [...messages];

    while (currentMessages.length > STORAGE_CONFIG.MIN_MESSAGES_TO_KEEP) {
      const newSize = JSON.stringify(currentMessages).length;

      if (newSize <= targetSize) {
        break;
      }

      // Remove oldest message
      const oldestIndex = currentMessages.findIndex(msg => {
        const time = msg.capturedAt || msg.timestamp || 0;
        const oldestTime = sorted[evictedCount].capturedAt || sorted[evictedCount].timestamp || 0;
        return time === oldestTime;
      });

      if (oldestIndex !== -1) {
        currentMessages.splice(oldestIndex, 1);
        evictedCount++;
      } else {
        break;
      }
    }

    // Save reduced message set
    await chrome.storage.local.set({ captured_messages: currentMessages });

    const newSize = JSON.stringify(currentMessages).length;
    const newUsagePercent = (newSize / chrome.storage.local.QUOTA_BYTES) * 100;

    console.log(`✅ Eviction complete:`);
    console.log(`   Evicted: ${evictedCount} messages`);
    console.log(`   Remaining: ${currentMessages.length} messages`);
    console.log(`   Old usage: ${(currentSize / chrome.storage.local.QUOTA_BYTES * 100).toFixed(1)}%`);
    console.log(`   New usage: ${newUsagePercent.toFixed(1)}%`);

    return {
      evicted: evictedCount,
      remaining: currentMessages.length,
      oldUsagePercent: (currentSize / chrome.storage.local.QUOTA_BYTES * 100),
      newUsagePercent: newUsagePercent
    };

  } catch (error) {
    console.error('❌ Eviction failed:', error);
    return { evicted: 0, error: error.message };
  }
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
    // PHASE 1 FIX #2: Use cached API config (survives service worker sleep)
    const apiConfig = await getApiConfig();

    // Use provided config or defaults
    const contextConfig = {
      threshold: config?.threshold || 0.5,
      maxContextItems: config?.maxContextItems || 3,
      minDistance: config?.minDistance || 0.0,
      excludeRecentSeconds: config?.excludeRecentSeconds || 120, // CONTEXT POLLUTION FIX: Exclude last 2 minutes
      debugMode: config?.debugMode || false,
      disableQueryTransformation: config?.disableQueryTransformation || false // Allow disabling via config
    };

    // VALIDATION FIX: Check circuit breaker before making API call
    if (isCircuitBreakerOpen()) {
      const waitSeconds = Math.ceil((circuitBreakerOpenUntil - Date.now()) / 1000);
      console.warn(
        `⚠️ Circuit breaker is OPEN - skipping context injection. ` +
        `Resets in ${waitSeconds}s (${consecutiveApiFailures} failures)`
      );
      return {
        contextString: '',
        contextItems: [],
        skippedReason: 'circuit_breaker_open',
        performance: {
          totalMs: performance.now() - startTime,
          circuitBreakerWaitSeconds: waitSeconds
        }
      };
    }

    // PHASE 7: Query Transformation (Dual ICP Support)
    let searchQuery = userMessage;
    let transformationMetadata = { transformed: false };

    if (!contextConfig.disableQueryTransformation) {
      try {
        // Get recent messages for context (to extract topics/emotional state)
        // PHASE 4 UPDATE: Fetch from Supabase for cross-device context
        const recentTopics = await fetchRecentTopicsFromSupabase(apiConfig);

        // Transform query
        const transformResult = await transformQuery(
          userMessage,
          {
            recentTopics: recentTopics,
            searchContext: 'chat_history'
          },
          apiConfig.openaiKey
        );

        if (transformResult.success && transformResult.transformed) {
          searchQuery = transformResult.optimizedQuery;
          transformationMetadata = {
            transformed: true,
            original: userMessage,
            optimized: searchQuery
          };
          console.log(`🔄 Query transformed: "${userMessage}" → "${searchQuery}"`);
        } else {
          console.log(`📊 Using original query (transformation ${transformResult.transformed ? 'succeeded' : 'skipped/failed'})`);
        }
      } catch (transformError) {
        console.warn('⚠️ Query transformation failed, using original query:', transformError);
      }
    }

    // VALIDATION FIX: Use searchHybrid for robust retrieval (Vector + BM25)
    // This replaces the manual embedding generation and raw Supabase fetch
    // Benefits:
    // 1. Adds BM25 keyword search (fixes "Kobe Bryant" keyword miss)
    // 2. Uses unified threshold (0.5)
    // 3. Handles query expansion automatically

    let contextItems = [];

    try {
      // Use transformed query if available, otherwise original
      const queryToUse = transformationMetadata.transformed ? searchQuery : userMessage;

      console.log(`🔍 Context Retrieval: Using query "${queryToUse}"`);

      // Calculate minTimestamp to exclude recent memories (Context Pollution Prevention)
      const minTimestamp = Date.now() - (contextConfig.excludeRecentSeconds * 1000);

      contextItems = await searchHybrid(queryToUse, {
        limit: contextConfig.maxContextItems,
        semanticThreshold: 0.50, // Supabase RPC already applies match_threshold; client-side 0.65 was redundant
        bm25Threshold: 0.1,
        enableBM25: true,
        enableSemantic: true,
        role: null, // Don't filter by role (get both user and assistant context)
        source: null, // Don't filter by source
        minTimestamp: minTimestamp // Pass temporal filter
      });

      console.log(`✅ Context Retrieval: Found ${contextItems.length} items via Hybrid Search`);

    } catch (searchError) {
      console.error('❌ Context Retrieval failed:', searchError);
      // Fallback to empty context
      contextItems = [];
    }

    // RECURSION GUARD: Filter out items that contain K.Y.T. protocol headers or artifacts
    // This prevents "turtles all the way down" if injection blocks were accidentally saved
    // IMPORTANT: Must be precise to avoid filtering legitimate content
    contextItems = contextItems.filter(item => {
      const content = item.content || '';

      // Check for specific injection block markers (high confidence)
      const hasInjectionHeader = content.includes("K.Y.T. MEMORY INJECTION PROTOCOL") ||
        content.includes("K.Y.T. — User's Personal Knowledge Base");

      // Check for injection artifacts (medium confidence)
      const hasInjectionArtifacts = content.includes("[RETRIEVAL_CONTEXT]") ||
        content.includes("[SESSION_CONTEXT]") ||
        content.includes("[DATA_PROVENANCE]") ||
        content.includes("[Retrieved Items]");

      // Check for nested injection markers (high confidence of recursion)
      const hasNestedMarkers = content.includes("[Memory Context") ||
        content.includes("[Query Optimized");

      // Only filter if we have strong evidence of injection block
      const isPolluted = hasInjectionHeader || hasInjectionArtifacts || hasNestedMarkers;

      if (isPolluted) {
        console.warn(`⚠️ Recursion Guard: Dropped polluted memory item (ID: ${item.id || 'unknown'})`);
      }
      return !isPolluted;
    });

    // META FLAG FILTER: Exclude debug/meta-conversations from retrieval
    // This prevents conversations ABOUT the system from polluting actual user data
    contextItems = contextItems.filter(item => {
      if (item.meta === true) {
        console.warn(`⚠️ Meta Filter: Dropped meta-conversation item (ID: ${item.id || 'unknown'})`);
        return false;
      }
      return true;
    });

    // Filter by minimum distance/score (client-side double check)
    // Note: searchHybrid returns 'weighted_score' which combines distance and BM25
    // We'll trust searchHybrid's filtering for now, but can add extra check if needed
    let filteredItems = contextItems;

    // Apply MMR (Maximal Marginal Relevance) reranking for precision and diversity
    // Critical for "Lonely ICP" use case - prevents confusing "sister Jennifer" with "dog Jenn"
    // CONTENT DEDUPLICATION: Remove exact duplicates
    // MMR handles semantic diversity, but exact duplicates waste slots
    const uniqueContent = new Set();
    filteredItems = filteredItems.filter(item => {
      const normalized = item.content.trim().toLowerCase();
      if (uniqueContent.has(normalized)) {
        if (contextConfig.debugMode) console.log(`Start duplicate filtered: ${item.id}`);
        return false;
      }
      uniqueContent.add(normalized);
      return true;
    });

    // Apply MMR (Maximal Marginal Relevance) reranking for precision and diversity
    if (filteredItems.length > 1) {
      const mmrConfig = contextConfig.mmrPreset || 'DIVERSITY'; // Default to DIVERSITY preset
      // RELEVANCE/DIVERSITY BALANCE: 50/50 — entity-specific queries need relevance priority
      const mmrLambda = 0.5;

      console.log(`🎯 Applying MMR reranking (preset: ${mmrConfig}, λ=${mmrLambda})`);

      filteredItems = applyMMR(
        filteredItems,
        contextConfig.maxContextItems,
        mmrLambda,
        {
          requireEmbeddings: false,
          fallbackToRelevance: true,
          debugMode: contextConfig.debugMode || false,
          // TAXONOMY BOOSTING: Prioritize facts/credentials over conversation chatter
          boostFunction: (item) => {
            const classification = classifyContent(item.content);
            let boost = 0.0;

            // 1. Content-Type Boosting
            if (classification.type === 'reference_data' && classification.intent === 'explicit_save') {
              boost += 0.25;
            } else if (classification.type === 'instruction') {
              boost += 0.20;
            } else if (classification.type === 'user_preference') {
              boost += 0.15;
            } else if (classification.type === 'factual_note') {
              boost += 0.15;
            }

            // 2. Source Boosting (Explicit Saves > Conversation Logs)
            // Items saved via CLI are deliberate knowledge; conversation logs are noisy.
            if (item.source === 'cli' || item.source === 'terminal') {
              boost += 0.50;
            }

            return boost;
          }
        }
      );

      console.log(`✅ MMR reranking complete: ${filteredItems.length} items selected`);
    }

    // Apply keyword coverage boost (v1.2.1)
    // Addresses MMR diversity (λ=0.3) de-ranking keyword-rich candidates
    // Critical for entity queries like "Jennifer's startup" or "PostgreSQL configuration"
    if (filteredItems.length > 1) {
      console.log(`🎯 Applying keyword boost for query: "${userMessage}"`);

      filteredItems = applyKeywordBoost(userMessage, filteredItems, {
        boostFactor: 0.3,  // 0-30% score increase based on keyword coverage
        debugMode: contextConfig.debugMode || false
      });

      console.log(`✅ Keyword boost complete: candidates re-sorted by boosted scores`);
    }

    // === PRIORITY 2: CONFIDENCE THRESHOLD FILTERING ===
    // Apply confidence threshold to reranked results
    // Philosophy: No results > wrong results (high precision, acceptable recall)
    // Uses cross_encoder_score from Jina reranker (0.0-1.0 calibrated scores)
    // Adaptive: 0.40 when semantic search contributed, 0.25 in BM25-only mode
    if (filteredItems.length > 0) {
      try {
        const semanticWasAvailable = contextItems.metadata?.semanticAvailable ?? true;
        const defaultThreshold = semanticWasAvailable ? 0.40 : 0.25;
        const confidenceThreshold = contextConfig.confidenceThreshold || defaultThreshold;
        if (!semanticWasAvailable) {
          console.log(`🎯 BM25-only mode detected — adaptive confidence threshold: ${confidenceThreshold}`);
        }
        console.log(`🎯 Applying confidence filter (threshold: ${confidenceThreshold}) to ${filteredItems.length} candidates...`);

        const filterResult = filterByConfidence(filteredItems, confidenceThreshold);

        // Log filtering results
        if (filterResult.status === 'success') {
          console.log(`✅ Confidence filter: ${filterResult.results.length}/${filteredItems.length} items passed (highest: ${filterResult.highestScore.toFixed(3)})`);
          filteredItems = filterResult.results;
        } else if (filterResult.status === 'low_confidence') {
          console.warn(`⚠️ Confidence filter: All ${filteredItems.length} items below threshold (highest: ${filterResult.highestScore.toFixed(3)})`);
          if (filterResult.suggestions && contextConfig.debugMode) {
            console.log(`💡 Suggestions:`, filterResult.suggestions);
          }
          // Philosophy: No results > wrong results
          filteredItems = [];
        } else {
          // no_results status
          console.log(`ℹ️ Confidence filter: No results to filter`);
          filteredItems = [];
        }

      } catch (error) {
        console.error('❌ Confidence filtering failed, falling back to keyword-boosted results:', error.message);
        // Graceful degradation: Keep keyword-boosted results if filter fails
        // filteredItems unchanged
      }
    }

    // === MEMORY INJECTION PROTOCOL v1.0 ===
    // Format context using Anti-Defiance Protocol
    const elapsedTime = performance.now() - startTime;

    let formattedContext = null;

    if (filteredItems.length > 0) {
      // Build retrieval result for injection builder
      const retrievalResult = {
        state: 'FOUND',
        items: filteredItems.map(item => ({
          id: item.message_id || item.id,
          content: item.content,
          platform: item.source === 'cli' ? 'terminal' : (item.platform || 'chatgpt'),
          timestamp: new Date(item.msg_timestamp || item.timestamp).toISOString(),
          similarity: item.distance ? (1 - item.distance) : (item.weighted_score || 0.5),
          source_type: item.source || 'conversation'
        })),
        latencyMs: elapsedTime,
        queryType: transformationMetadata.transformed ? 'HYBRID' : 'SEMANTIC',
        queryOriginal: userMessage,
        queryTransformed: transformationMetadata.transformed ? transformationMetadata.optimized : null
      };

      // Build injection block with anti-defiance directives
      formattedContext = buildMemoryInjection(retrievalResult, {
        debugMode: contextConfig.debugMode || false
      });

      console.log('✅ Memory Injection Protocol: Injection block built with', filteredItems.length, 'items');
    } else {
      // Empty state - allow LLM to use native search
      formattedContext = buildEmptyInjection(
        userMessage,
        transformationMetadata.transformed ? transformationMetadata.optimized : null,
        elapsedTime
      );

      console.log('ℹ️ Memory Injection Protocol: Empty injection (native search allowed)');
    }

    // VALIDATION FIX: Log API metrics periodically
    if (apiMetrics.totalAttempts % 10 === 0 && apiMetrics.totalAttempts > 0) {
      logApiMetrics();
    }

    return {
      success: true,
      items: filteredItems,
      formattedContext: formattedContext,
      elapsedMs: elapsedTime,
      transformation: transformationMetadata
    };

  } catch (error) {
    console.error('❌ Context retrieval failed:', error);

    // VALIDATION FIX: Log metrics on failure
    logApiMetrics();

    // Use Memory Injection Protocol error state
    const errorInjection = buildErrorInjection(
      error.code || 'RETRIEVAL_ERROR',
      error.message,
      userMessage
    );

    return {
      success: false,
      error: error.message,
      items: [],
      formattedContext: errorInjection
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
    case 'FLUSH_QUEUE':
      // Process both queue processor and pending local queues (context invalidation recovery)
      Promise.all([
        queueProcessor.processQueue(),
        processPendingLocalQueues()
      ])
        .then(([queueResult]) => sendResponse(queueResult || { success: true }))
        .catch(err => sendResponse({ error: err.message }));
      return true;

    case 'SYNC_MESSAGE':
      // Direct sync attempt from content script (via queue processor logic)
      queueProcessor.syncSingle(message.payload)
        .then(success => sendResponse({ success }))
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true;

    case 'SAVE_MESSAGE':
      // Save locally, then schedule debounced batch sync (not per-message)
      saveMessage(message.data)
        .then((result) => {
          if (result && result.saved !== false) {
            // Schedule debounced sync (batches multiple saves into one sync)
            scheduleDebouncedSync();
            sendResponse({ success: true, queued: true });
          } else {
            sendResponse({ success: true, queued: false, reason: result?.reason });
          }
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

    case 'DEBUG_LOG':
      console.log(`🐛 [Page Log]: ${message.message}`);
      if (message.data) {
        console.log('   Data:', message.data);
      }
      sendResponse({ acknowledged: true });
      return true;

    case 'DOM_OBSERVER_STATUS':
      // DOM observer status updates from content script
      console.log(`🔍 DOM Observer Status: ${message.status}`);
      if (message.restartAttempts > 0) {
        console.log(`   Restart attempts: ${message.restartAttempts}`);
      }

      // Update stats with observer health
      chrome.storage.local.get(['kyt_stats'], (result) => {
        const stats = result.kyt_stats || {};
        stats.observerStatus = message.status;
        stats.observerRestarts = message.restartAttempts;
        stats.lastObserverUpdate = Date.now();
        chrome.storage.local.set({ kyt_stats: stats });
      });

      sendResponse({ acknowledged: true });
      return true;

    case 'SYNC_TO_SUPABASE':
      // Day 2: Sync messages to Supabase with embeddings
      console.log('🔄 Manual sync requested');
      syncToSupabase()
        .then(result => {
          console.log('✅ Sync result:', result);
          sendResponse(result);
        })
        .catch(error => {
          console.error('❌ Sync failed:', error);
          sendResponse({ success: false, error: error.message });
        });
      return true;

    case 'SEARCH_MESSAGES':
      // Day 2: Search messages by semantic similarity
      console.log('🔍 Search requested:', message.query);
      searchMessages(message.query, message.limit)
        .then(results => {
          console.log('✅ Search results:', results.length, 'items');
          sendResponse({ success: true, results });
        })
        .catch(error => {
          console.error('❌ Search failed:', error);
          sendResponse({ success: false, error: error.message });
        });
      return true;

    case 'FIND_SIMILAR':
      // Day 2: Find messages similar to a given message
      console.log('🔍 Find similar requested for message:', message.messageId);
      findSimilarMessages(message.messageId, message.threshold)
        .then(results => {
          console.log('✅ Similar messages found:', results.length, 'items');
          sendResponse({ success: true, results });
        })
        .catch(error => {
          console.error('❌ Find similar failed:', error);
          sendResponse({ success: false, error: error.message });
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

      // Read debug mode from storage for Memory Injection Protocol
      chrome.storage.local.get(['kytDebugMode']).then(result => {
        const config = {
          ...message.config,
          debugMode: result.kytDebugMode || false
        };

        return getContextForInjection(message.userMessage, config);
      })
        .then(contextData => {
          console.log('✅ Context retrieved:', contextData.items?.length || 0, 'items');
          sendResponse(contextData);
        })
        .catch(error => {
          console.error('❌ Context retrieval error:', error);
          sendResponse({ success: false, error: error.message });
        });
      return true; // Keep channel open

    case 'GET_STATS':
      // Phase 2: Get diagnostic statistics for popup UI
      (async () => {
        try {
          // Get storage stats
          const storageStats = await getStorageStats();

          // Get API config
          const apiResult = await chrome.storage.local.get(['api_config']);
          const apiConfig = apiResult.api_config;

          // Get page-level stats from active tab's inject script
          let pageStats = null;
          try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (tab && tab.id) {
              // Send message to content script on active tab
              const response = await chrome.tabs.sendMessage(tab.id, {
                type: 'GET_PAGE_STATS'
              });

              if (response && response.success) {
                pageStats = response.stats;
              }
            }
          } catch (error) {
            console.warn('⚠️ Could not get page stats:', error.message);
            // Non-fatal - popup will show as inactive
          }

          const stats = {
            // Interception status (from inject script if available)
            fetch: pageStats?.fetch || { active: false },
            websocket: pageStats?.websocket || { active: false },
            domObserver: pageStats?.domObserver || { active: false },

            // Message counts
            totalMessages: storageStats?.totalMessages || 0,
            sessionMessages: pageStats?.totalInterceptions || 0,
            lastCaptureTime: pageStats?.lastInterceptionTime || storageStats?.lastSaveTime || null,

            // Platform detection
            platform: pageStats?.platform || null
          };

          sendResponse({ success: true, stats });
        } catch (error) {
          sendResponse({ success: false, error: error.message });
        }
      })();
      return true; // Keep channel open

    case 'TEST_CAPTURE':
      // Phase 2: Test message capture functionality
      (async () => {
        try {
          // Create a test message
          const testMessage = {
            content: 'Test message from diagnostic popup',
            role: 'user',
            source: 'test',
            timestamp: Date.now()
          };

          // Save it
          const saved = await saveMessage(testMessage);

          if (saved) {
            // Get updated count
            const stats = await getStorageStats();
            sendResponse({
              success: true,
              messageCount: stats.totalMessages
            });
          } else {
            sendResponse({
              success: false,
              error: 'Failed to save test message'
            });
          }
        } catch (error) {
          sendResponse({
            success: false,
            error: error.message
          });
        }
      })();
      return true; // Keep channel open

    case 'FORCE_SYNC':
      // Force resync all messages (clear syncedMessageIds first in popup, then trigger sync)
      (async () => {
        try {
          console.log('🔄 Force sync triggered from popup');
          const result = await syncToSupabase();
          console.log('✅ Force sync result:', result);
          sendResponse(result);
        } catch (error) {
          console.error('❌ Force sync failed:', error);
          sendResponse({ success: false, error: error.message });
        }
      })();
      return true; // Keep channel open

    case 'CHECK_IMPORT_STATUS':
      (async () => {
        try {
          const config = await getApiConfig();
          const importer = new HistoryImporter(config.supabaseUrl, config.supabaseKey, config.userId);
          const status = await importer.checkImportStatus(message.platform);
          sendResponse({ success: true, status });
        } catch (error) {
          console.error('Check import status failed:', error);
          sendResponse({ success: false, error: error.message });
        }
      })();
      return true;

    case 'START_HISTORY_IMPORT':
      (async () => {
        try {
          const config = await getApiConfig();

          if (activeImporter) {
            // Cancel existing if any (though UI should prevent this)
            await activeImporter.cancelImport();
          }

          activeImporter = new HistoryImporter(config.supabaseUrl, config.supabaseKey, config.userId);

          // Start import (async)
          activeImporter.startImport(
            message.platform,
            (progress) => {
              // Send progress updates to popup
              chrome.runtime.sendMessage({
                type: 'IMPORT_PROGRESS',
                progress
              }).catch(() => {
                // Popup might be closed, ignore
              });
            },
            async () => {
              // Fallback required - ask popup to prompt user for file
              // This is tricky because background cannot open file dialogs.
              // We need to signal the popup to ask for file, then popup sends file back?
              // Or we just fail here and tell popup to start ZIP import flow?

              // Better approach: If API fails, we throw/return specific error
              // and let the UI handle the "Switch to ZIP" flow.
              // The HistoryImporter.startImport logic I wrote expects a callback that returns a File.
              // This won't work directly in background script.

              // Refactoring plan:
              // The `startImport` method in `HistoryImporter` currently handles the fallback logic internally.
              // But `onFallbackRequired` callback cannot easily get a File from user in background context.
              // So we should probably split API and ZIP import in the Orchestrator or handle the fallback in UI.

              // For now, let's assume we just fail if API fails, and UI initiates ZIP import explicitly.
              // So we pass a callback that just returns null or throws.
              return null;
            }
          ).then(result => {
            sendResponse({ success: true, result });
            activeImporter = null;
          }).catch(error => {
            sendResponse({ success: false, error: error.message });
            activeImporter = null;
          });

        } catch (error) {
          console.error('Start import failed:', error);
          sendResponse({ success: false, error: error.message });
        }
      })();
      return true;

    case 'CANCEL_HISTORY_IMPORT':
      if (activeImporter) {
        activeImporter.cancelImport();
        activeImporter = null;
      }
      sendResponse({ success: true });
      return true;

    case 'PROCESS_IMPORTED_MESSAGES':
      // Handle messages parsed from ZIP file in popup (Option B file transfer)
      (async () => {
        try {
          const { platform, messages, source } = message;

          if (!messages || !Array.isArray(messages) || messages.length === 0) {
            sendResponse({ success: false, error: 'No messages to process' });
            return;
          }

          console.log(`📥 Processing ${messages.length} imported messages from ${platform} (${source})`);

          const config = await getApiConfig();

          // Create a temporary importer for batch saving
          const importer = new HistoryImporter(config.supabaseUrl, config.supabaseKey, config.userId);

          // Batch save the messages
          let savedCount = 0;
          let skippedCount = 0;
          const batchSize = 50;

          for (let i = 0; i < messages.length; i += batchSize) {
            const batch = messages.slice(i, i + batchSize);

            try {
              const result = await importer.saveBatch(batch);
              savedCount += result.saved || 0;
              skippedCount += result.skipped || 0;

              // Log progress
              console.log(`   Batch ${Math.floor(i / batchSize) + 1}: ${result.saved} saved, ${result.skipped} skipped`);
            } catch (batchError) {
              console.error(`   Batch ${Math.floor(i / batchSize) + 1} error:`, batchError);
              // Continue with next batch
            }
          }

          console.log(`✅ ZIP import complete: ${savedCount} saved, ${skippedCount} skipped`);

          sendResponse({
            success: true,
            saved: savedCount,
            skipped: skippedCount,
            total: messages.length
          });

        } catch (error) {
          console.error('❌ PROCESS_IMPORTED_MESSAGES failed:', error);
          sendResponse({ success: false, error: error.message });
        }
      })();
      return true;

    default:
      console.warn('⚠️ Unknown message type:', message.type);
      sendResponse({ success: false, error: 'Unknown message type' });
      return true; // Keep message channel open
  }
});

/**
 * Health monitoring - alarm created alongside others
 */
chrome.alarms.create('health_check', { periodInMinutes: 5 });

/**
 * CONSOLIDATED ALARM LISTENER
 * Handles all alarms: processQueue, periodicSync, health_check
 * Replaces 4 separate listeners that were scattered across the file
 */
chrome.alarms.onAlarm.addListener(async (alarm) => {
  switch (alarm.name) {
    case 'processQueue':
      try {
        queueProcessor.processQueue();
        processPendingLocalQueues();
      } catch (error) {
        console.error('❌ Failed to process queue on alarm:', error);
        chrome.storage.local.get(['error_log'], (result) => {
          const errors = result.error_log || [];
          errors.push({
            timestamp: Date.now(),
            context: 'queue_processor_alarm',
            error: error.message,
            stack: error.stack
          });
          chrome.storage.local.set({ error_log: errors });
        });
      }
      break;

    case 'periodicSync':
      try {
        // Also check if there's a pending sync from a crashed debounce timer
        const pendingResult = await chrome.storage.local.get(['kyt_sync_pending']);
        if (pendingResult.kyt_sync_pending) {
          console.log('⏰ Periodic sync: recovering pending debounced sync');
          await chrome.storage.local.set({ kyt_sync_pending: false });
        }

        const syncResult = await syncToSupabase();
        if (syncResult.success && syncResult.synced > 0) {
          console.log(`✅ Periodic sync: ${syncResult.synced} messages synced`);
        }
      } catch (error) {
        console.error('❌ Periodic sync error:', error);
      }
      break;

    case 'health_check': {
      const stats = await getStorageStats();
      if (stats) {
        console.log('📊 KYT Health Check:', {
          messages: stats.totalMessages,
          errors: stats.totalErrors,
          storage: `${stats.storageSizeKB}KB / ${stats.storageLimitKB}KB (${stats.usagePercent}%)`,
          lastSave: `${Math.floor(stats.timeSinceLastSave / 1000)}s ago`
        });

        if (parseFloat(stats.usagePercent) > STORAGE_CONFIG.MAX_USAGE_PERCENT) {
          console.warn(`⚠️ Storage usage > ${STORAGE_CONFIG.MAX_USAGE_PERCENT}% - triggering eviction`);
          evictOldMessages().then(evictionResult => {
            if (evictionResult.evicted > 0) {
              console.log(`✅ Health check eviction: ${evictionResult.evicted} messages removed`);
            }
          }).catch(err => {
            console.error('❌ Health check eviction failed:', err);
          });
        }

        if (stats.timeSinceLastSave > 10 * 60 * 1000 && stats.totalMessages > 0) {
          console.warn('⚠️ WARNING: No messages saved in 10+ minutes. User inactive or API broken?');
        }
      }
      break;
    }

    default:
      console.warn(`⚠️ Unknown alarm: ${alarm.name}`);
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
      version: chrome.runtime.getManifest().version,
      show_import_onboarding: true, // Show import prompt on first install
      api_config: {
        // Phase 1 Fix: Enable semantic search by default
        // Disables query transformation that breaks semantic matching
        disableQueryTransformation: true
      }
    }).then(() => {
      console.log('✅ KYT: Storage initialized');
      console.log('   Phase 1 fix enabled: disableQueryTransformation = true');
      console.log('   First-install import onboarding: enabled');
    }).catch(error => {
      console.error('❌ KYT: Failed to initialize storage:', error);
    });
  } else if (details.reason === 'update') {
    // Migration: Set Phase 1 default for existing users
    chrome.storage.local.get(['api_config'], (result) => {
      const existingConfig = result.api_config || {};

      // Only set default if user hasn't explicitly configured this flag
      if (existingConfig.disableQueryTransformation === undefined) {
        const updatedConfig = {
          ...existingConfig,
          disableQueryTransformation: true
        };

        chrome.storage.local.set({ api_config: updatedConfig }, () => {
          console.log('✅ KYT: Phase 1 migration complete');
          console.log('   disableQueryTransformation = true (default)');
        });
      } else {
        console.log('⏩ KYT: User has existing preference, preserving it');
        console.log(`   disableQueryTransformation = ${existingConfig.disableQueryTransformation}`);
      }
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

// Initialize queue processor
queueProcessor.initialize();

// Note: queue processing alarm 'processQueue' is created above (line ~141)
// Consolidated alarm listener handles all alarms below
