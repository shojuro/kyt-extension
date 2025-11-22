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
import { searchMessages, findSimilarMessages, searchHybrid } from './src/browser-search.js';
import { applyMMR, MMR_PRESETS } from './src/mmr.js';
import { transformQuery, extractRecentTopics, fetchRecentTopicsFromSupabase } from './src/query-transformer.js';
import { queueProcessor } from './src/background/queue-processor.js';
import { buildMemoryInjection, buildEmptyInjection, buildErrorInjection } from './kyt-memory-injection-builder.js';
import { classifyContent } from './src/taxonomy-classifier.js';

// ... existing imports ...

// Initialize queue processor on startup
chrome.runtime.onStartup.addListener(() => {
  queueProcessor.initialize();
  queueProcessor.processQueue();
});

// Also initialize on install
chrome.runtime.onInstalled.addListener(() => {
  queueProcessor.initialize();
  queueProcessor.processQueue();
});

// Periodic queue processing (every 5 mins)
chrome.alarms.create('processQueue', { periodInMinutes: 5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'processQueue') {
    queueProcessor.processQueue();
  }
});

// ... existing code ...

// ... existing code ...



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

      contextItems = await searchHybrid(queryToUse, {
        limit: contextConfig.maxContextItems,
        semanticThreshold: 0.65, // PRECISION TUNING: Increased to 0.65 (User: Precision > Recall)
        bm25Threshold: 0.1,
        enableBM25: true,
        enableSemantic: true,
        role: null, // Don't filter by role (get both user and assistant context)
        source: null // Don't filter by source
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
      // DIVERSITY TUNING: Override lambda to 0.3 for better entity separation
      const mmrLambda = 0.3;

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
      queueProcessor.processQueue()
        .then(result => sendResponse(result))
        .catch(err => sendResponse({ error: err.message }));
      return true;

    case 'SYNC_MESSAGE':
      // Direct sync attempt from content script (via queue processor logic)
      queueProcessor.syncSingle(message.payload)
        .then(success => sendResponse({ success }))
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true;

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

    case 'DEBUG_LOG':
      console.log(`🐛 [Page Log]: ${message.message}`);
      if (message.data) {
        console.log('   Data:', message.data);
      }
      sendResponse({ received: true });
      return true;

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
      version: chrome.runtime.getManifest().version,
      api_config: {
        // Phase 1 Fix: Enable semantic search by default
        // Disables query transformation that breaks semantic matching
        disableQueryTransformation: true
      }
    }).then(() => {
      console.log('✅ KYT: Storage initialized');
      console.log('   Phase 1 fix enabled: disableQueryTransformation = true');
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

// Set up periodic alarm for queue processing
chrome.alarms.create('process_queue', { periodInMinutes: 1 });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'process_queue') {
    queueProcessor.processQueue();
  }
});
