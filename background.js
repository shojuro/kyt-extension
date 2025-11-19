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

// Day 2: Import browser-compatible sync and search modules
import { syncToSupabase, setApiConfig } from './src/browser-sync.js';
import { searchMessages, findSimilarMessages } from './src/browser-search.js';
import { applyMMR, MMR_PRESETS } from './src/mmr.js';

console.log('🚀 KYT Background: Service worker starting...');

// Track storage health
let totalMessagesSaved = 0;
let totalErrors = 0;
let lastSaveTime = Date.now();

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
    const syncResult = await syncToSupabase();
    if (syncResult.success) {
      console.log(`✅ Initial sync completed: ${syncResult.synced} messages synced`);
    } else {
      console.warn('⚠️ Initial sync failed:', syncResult.error);
    }
  } catch (error) {
    console.error('❌ Initial sync error:', error);
  }

  // Set up periodic sync alarm (every 5 minutes)
  await chrome.alarms.create('periodicSync', { periodInMinutes: 5 });
  console.log('⏰ Periodic sync alarm created (5 minute interval)');
});

// Day 4: Periodic sync handler
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'periodicSync') {
    console.log('⏰ Periodic sync triggered');

    try {
      const syncResult = await syncToSupabase();
      if (syncResult.success) {
        console.log(`✅ Periodic sync: ${syncResult.synced} messages synced`);
      } else {
        console.warn('⚠️ Periodic sync failed:', syncResult.error);
      }
    } catch (error) {
      console.error('❌ Periodic sync error:', error);
    }
  }
});

// Day 4: Check API configuration on startup
chrome.runtime.onStartup.addListener(async () => {
  console.log('🔍 KYT Background: Extension startup - checking API config');

  const result = await chrome.storage.local.get(['api_config']);
  if (!result.api_config) {
    console.warn('⚠️ API config not found - sync will fail until configured');
    console.warn('   Use SET_API_CONFIG message to configure Supabase + OpenAI keys');
  } else {
    console.log('✅ API config found');
  }
});

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
    // PHASE 1 FIX #2: Use cached API config (survives service worker sleep)
    const apiConfig = await getApiConfig();

    // Use provided config or defaults
    const contextConfig = {
      threshold: config?.threshold || 0.5,
      maxContextItems: config?.maxContextItems || 3,
      minDistance: config?.minDistance || 0.0,
      excludeRecentSeconds: config?.excludeRecentSeconds || 120, // CONTEXT POLLUTION FIX: Exclude last 2 minutes
      debugMode: config?.debugMode || false
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

    // VALIDATION FIX: Generate embedding with retry logic and exponential backoff
    const { embeddingData, queryEmbedding } = await retryWithBackoff(async () => {
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
        const statusCode = embeddingResponse.status;
        throw new Error(
          `OpenAI API error (${statusCode}): ${error.error?.message || embeddingResponse.statusText}`
        );
      }

      const data = await embeddingResponse.json();
      return {
        embeddingData: data,
        queryEmbedding: data.data[0].embedding
      };
    }, {
      maxRetries: MAX_RETRIES,
      initialDelay: INITIAL_RETRY_DELAY_MS,
      shouldRetry: (error) => {
        // Retry on 503 (Overloaded) and 500 (Internal Server Error)
        const retryable = error.message?.includes('503') || 
                          error.message?.includes('500') ||
                          error.message?.includes('Overloaded') ||
                          error.message?.includes('Internal server error');
        
        if (!retryable) {
          console.error(`❌ Non-retryable error: ${error.message}`);
        }
        
        return retryable;
      },
      onRetry: (attempt, error, delay) => {
        console.warn(
          `🔄 OpenAI API retry ${attempt}/${MAX_RETRIES} after ${delay}ms. ` +
          `Error: ${error.message}`
        );
      }
    });

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
          match_count: contextConfig.maxContextItems,
          exclude_recent_seconds: contextConfig.excludeRecentSeconds
        })
      }
    );

    if (!searchResponse.ok) {
      const error = await searchResponse.json().catch(() => ({}));
      throw new Error(`Supabase search error: ${error.message || searchResponse.statusText}`);
    }

    const contextItems = await searchResponse.json();

    // DEBUG: Log what we got back from Supabase (before MMR)
    console.log(`🔍 Context search returned ${contextItems.length} items (threshold: ${contextConfig.threshold}, exclude: ${contextConfig.excludeRecentSeconds}s)`);
    if (contextItems.length > 0) {
      const now = Date.now();
      contextItems.forEach((item, idx) => {
        const ageSeconds = Math.floor((now - item.msg_timestamp) / 1000);
        console.log(`   ${idx + 1}. Age: ${ageSeconds}s, Distance: ${item.distance.toFixed(3)}, Content: "${item.content.substring(0, 50)}..."`);
      });
    }

    // Filter by minimum distance
    let filteredItems = contextItems.filter(r => r.distance >= contextConfig.minDistance);

    // Apply MMR (Maximal Marginal Relevance) reranking for precision and diversity
    // Critical for "Lonely ICP" use case - prevents confusing "sister Jennifer" with "dog Jenn"
    if (filteredItems.length > 1) {
      const mmrConfig = contextConfig.mmrPreset || 'PRECISION'; // Default to PRECISION preset
      const mmrParams = MMR_PRESETS[mmrConfig] || MMR_PRESETS.PRECISION;
      
      console.log(`🎯 Applying MMR reranking (preset: ${mmrConfig}, λ=${mmrParams.lambda})`);
      
      filteredItems = applyMMR(
        filteredItems,
        contextConfig.maxContextItems,
        mmrParams.lambda,
        {
          requireEmbeddings: false,
          fallbackToRelevance: true,
          debugMode: contextConfig.debugMode || false
        }
      );
      
      console.log(`✅ MMR reranking complete: ${filteredItems.length} items selected`);
    }

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

    // VALIDATION FIX: Log API metrics periodically
    if (apiMetrics.totalAttempts % 10 === 0 && apiMetrics.totalAttempts > 0) {
      logApiMetrics();
    }

    return {
      success: true,
      items: filteredItems,
      formattedContext: formattedContext,
      elapsedMs: elapsedTime
    };

  } catch (error) {
    console.error('❌ Context retrieval failed:', error);
    
    // VALIDATION FIX: Log metrics on failure
    logApiMetrics();
    
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
        .then(async (success) => {
          if (success) {
            // CONTEXT POLLUTION FIX: Always sync immediately
            // Removed 4-minute batching window to prevent rapid-fire questions
            // from clustering in database before next query
            console.log('🚀 Immediate sync triggered');
            syncToSupabase()
              .then(syncResult => {
                if (syncResult.success) {
                  console.log(`✅ Immediate sync: ${syncResult.synced} messages synced`);
                }
              })
              .catch(err => {
                console.warn('⚠️ Immediate sync failed:', err);
              });

            sendResponse({ success: true });
          } else {
            sendResponse({ success: false });
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
