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
import { syncToSupabase, setApiConfig, backfillNullEmbeddings } from './src/browser-sync.js';
import { searchMessages, findSimilarMessages, searchHybrid, prewarmEmbeddingModel } from './src/browser-search.js';
import { applyMMR, MMR_PRESETS, extractEntities } from './src/mmr.js';
import { transformQuery, extractRecentTopics, fetchRecentTopicsFromSupabase } from './src/query-transformer.js';
import { queueProcessor } from './src/background/queue-processor.js';
import { buildMemoryInjection, buildEmptyInjection, buildErrorInjection } from './kyt-memory-injection-builder.js';
import { callEdgeFunction } from './src/api-client.js';
import { classifyContent } from './src/taxonomy-classifier.js';
import { applyKeywordBoost } from './src/keyword-boost.js';
import { filterByConfidence } from './src/confidence-filter.js';
import { detectDeflection, applyDeflectionPenalty } from './src/assistant-quality-detector.js';
import { HistoryImporter } from './src/history-import/index.js';
import { getSession, refreshSession, isAuthenticated, getAccessToken, AUTH_SESSION_KEY } from './src/auth/auth-service.js';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './src/supabase-config.js';
import { syncViaEdgeFunction } from './src/edge-sync.js';
import { searchViaEdgeFunction } from './src/edge-search.js';
import { hydeCB } from './src/hyde-search-generator.js';
self.HistoryImporter = HistoryImporter; // Expose for debugging

let activeImporter = null;

// ===== DEFENSIVE TIMEOUT HELPER =====
// Races a promise against a timeout. On timeout, resolves with undefined
// instead of rejecting — callers treat undefined as "stage skipped".
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise(resolve => setTimeout(() => {
      console.warn(`\u23f1\ufe0f ${label} exceeded ${ms}ms, skipping`);
      resolve(undefined);
    }, ms))
  ]);
}

// ===== INJECTION PREFIX STRIPPING =====
// Strip KYT injection blocks that get captured with user messages.
// The content script captures messages AFTER the injection block is prepended,
// so both messages and chat_turns tables get polluted with the full injection context.
function stripInjectionPrefix(content) {
  if (!content) return { content, hadInjection: false };
  const separator = '\n---\n\n';
  const sepIdx = content.lastIndexOf(separator);
  if (sepIdx === -1) return { content, hadInjection: false };
  const prefix = content.substring(0, sepIdx);
  if (prefix.includes('K.Y.T.') || prefix.includes('[RETRIEVAL_CONTEXT]') ||
      prefix.includes('[SESSION_CONTEXT]') || prefix.includes('[DATA_PROVENANCE]')) {
    return { content: content.substring(sepIdx + separator.length).trim(), hadInjection: true };
  }
  return { content, hadInjection: false };
}

// ===== QUESTION DETECTION =====
// Heuristic: identifies user messages that are questions (P1 fix).
// Questions are tagged is_question=true and excluded from retrieval.
// Expanded: imperative request patterns (list/show/find/etc.) + short-content heuristic
// Keep in sync with save_chat_turn_batch/index.ts INTERROGATIVE_RE
const INTERROGATIVE_RE = /^(what|who|where|when|why|how|which|is|are|was|were|do|does|did|can|could|would|will|shall|should|have|has|had|tell me|remind me|do you know|do you remember|list|name|give|show|find|get|provide|suggest|recommend|describe|explain|identify|compare|summarize|rank|top (?:\d+|one|two|three|four|five|six|seven|eight|nine|ten))\b/i;

function detectIsQuestion(content, role) {
  if (role !== 'user') return false;
  const trimmed = (content || '').trim();
  if (trimmed.endsWith('?')) return true;
  if (INTERROGATIVE_RE.test(trimmed)) return true;
  // Short user prompts without assertions are likely requests/questions
  if (trimmed.length < 60 && !trimmed.includes('.') && !trimmed.includes('!')) return true;
  return false;
}

// ===== INJECTION HEALTH STATS =====
const INJECTION_STATS_KEY = 'kyt_injection_stats';

async function updateInjectionStats(update) {
  const result = await chrome.storage.local.get([INJECTION_STATS_KEY]);
  const stats = result[INJECTION_STATS_KEY] || {
    totalAttempts: 0,
    successful: 0,
    empty: 0,
    timeouts: 0,
    errors: 0,
    totalItemsReturned: 0,
    totalLatencyMs: 0,
    lastAttempt: null,
    lastSuccess: null,
    recentResults: [] // Last 10 results for popup display
  };

  if (update.attempt) {
    stats.totalAttempts++;
    stats.lastAttempt = Date.now();
  }
  if (update.success) {
    stats.successful++;
    stats.lastSuccess = Date.now();
    stats.totalItemsReturned += update.itemCount || 0;
  }
  if (update.empty) stats.empty++;
  if (update.timeout) stats.timeouts++;
  if (update.error) stats.errors++;
  if (update.latencyMs) stats.totalLatencyMs += update.latencyMs;

  if (update.result) {
    stats.recentResults.unshift({
      timestamp: Date.now(),
      success: !!update.success,
      items: update.itemCount || 0,
      latencyMs: update.latencyMs || 0,
      empty: !!update.empty,
      error: update.errorMsg || null
    });
    if (stats.recentResults.length > 10) stats.recentResults.pop();
  }

  await chrome.storage.local.set({ [INJECTION_STATS_KEY]: stats });
  return stats;
}

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
 * Execute the actual sync (called by debounce/max-wait timers).
 * Uses edge functions for authenticated users, legacy direct API otherwise.
 */
async function executeDebouncedSync() {
  try {
    console.log('🔄 Debounced sync triggered');
    const mode = await getRoutingMode();

    if (mode === 'edge') {
      // Edge function path: load messages and sync via server
      const stored = await chrome.storage.local.get(['captured_messages', 'last_sync_status']);
      const messages = stored.captured_messages || [];
      const syncStatus = stored.last_sync_status || { syncedMessageIds: [] };
      const syncedSet = new Set(syncStatus.syncedMessageIds || []);

      // Filter to unsynced messages
      const unsynced = messages.filter((m) => !syncedSet.has(m.messageId));
      if (unsynced.length === 0) {
        console.log('✅ Debounced sync: nothing to sync (all messages already synced)');
        return;
      }

      const syncResult = await syncViaEdgeFunction(unsynced);
      if (syncResult.success || syncResult.synced > 0) {
        // Mark synced
        const newSyncedIds = [...syncedSet, ...unsynced.map((m) => m.messageId)];
        await chrome.storage.local.set({
          last_sync_status: {
            syncedMessageIds: newSyncedIds,
            lastSyncTime: Date.now(),
          },
        });
        console.log(`✅ Debounced sync (edge): ${syncResult.synced} synced, ${syncResult.duplicates} dupes`);
      } else {
        console.warn('⚠️ Debounced sync (edge) failed:', syncResult.errors, 'errors');
      }
    } else {
      // Legacy path
      const syncResult = await syncToSupabase();
      if (syncResult.success) {
        console.log(`✅ Debounced sync: ${syncResult.synced} messages synced (embeddings: ${syncResult.embeddingsGenerated ?? 'n/a'})`);
      } else {
        console.warn('⚠️ Debounced sync failed:', syncResult.error);
      }
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
  const result = await chrome.storage.local.get(['api_config', AUTH_SESSION_KEY, 'user_id']);

  // Prefer auth session for authenticated users
  const session = result[AUTH_SESSION_KEY];
  if (session?.access_token && session.expires_at > Math.floor(Date.now() / 1000)) {
    cachedApiConfig = {
      supabaseUrl: SUPABASE_URL,
      supabaseKey: SUPABASE_ANON_KEY,
      accessToken: session.access_token,
      userId: session.user?.id || result.user_id,
      authMode: 'jwt',
      // Legacy fields — not needed for edge mode, but some code paths read them
      openaiKey: result.api_config?.openaiKey || null,
      huggingfaceKey: result.api_config?.huggingfaceKey || null,
      jinaKey: result.api_config?.jinaKey || null,
      disableQueryTransformation: result.api_config?.disableQueryTransformation ?? true,
    };
    configLoadTime = Date.now();
    return cachedApiConfig;
  }

  // Fall back to legacy api_config
  if (!result.api_config) {
    throw new Error('API configuration not found - run setup.html');
  }

  cachedApiConfig = result.api_config;
  // Resolve userId: prefer config > stored user_id (survives session expiry)
  if (!cachedApiConfig.userId) {
    cachedApiConfig.userId = result.user_id || null;
  }
  configLoadTime = Date.now();
  return cachedApiConfig;
}

/**
 * Determine routing mode: 'edge' (authenticated), 'legacy' (API keys), or 'unconfigured'.
 * Edge mode routes sync/search through Supabase Edge Functions.
 * Legacy mode uses direct HuggingFace + Supabase REST calls.
 */
async function getRoutingMode() {
  const result = await chrome.storage.local.get([AUTH_SESSION_KEY, 'api_config']);
  const session = result[AUTH_SESSION_KEY];
  if (session?.access_token && session.expires_at > Math.floor(Date.now() / 1000)) {
    return 'edge';
  }
  if (result.api_config?.supabaseUrl && result.api_config?.supabaseKey) {
    return 'legacy';
  }
  return 'unconfigured';
}

// ==========================================================================
// STEP 0: Client-side Preference Router
// Regex classifier that detects preference queries and short-circuits the
// vector pipeline. 0ms cost — runs before any embedding generation.
// Ported from supabase/functions/_shared/get_relevant_memories.ts
// ==========================================================================

/**
 * Detect if a query is asking about user preferences.
 * Returns the extracted category string (e.g. "car", "food") or null.
 *
 * Patterns:
 *   1. "what is/are/was my favorite/preferred/go-to X"
 *   2. "what X do/did I like/prefer/love/enjoy/use"
 *   3. "tell/remind me (about) my favorite/preferred X"
 *   4. "do/did I like/prefer/love/enjoy X" (value-based lookup)
 *   5. "which X is/was my favorite/preferred/go-to"
 *   6. "what kind of X do/did I like/prefer/enjoy"
 */
function detectPreferenceQuery(query) {
  const q = query.toLowerCase().trim()
    .replace(/what's/g, 'what is');  // Normalize contraction: "what's my" → "what is my"

  const patterns = [
    // Pattern 1: "what is my favorite car"
    /(?:what)\s+(?:is|are|was|were)\s+my\s+(?:favorite|favourite|preferred|go-to)\s+(.+?)(?:\?|$)/,
    // Pattern 6: "what kind of food do I like" (must precede Pattern 2 — more specific)
    // End anchor: \b not (?:\?|$) — allows "...like and why?" continuations
    /what\s+(?:kind|type|sort)\s+of\s+(.+?)\s+(?:do|did|does|would)\s+i\s+(?:like|prefer|love|enjoy)\b/,
    // Pattern 2: "what car do I like" / "what cars do I love and why"
    // End anchor: \b not (?:\?|$) — allows "...love and what do they say..." continuations
    /what\s+(.+?)\s+(?:do|did|does|would)\s+i\s+(?:like|prefer|love|enjoy|use)\b/,
    // Pattern 3: "tell me my favorite car" / "remind me about my preferred food"
    /(?:tell|remind)\s+me\s+(?:about\s+)?my\s+(?:favorite|favourite|preferred|go-to)\s+(.+?)(?:\?|$)/,
    // Pattern 4: "do I like Python" (value-based)
    /(?:do|did|does)\s+i\s+(?:like|prefer|love|enjoy)\s+(.+?)(?:\?|$)/,
    // Pattern 5: "which car is my favorite" / "which car is my favorite and why"
    // End anchor: \b not (?:\?|$) — allows "...favorite and why?" continuations
    /which\s+(.+?)\s+(?:is|are|was|were)\s+my\s+(?:favorite|favourite|preferred|go-to)\b/,
  ];

  for (const pattern of patterns) {
    const match = q.match(pattern);
    if (match && match[1]) {
      // Clean up the extracted category: strip punctuation + trailing filler phrases
      // (?:^|\s+) — handles both "cars and why" (mid-string) and "and what do they say" (start)
      const category = match[1]
        .replace(/[?.!,]/g, '')
        .replace(/(?:^|\s+)(?:and|or)\s+(?:why|how|when|where|who|what|which|how much|how many).*$/i, '')
        .trim();
      if (category.length > 0 && category.length < 50) {
        return category;
      }
    }
  }

  return null;
}

/**
 * Look up user preferences via Supabase REST RPC.
 * Auth: tries JWT first (may still be valid for Supabase REST even when
 * expired per extension's session check), falls back to anon key.
 * TODO: Multi-user: use JWT auth exclusively once token refresh is implemented
 *
 * @param {string} category - Preference category to look up
 * @param {object} apiConfig - From getApiConfig()
 * @returns {Array} Raw preference rows from the RPC
 */
async function lookupPreferencesViaREST(category, apiConfig) {
  // Resolve userId: apiConfig.userId (from JWT session) or fallback from storage
  let userId = apiConfig.userId;
  if (!userId) {
    const stored = await chrome.storage.local.get([AUTH_SESSION_KEY, 'user_id']);
    userId = stored[AUTH_SESSION_KEY]?.user?.id || stored.user_id || null;
  }
  if (!userId) {
    console.warn('⚠️ Preference router: no userId available, skipping lookup');
    return [];
  }

  // Build auth header: prefer JWT, fall back to anon key
  const authToken = apiConfig.accessToken || SUPABASE_ANON_KEY;
  const headers = {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_ANON_KEY,
    'Authorization': `Bearer ${authToken}`,
  };

  const url = `${SUPABASE_URL}/rest/v1/rpc/lookup_user_preferences`;
  const body = JSON.stringify({
    p_user_id: userId,
    p_category: category,
    p_limit: 3,  // Cap at 3 — dedup concern: 7 car rows floods injection, 3 suffices
  });

  try {
    const response = await withTimeout(
      fetch(url, { method: 'POST', headers, body }),
      10000,  // 10s — RPC is a simple DB query, should be fast
      'preference-lookup'
    );

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      console.warn(`⚠️ Preference lookup RPC failed: ${response.status} ${errText}`);
      return [];
    }

    const data = await response.json();
    return data || [];
  } catch (err) {
    console.warn(`⚠️ Preference lookup failed: ${err.message}`);
    return [];
  }
}

/**
 * Convert preference RPC rows to the injection item format expected by
 * buildMemoryInjection(). Mirrors the edge function's candidate synthesis.
 *
 * @param {Array} prefRows - Rows from lookup_user_preferences RPC
 * @returns {Array} Items shaped for the retrieval result
 */
function synthesizePreferenceItems(prefRows) {
  return prefRows.map(pref => {
    const sentimentLabel = pref.sentiment === 'positive' ? 'favorite'
      : pref.sentiment === 'negative' ? 'disliked'
      : '';
    const dateStr = pref.updated_at
      ? new Date(pref.updated_at).toLocaleDateString()
      : 'unknown date';

    const content = `User's ${sentimentLabel} ${pref.category}: ${pref.value}. Recorded: ${dateStr}.`;

    return {
      id: pref.source_turn_id || pref.id,
      content,
      platform: 'kyt',
      timestamp: pref.updated_at || pref.created_at || new Date().toISOString(),
      similarity: (pref.confidence || 0.8) * 0.9, // 0.8 * 0.9 = 0.72 (above 0.40 threshold)
      source_type: 'user_preference',
      preference_match: true,
    };
  });
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

  // Diagnostic: verify host_permissions are actually granted by Chrome
  chrome.permissions.getAll((perms) => {
    const origins = perms.origins || [];
    const required = [
      'https://api.openai.com/*',
      'https://router.huggingface.co/*',
      'https://api.jina.ai/*',
    ];
    console.log('🔑 KYT Host permissions diagnostic:');
    for (const origin of required) {
      const granted = origins.includes(origin);
      console.log(`   ${granted ? '✅' : '❌'} ${origin}`);
    }
    if (required.some(o => !origins.includes(o))) {
      console.warn('⚠️ Some host_permissions not granted. Try removing and re-adding the extension.');
    }
  });

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

  // Refresh auth session on startup if it exists
  try {
    const authed = await isAuthenticated();
    if (authed) {
      await refreshSession();
      console.log('✅ Auth session refreshed on startup');
    }
  } catch (err) {
    console.warn('⚠️ Auth session refresh on startup failed:', err.message);
  }

  const result = await chrome.storage.local.get(['api_config', AUTH_SESSION_KEY, 'kyt_sync_pending', 'kyt_last_save_time']);
  const hasAuth = result[AUTH_SESSION_KEY]?.access_token;
  const hasConfig = result.api_config?.supabaseUrl;

  // Restore lastSaveTime so health check doesn't show misleading "1770780747s ago" (Fix 4: RC4)
  if (result.kyt_last_save_time) {
    lastSaveTime = result.kyt_last_save_time;
    console.log(`Restored lastSaveTime from storage: ${Math.floor((Date.now() - lastSaveTime) / 1000)}s ago`);
  }

  if (!hasAuth && !hasConfig) {
    console.warn('⚠️ No auth session or API config — sync will fail until user signs in or configures keys');
  } else {
    console.log(`✅ Config found (mode: ${hasAuth ? 'authenticated' : 'legacy'})`);

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
 * Check for duplicate message by scanning last N messages
 * @param {Array} messages - Existing messages
 * @param {string} contentHash - Hash of new message content
 * @param {number} maxScan - Max messages to scan backwards (default 200)
 * @returns {Object|null} Duplicate message if found, null otherwise
 */
function findDuplicate(messages, contentHash, maxScan = 200) {
  const startIdx = Math.max(0, messages.length - maxScan);
  for (let i = messages.length - 1; i >= startIdx; i--) {
    if (messages[i].contentHash === contentHash) {
      return messages[i];
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

    // Check for duplicates by scanning last 200 messages (content-hash based, no time window)
    const duplicate = findDuplicate(messages, contentHash);

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

    // Strip KYT injection prefix before any analysis (Phase 2: prevents injection pollution)
    const injectionResult = stripInjectionPrefix(messageData.content);
    messageData.content = injectionResult.content;
    const hadInjection = injectionResult.hadInjection;

    // Detect assistant deflections/echoes (Layer 1: capture-time tagging)
    // For combined User+Assistant messages (role='user'), extract assistant text
    // and run detection on it. This kills the recursive capture loop (Gap D):
    // deflection responses get tagged at capture → filtered before sync.
    let captureDeflectionContent = messageData.content;
    let captureDeflectionRole = messageData.role;
    if (captureDeflectionRole !== 'assistant' && messageData.content) {
      const asstBlocks = [];
      const captureRe = /(?:^|\n\n)Assistant:\s*([\s\S]*?)(?=\n\nUser:|\s*$)/gi;
      let cm;
      while ((cm = captureRe.exec(messageData.content)) !== null) {
        asstBlocks.push(cm[1].trim());
      }
      if (asstBlocks.length > 0) {
        captureDeflectionContent = asstBlocks.join('\n');
        captureDeflectionRole = 'assistant';
      }
    }
    const deflectionCheck = detectDeflection(captureDeflectionContent, captureDeflectionRole);

    // Detect user questions (P1: exclude from retrieval)
    const isQuestion = detectIsQuestion(messageData.content, messageData.role);

    // Add new message with content hash
    const newMessage = {
      ...messageData,
      contentHash,
      capturedAt: Date.now(),
      messageId: messageData.messageId || generateMessageId(),
      timestamp: timestamp,
      ...(deflectionCheck.isDeflection ? { deflection: deflectionCheck.confidence } : {}),
      ...(isQuestion ? { is_question: true } : {}),
      ...(hadInjection ? { is_injection: true } : {})
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
    // Persist lastSaveTime so it survives service worker restarts (Fix 4: RC4)
    chrome.storage.local.set({ kyt_last_save_time: lastSaveTime });

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
/**
 * Entity-aware recency resolution — pure timestamp ordering.
 * When multiple items reference the same entity, the newest item always wins.
 * No negation heuristic — handles affirmation chains correctly:
 *   "Jerry is real" → "Jerry is not real" → "Jerry is now real"
 *
 * For each entity group: newest gets 1.5x boost, all older get 0.6x penalty.
 * Uses server entity data (item.entities[]) when available, falls back to regex.
 */
function applyRecencyResolution(items) {
  if (items.length <= 1) return items;

  // Group items by shared entities
  const entityGroups = new Map(); // entity -> [items]

  for (const item of items) {
    // Prefer server-provided entity data (canonical names from GPT-4o-mini extraction)
    const entities = (item.entities && item.entities.length > 0)
      ? new Set(item.entities.map(e => (e.canonical_name || e).toLowerCase()))
      : extractEntities(item);
    for (const entity of entities) {
      if (!entityGroups.has(entity)) entityGroups.set(entity, []);
      entityGroups.get(entity).push(item);
    }
  }

  // For each entity with multiple items, apply pure timestamp-based resolution
  const boosted = new Set();   // items that got a recency boost
  const penalized = new Set(); // items that got a recency penalty

  // Determine the score key (cross_encoder_score > distance > weighted_score)
  const scoreKey = items[0]?.cross_encoder_score != null ? 'cross_encoder_score'
      : items[0]?.distance != null ? 'distance'
      : 'weighted_score';

  for (const [entity, group] of entityGroups) {
    if (group.length < 2) continue;

    // Sort by timestamp descending (newest first)
    group.sort((a, b) => {
      const tA = new Date(a.msg_timestamp || a.timestamp || 0).getTime();
      const tB = new Date(b.msg_timestamp || b.timestamp || 0).getTime();
      return tB - tA;
    });

    const newest = group[0];
    const older = group.slice(1);

    // Confidence gate: if the highest-scoring older item significantly outscores
    // the newest, skip recency resolution for this entity. This prevents a
    // low-confidence assistant "revision" (e.g., 0.54) from overtaking a
    // high-confidence match (e.g., 0.93) via a small timestamp advantage.
    const newestScore = newest[scoreKey] ?? 0;
    const bestOlderScore = Math.max(...older.map(o => o[scoreKey] ?? 0));
    if (bestOlderScore - newestScore > 0.2) {
      console.log(`🕐 Recency SKIPPED: "${entity}" — oldest scores higher (${bestOlderScore.toFixed(3)} vs ${newestScore.toFixed(3)}, gap ${(bestOlderScore - newestScore).toFixed(3)})`);
      continue;
    }

    // Timestamp ordering: newest wins for any entity with multiple mentions
    if (!boosted.has(newest) && newest[scoreKey] != null) {
      newest[scoreKey] *= 1.5;
      boosted.add(newest);
      console.log(`🕐 Recency boost: "${entity}" — newest item boosted 1.5x`);
    }

    // Penalize all older items for this entity (mild — complementary facts survive)
    for (const old of older) {
      if (old[scoreKey] != null && !penalized.has(old)) {
        old[scoreKey] *= 0.8;
        penalized.add(old);
        console.log(`🕐 Recency penalty: "${entity}" — older item penalized 0.8x`);
      }
    }
  }

  return items;
}

async function getContextForInjection(userMessage, config) {
  const startTime = performance.now();
  console.log(`🔍 getContextForInjection() called with query: "${userMessage.substring(0, 80)}${userMessage.length > 80 ? '...' : ''}"`);

  try {
    // PHASE 1 FIX #2: Use cached API config (survives service worker sleep)
    const apiConfig = await getApiConfig();

    // Use provided config or defaults
    const contextConfig = {
      threshold: config?.threshold || 0.5,
      maxContextItems: config?.maxContextItems || 3,
      candidatePoolSize: config?.candidatePoolSize || 25, // Retrieve more candidates — headroom for echo/deflection filters before MMR
      minDistance: config?.minDistance || 0.0,
      excludeRecentSeconds: config?.excludeRecentSeconds || 120, // CONTEXT POLLUTION FIX: Exclude last 2 minutes
      debugMode: config?.debugMode || false,
      disableQueryTransformation: config?.disableQueryTransformation ?? apiConfig.disableQueryTransformation ?? false
    };

    // ========================================================================
    // STEP 0: Preference Query Router (0ms regex, before any embedding)
    // Short-circuits the entire vector pipeline for "what is my favorite X?"
    // If query has trailing qualifiers ("and why", "and how"), preference items
    // are saved but vector pipeline also runs to provide supporting context.
    // Path-independent — works whether queries go edge or legacy.
    // ========================================================================
    let prefItems = null;  // populated if preference router finds results
    const queryHasQualifier = /\b(?:and|or)\s+(?:why|how|when|where|who|what)\b/i.test(userMessage);
    try {
      const prefCategory = detectPreferenceQuery(userMessage);
      if (prefCategory) {
        console.log(`🎯 Preference router activated: category="${prefCategory}"${queryHasQualifier ? ' (has qualifier — will also run vector pipeline)' : ''}`);
        const prefRows = await lookupPreferencesViaREST(prefCategory, apiConfig);
        if (prefRows.length > 0) {
          prefItems = synthesizePreferenceItems(prefRows);

          // Short-circuit only if no trailing qualifier — pure "what is my favorite X?"
          if (!queryHasQualifier) {
            console.log(`✅ Preference router: ${prefItems.length} preferences found — short-circuiting vector pipeline`);

            const elapsedTime = performance.now() - startTime;

            const retrievalResult = {
              state: 'FOUND',
              items: prefItems.map(item => ({
                id: item.id,
                content: item.content,
                platform: item.platform,
                timestamp: item.timestamp,
                similarity: item.similarity,
                source_type: item.source_type,
              })),
              latencyMs: elapsedTime,
              queryType: 'PREFERENCE',
              queryOriginal: userMessage,
              queryTransformed: null,
            };

            const formattedContext = buildMemoryInjection(retrievalResult, {
              debugMode: contextConfig.debugMode || false,
            });

            return {
              success: true,
              items: prefItems,
              formattedContext,
              elapsedMs: elapsedTime,
              transformation: { transformed: false },
            };
          }
          console.log(`ℹ️ Preference router: ${prefItems.length} preferences found — continuing to vector pipeline for "${userMessage.match(/\b(?:and|or)\s+(?:why|how|when|where|who|what)\b.*/i)?.[0] || 'qualifier'}" context`);
        } else {
          console.log('ℹ️ Preference router: no preferences found, falling through to vector pipeline');
        }
      }
    } catch (prefError) {
      console.warn('⚠️ Preference router failed (non-fatal), falling through:', prefError.message);
    }

    // Check in-memory circuit breaker — only affects API-dependent paths
    // BM25 keyword search is local and always available even when CB is open
    const apiAvailable = !isCircuitBreakerOpen();
    if (!apiAvailable) {
      const waitSeconds = Math.ceil((circuitBreakerOpenUntil - Date.now()) / 1000);
      console.warn(
        `⚠️ Circuit breaker is OPEN — API paths disabled, BM25 still active. ` +
        `Resets in ${waitSeconds}s (${consecutiveApiFailures} failures)`
      );
    }

    // Resolve routing mode early — edge mode handles query expansion server-side
    // so we skip client-side OpenAI calls that would CORS-fail from the SW.
    const routingMode = await getRoutingMode();

    // PHASE 7: Query Transformation (Dual ICP Support)
    let searchQuery = userMessage;
    let transformationMetadata = { transformed: false };

    // Skip client-side transformation in edge mode: the search_memories edge
    // function already runs HyDE + dual embedding + reranking server-side.
    if (!contextConfig.disableQueryTransformation && apiAvailable && routingMode !== 'edge') {
      // Skip transformation if HyDE CB is open (same OpenAI key — would 429 too)
      const hydeCbStatus = await hydeCB.isOpen();
      if (hydeCbStatus.open) {
        console.log('⚡ Query transformation skipped: HyDE circuit breaker open (shared OpenAI key)');
      } else {
      try {
        // 3s timeout: query transformation is an enhancement, not critical path.
        // On timeout, falls through to using the original query.
        const transformResult = await withTimeout(
          (async () => {
            // Get recent messages for context (to extract topics/emotional state)
            // PHASE 4 UPDATE: Fetch from Supabase for cross-device context
            const recentTopics = await fetchRecentTopicsFromSupabase(apiConfig);

            // Transform query
            return await transformQuery(
              userMessage,
              {
                recentTopics: recentTopics,
                searchContext: 'chat_history'
              },
              apiConfig.openaiKey
            );
          })(),
          3000,
          'Query transformation'
        );

        if (transformResult?.success && transformResult.transformed) {
          searchQuery = transformResult.optimizedQuery;
          transformationMetadata = {
            transformed: true,
            original: userMessage,
            optimized: searchQuery
          };
          console.log(`🔄 Query transformed: "${userMessage}" → "${searchQuery}"`);
        } else if (transformResult) {
          console.log(`📊 Using original query (transformation ${transformResult.transformed ? 'succeeded' : 'skipped/failed'})`);
        }
      } catch (transformError) {
        console.warn('⚠️ Query transformation failed, using original query:', transformError);
      }
      } // end hydeCB else block
    } else if (routingMode === 'edge') {
      console.log('⚡ Query transformation skipped: edge mode (server-side HyDE handles expansion)');
    }

    // VALIDATION FIX: Use searchHybrid for robust retrieval (Vector + BM25)
    // This replaces the manual embedding generation and raw Supabase fetch
    // Benefits:
    // 1. Adds BM25 keyword search (fixes "Kobe Bryant" keyword miss)
    // 2. Uses unified threshold (0.5)
    // 3. Handles query expansion automatically

    // Sync-before-search: flush pending messages to Supabase so cross-platform
    // memories are available immediately (e.g., captured on ChatGPT, searched on Claude).
    // Fire-and-forget: don't block the search pipeline. Messages sync via alarm anyway.
    try {
      const pendingResult = await chrome.storage.local.get(['kyt_sync_pending']);
      if (pendingResult.kyt_sync_pending) {
        console.log('Sync-before-search: triggering flush (non-blocking)...');
        if (syncDebounceTimer) { clearTimeout(syncDebounceTimer); syncDebounceTimer = null; }
        if (syncMaxWaitTimer) { clearTimeout(syncMaxWaitTimer); syncMaxWaitTimer = null; }
        // Fire-and-forget — don't await. Saves 0-3s from the critical path.
        executeDebouncedSync().catch(err =>
          console.warn('Sync-before-search background flush failed:', err.message)
        );
      }
    } catch (syncErr) {
      console.warn('Sync-before-search failed (non-fatal):', syncErr.message);
    }

    let contextItems = [];

    try {
      // Use transformed query if available, otherwise original
      const queryToUse = transformationMetadata.transformed ? searchQuery : userMessage;

      console.log(`🔍 Context Retrieval: Using query "${queryToUse}"`);

      // Dual-path: edge function vs legacy client-side search
      // (routingMode already resolved above, before query transformation)

      if (routingMode === 'edge') {
        // ─── Edge function path (authenticated users) ───
        // The edge function has its own server-side API keys and embeddings.
        // It does NOT depend on client-side apiAvailable / circuit breaker state.
        try {
          contextItems = await searchViaEdgeFunction(queryToUse, {
            topK: contextConfig.candidatePoolSize,
          });
          console.log(`✅ Context Retrieval (edge): Found ${contextItems.length} items (pool: ${contextConfig.candidatePoolSize}, inject cap: ${contextConfig.maxContextItems})`);

          // Retry with original query if transformed returned 0
          if (contextItems.length === 0 && transformationMetadata.transformed) {
            console.log('🔄 Retry (edge): retrying with original query...');
            contextItems = await searchViaEdgeFunction(userMessage, {
              topK: contextConfig.candidatePoolSize,
            });
            console.log(`🔄 Retry (edge) result: ${contextItems.length} items`);
          }
        } catch (edgeError) {
          console.warn(`⚠️ Edge function search failed, falling back to legacy: ${edgeError.message}`);
          // Fall through to legacy path below
          contextItems = [];
        }
      }

      if (routingMode !== 'edge' || contextItems.length === 0) {
        // ─── Legacy client-side path ───
        // Also used as fallback when edge function fails
        if (routingMode === 'edge') {
          console.warn('⚠️ Edge path returned 0 results or failed — legacy fallback.');
        }

        // Calculate maxTimestamp to exclude recent memories (Context Pollution Prevention)
        const maxTimestamp = Date.now() - (contextConfig.excludeRecentSeconds * 1000);

        contextItems = await searchHybrid(queryToUse, {
          limit: contextConfig.candidatePoolSize,
          semanticThreshold: 0.50,
          bm25Threshold: 0.1,
          enableBM25: true,
          enableSemantic: apiAvailable,
          enableHyDE: apiAvailable && !!apiConfig.openaiKey,
          enableGraph: true,
          openaiKey: apiConfig.openaiKey,
          role: null,
          source: null,
          maxTimestamp: maxTimestamp,
        });

        console.log(`✅ Context Retrieval: Found ${contextItems.length} items via Hybrid Search (pool: ${contextConfig.candidatePoolSize})`);
        console.log('📊 Search Strategy Breakdown:', JSON.stringify({
          routing: routingMode,
          query: queryToUse.substring(0, 80),
          totalResults: contextItems.length,
          semanticAvailable: contextItems.metadata?.semanticAvailable,
          jinaReranked: contextItems.metadata?.jinaReranked,
          embeddingCBOpen: isCircuitBreakerOpen(),
          apiAvailable,
        }));

        // E1: If transformed query returned 0 results, retry with original query
        if (contextItems.length === 0 && transformationMetadata.transformed) {
          console.log('🔄 Retry: Transformed query returned 0 results, retrying with original query...');
          contextItems = await searchHybrid(userMessage, {
            limit: contextConfig.candidatePoolSize,
            semanticThreshold: 0.50,
            bm25Threshold: 0.1,
            enableBM25: true,
            enableSemantic: apiAvailable,
            enableHyDE: apiAvailable && !!apiConfig.openaiKey,
            enableGraph: true,
            openaiKey: apiConfig.openaiKey,
            role: null,
            source: null,
            maxTimestamp: maxTimestamp,
          });
          console.log(`🔄 Retry result: ${contextItems.length} items with original query`);
        }
      }

    } catch (searchError) {
      console.error('❌ Context Retrieval failed:', searchError);
      // Fallback to empty context
      contextItems = [];
    }

    // Apply mild recency boost to help newer memories compete with semantically richer older ones
    // Uses simple exponential decay: boost = 1.0 for today, ~0.95 at 7 days, ~0.90 at 14 days
    if (contextItems.length > 1) {
      const HALF_LIFE_DAYS = 30;
      const now = Date.now();
      const scoreKey = contextItems[0]?.cross_encoder_score != null ? 'cross_encoder_score'
          : contextItems[0]?.distance != null ? 'distance'
          : 'weighted_score';

      for (const item of contextItems) {
        if (item[scoreKey] == null) continue;
        const itemTime = new Date(item.msg_timestamp || item.timestamp || 0).getTime();
        const daysSince = Math.max(0, (now - itemTime) / 86400000);
        const recencyMultiplier = Math.exp(-daysSince / HALF_LIFE_DAYS);
        // Blend: 85% original score + 15% recency-adjusted score
        item[scoreKey] = item[scoreKey] * 0.85 + item[scoreKey] * recencyMultiplier * 0.15;
      }
      console.log(`🕐 Recency multiplier applied to ${contextItems.length} results (half-life: ${HALF_LIFE_DAYS}d)`);
    }

    // QUERY ECHO FILTER: Remove results that just repeat the search query
    // Short content (<80 chars) with >70% word overlap = user's own question echoed back
    {
      const ECHO_STOP = new Set([
        'the','and','for','with','from','that','this','have','has','what','when',
        'where','which','who','how','why','are','was','were','been','being','can',
        'could','should','would','will','not','but','about','into','than','then',
        'them','they','your','you','our','its','his','her','their','does','did',
        'top','best','most','need','needs','want','use','like','just','also',
        'some','any','all','each','every','tell','know','think','make','take',
      ]);
      const qWords = new Set(
        userMessage.toLowerCase().replace(/[^\w\s]/g, '').split(/\s+/)
          .filter(w => w.length > 2 && !ECHO_STOP.has(w))
      );
      if (qWords.size > 0) {
        const beforeCount = contextItems.length;
        contextItems = contextItems.filter(item => {
          const content = (item.content || '').toLowerCase().replace(/[^\w\s]/g, '');
          if (content.length < 80) {
            const cWords = new Set(content.split(/\s+/).filter(w => w.length > 2 && !ECHO_STOP.has(w)));
            const overlap = [...qWords].filter(w => cWords.has(w)).length;
            if (overlap / Math.max(qWords.size, 1) > 0.7) {
              console.log(`🔇 Query echo filter: dropped "${(item.content || '').substring(0, 60)}..." (${overlap}/${qWords.size} word overlap)`);
              return false;
            }
          }
          return true;
        });
        if (contextItems.length < beforeCount) {
          console.log(`🔇 Query echo filter: removed ${beforeCount - contextItems.length} echo(es)`);
        }
      }
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

    // DEFLECTION PENALTY (Layer 2: retrieval-time)
    // Penalize assistant deflections/echoes so they naturally fall below confidence threshold
    // For chat_turns: role='user' (from speakers[0]), but content has "Assistant: ..." blocks.
    // Extract assistant text and run detection on it so deflections are caught.
    for (const item of contextItems) {
      let deflectionContent = item.content;
      let deflectionRole = item.role;
      if (deflectionRole !== 'assistant' && item.content) {
        const asstBlocks = [];
        const re = /(?:^|\n\n)Assistant:\s*([\s\S]*?)(?=\n\nUser:|\s*$)/gi;
        let m;
        while ((m = re.exec(item.content)) !== null) {
          asstBlocks.push(m[1].trim());
        }
        if (asstBlocks.length > 0) {
          deflectionContent = asstBlocks.join('\n');
          deflectionRole = 'assistant';
        } else if (deflectionRole === 'unknown') {
          // Edge path delivers role='unknown' (server Candidate type drops speakers[]).
          // chat_turns content IS assistant text; assume 'assistant' for detection.
          // Safe: user questions filtered server-side (is_question RPC predicate).
          // TODO: remove when server Candidate type preserves speakers[]
          deflectionRole = 'assistant';
        }
      }

      const check = detectDeflection(deflectionContent, deflectionRole);
      if (check.isDeflection && check.confidence > 0) {
        const before = item.cross_encoder_score ?? item.weighted_score ?? item.rrf_score ?? 'n/a';
        applyDeflectionPenalty(item, check.confidence);
        const after = item.cross_encoder_score ?? item.weighted_score ?? item.rrf_score ?? 'n/a';
        console.log(`🗑️ Deflection penalty: ${check.reason} | score ${before} → ${after} (ID: ${item.id || item.message_id || 'unknown'})`);
        // Hard-drop high-confidence deflections (>=0.85) — these are unambiguous
        if (check.confidence >= 0.85) {
          item._deflectionDropped = true;
        }
      }
    }

    // Remove hard-dropped deflections (high confidence ≥ 0.85)
    contextItems = contextItems.filter(item => !item._deflectionDropped);

    // BARE QUESTION FILTER: drop items that are just user questions without an answer.
    // Semantic RPCs don't filter is_question; catch bare questions client-side.
    // NOTE: Do NOT use detectIsQuestion here — its short-content heuristic (<60 chars)
    // false-positives on contextual content strings like "LLM platform support starting
    // with ChatGPT" which are short statements, not questions. Only drop items that
    // explicitly end with ? or start with an interrogative/imperative word.
    contextItems = contextItems.filter(item => {
      const content = (item.content || '').trim();
      // Only filter short items without assistant response blocks
      if (content.length < 120 && !/\bAssistant:/i.test(content)) {
        if (content.endsWith('?') || INTERROGATIVE_RE.test(content)) {
          console.log(`🔍 Bare question filter: dropped "${content.substring(0, 60)}..." (ID: ${item.id || item.message_id || 'unknown'})`);
          return false;
        }
      }
      return true;
    });

    // KYT META-CONVERSATION PENALTY: Detect conversations ABOUT the extension itself.
    // These are captured normally but are rarely what the user wants to recall.
    // Score penalty (0.3x) rather than hard filter — meta-conversations CAN be found
    // if the user genuinely asks about KYT (e.g. "what did I say about KYT not working?").
    const KYT_META_PATTERNS = [
      // KYT + extension/plugin + operational status (broken, error, debug) — genuinely meta
      /\bK\.?Y\.?T\.?\b.*\b(extension|plugin|add-?on)\b.*\b(working|broken|not working|crash|error|bug|fix|debug)\b/i,
      // System operational status — negative operational verbs only (removed "working"/"updated" — too ambiguous)
      /\b(extension|memory system|knowledge base)\b.*\b(broken|not working|crash|paused|down|error)\b/i,
      // Chrome internals + debugging context (architectural discussions should NOT be penalized)
      /\bchrome\.?(runtime|storage|extension)\b.*\b(error|bug|crash|fail|broken|terminat|restart|debug)\b/i,
      // Service worker + debugging context
      /\bservice worker\b.*\b(terminat|restart|error|log|crash|fail)\b/i,
      // Code constants (always meta)
      /\bKYT_(?:MESSAGE|CONTEXT|BRIDGE|DEBUG)\b/,
    ];

    // ECHO/SELF-REFERENCE PENALTY: Detect assistant responses that summarize stored data.
    // The ORIGINAL user statement is more valuable than the AI's echo of it.
    const ECHO_PATTERNS = [
      /\byou (?:said|mentioned|noted|discussed|talked about|asked about|brought up)\b/i,
      /\bfrom your (?:stored|previous|earlier) conversations?\b/i,
      /\bKYT (?:picked it up|captured|found|retrieved|surfaced)\b/i,
      /\bthat was captured from\b/i,
      /\bfrom (?:a|your) (?:chatgpt|claude) conversation\b/i,
      /\b(?:your |the )?stored (?:data|conversations?|items?|records?|entries|knowledge)\b/i,
      /\b(?:retrieved|stored) (?:items?|entries?) (?:are|is|were) (?:just|only)\b/i,
    ];

    // Skip meta-penalty when the user's query is genuinely about KYT/extension
    const KYT_QUERY_PATTERNS = [
      /\bK\.?Y\.?T\.?\b/i,
      /\b(extension|chrome extension)\b.*\b(model|support|need|use|feature|work)/i,
      /\bservice worker\b/i,
    ];
    const queryIsAboutKYT = KYT_QUERY_PATTERNS.some(p => p.test(userMessage));
    if (queryIsAboutKYT) {
      console.log('🔧 Meta-conversation penalty SKIPPED: query is about KYT/extension');
    }

    for (const item of contextItems) {
      const content = item.content || '';
      const scoreKey = item.cross_encoder_score != null ? 'cross_encoder_score'
                     : item.weighted_score != null ? 'weighted_score'
                     : item.rrf_score != null ? 'rrf_score' : null;

      // Meta-conversation penalty (0.3x) — skipped when query is about KYT
      if (!queryIsAboutKYT && scoreKey && item[scoreKey] != null && KYT_META_PATTERNS.some(p => p.test(content))) {
        const before = item[scoreKey];
        item[scoreKey] *= 0.3;
        console.log(`🔧 Meta-conversation penalty: score ${before.toFixed(3)} → ${item[scoreKey].toFixed(3)} (ID: ${item.id || item.message_id || 'unknown'})`);
      }

      // Echo penalty (0.7x) — assistant messages that echo stored data
      // For chat_turns (role='user'), extract assistant text blocks first
      let echoContent = content;
      let echoIsAssistant = item.role === 'assistant';
      if (!echoIsAssistant && content) {
        const asstBlocks = [];
        const echoRe = /(?:^|\n\n)Assistant:\s*([\s\S]*?)(?=\n\nUser:|\s*$)/gi;
        let echoMatch;
        while ((echoMatch = echoRe.exec(content)) !== null) {
          asstBlocks.push(echoMatch[1].trim());
        }
        if (asstBlocks.length > 0) {
          echoContent = asstBlocks.join('\n');
          echoIsAssistant = true;
        } else if (item.role === 'unknown') {
          // Edge path: role='unknown', content IS assistant text (no "Assistant:" prefix).
          // Same fallback as deflection penalty — assume assistant for echo detection.
          echoIsAssistant = true;
        }
      }
      if (!scoreKey || item[scoreKey] == null) {
        if (ECHO_PATTERNS.some(p => p.test(echoContent))) {
          console.warn(`⚠️ Echo penalty SKIPPED: no score key available for item (role=${item.role}, id=${item.id || item.message_id || 'unknown'}). Pattern matched but cannot apply penalty.`);
        }
      } else if (echoIsAssistant && ECHO_PATTERNS.some(p => p.test(echoContent))) {
        const before = item[scoreKey];
        item[scoreKey] *= 0.7;
        console.log(`🔄 Echo penalty: assistant item echoing stored data, score ${before.toFixed(3)} → ${item[scoreKey].toFixed(3)} (ID: ${item.id || item.message_id || 'unknown'})`);
      }
    }

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

    // Entity-aware recency resolution: boost newer items, penalize contradicted older ones
    filteredItems = applyRecencyResolution(filteredItems);

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
        const jinaReranked = contextItems.metadata?.jinaReranked ?? true;
        let defaultThreshold;
        if (!jinaReranked) {
          // Scores are uncalibrated RRF/weighted values (0.01-0.05 range, not 0-1).
          // Min-max normalized in fallback, so best=1.0, rest relative.
          // Use low threshold to avoid dropping everything.
          defaultThreshold = 0.01;
        } else if (!semanticWasAvailable) {
          defaultThreshold = 0.25;
        } else {
          defaultThreshold = 0.40;
        }
        const confidenceThreshold = contextConfig.confidenceThreshold || defaultThreshold;
        if (!jinaReranked) {
          console.log(`🎯 Jina unavailable — uncalibrated threshold: ${confidenceThreshold}`);
        } else if (!semanticWasAvailable) {
          console.log(`🎯 BM25-only mode — adaptive threshold: ${confidenceThreshold}`);
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
          // Low-confidence tier: if highest score >= 0.10, keep top 2 items with caveat tag
          // This surfaces partial matches with appropriate framing rather than total silence
          if (filterResult.highestScore >= 0.10) {
            console.log(`📋 Low-confidence tier: keeping top 2 items (highest: ${filterResult.highestScore.toFixed(3)})`);
            filteredItems = filteredItems
              .sort((a, b) => {
                const scoreA = a.cross_encoder_score ?? a.weighted_score ?? 0;
                const scoreB = b.cross_encoder_score ?? b.weighted_score ?? 0;
                return scoreB - scoreA;
              })
              .slice(0, 2)
              .map(item => ({ ...item, lowConfidence: true }));
            // Deflection guard: don't rescue deflection items — they create
            // self-reinforcing garbage loops ("what is my favorite car?" → deflection
            // captured → deflection retrieved → new deflection → ...)
            filteredItems = filteredItems.filter(item => {
              let checkContent = item.content;
              let checkRole = item.role;
              if (checkRole !== 'assistant' && item.content) {
                const blocks = [];
                const rescueRe = /(?:^|\n\n)Assistant:\s*([\s\S]*?)(?=\n\nUser:|\s*$)/gi;
                let rm;
                while ((rm = rescueRe.exec(item.content)) !== null) blocks.push(rm[1].trim());
                if (blocks.length > 0) { checkContent = blocks.join('\n'); checkRole = 'assistant'; }
                else if (checkRole === 'unknown') checkRole = 'assistant';
              }
              const defl = detectDeflection(checkContent, checkRole);
              if (defl.isDeflection) {
                console.log(`🗑️ Low-confidence rescue: dropped deflection (${defl.reason})`);
                return false;
              }
              return true;
            });
          } else {
            // Below 0.15 — truly irrelevant, drop everything
            filteredItems = [];
          }
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

    // === PREFERENCE + VECTOR MERGE ===
    // If preference router found results but didn't short-circuit (qualifier query),
    // prepend preference items so the direct answer leads, with vector context following.
    if (prefItems && prefItems.length > 0 && queryHasQualifier) {
      const prefIds = new Set(prefItems.map(p => p.id));
      // Deduplicate: remove any vector results that share an ID with preference items
      filteredItems = filteredItems.filter(item => !prefIds.has(item.message_id || item.id));
      // Score floor: preference items should rank at or above the best vector item.
      // Without this, a vector item that survived penalties could outrank the direct answer.
      const highestVectorScore = filteredItems.reduce((max, item) => {
        const s = item.cross_encoder_score ?? item.weighted_score ?? item.rrf_score ?? 0;
        return s > max ? s : max;
      }, 0);

      // Prepend preference items (formatted to match filteredItems shape)
      const prefAsVector = prefItems.map(p => {
        const baseScore = p.similarity;
        const floorScore = Math.max(baseScore, highestVectorScore + 0.01);
        if (floorScore > baseScore) {
          console.log(`📌 Preference score floor: ${baseScore.toFixed(3)} → ${floorScore.toFixed(3)} (vector max was ${highestVectorScore.toFixed(3)})`);
        }
        return {
          id: p.id,
          content: p.content,
          platform: p.platform,
          timestamp: p.timestamp,
          msg_timestamp: p.timestamp,
          cross_encoder_score: floorScore,
          source: p.source_type,
          source_type: p.source_type,
          preference_match: true,
        };
      });
      filteredItems = [...prefAsVector, ...filteredItems];
      console.log(`🔀 Preference+Vector merge: ${prefItems.length} pref + ${filteredItems.length - prefItems.length} vector = ${filteredItems.length} total`);
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
          role: item.role || 'unknown',  // user | assistant | unknown — surfaces in injection as "speaker"
          platform: item.source === 'cli' ? 'terminal' : (item.platform || 'chatgpt'),
          timestamp: new Date(item.msg_timestamp || item.timestamp).toISOString(),
          similarity: item.cross_encoder_score != null
            ? item.cross_encoder_score                               // Jina reranker (calibrated 0-1)
            : item.distance != null
              ? Math.max(0, 1 - item.distance)                       // Semantic cosine (distance→similarity)
              : (item.weighted_score || item.rrf_score || 0.5),       // RRF/BM25 fallback
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
      // No results — do NOT inject an empty block.
      // An empty block saying "No relevant memories found" actively signals the LLM
      // to skip KYT and use web search. Silence is better than a negative signal.
      formattedContext = null;

      console.log('ℹ️ Memory Injection Protocol: No results — skipping injection (no negative signal)');
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
 * Port-based handler for GET_CONTEXT requests.
 * Using chrome.runtime.connect() instead of sendMessage+return true avoids
 * the "message channel closed" error in chrome://extensions when the SW dies
 * mid-request (e.g. on extension reload). Port disconnection is handled via
 * onDisconnect — clean, no Chrome-level error entry.
 */
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'kyt-context') return;

  port.onMessage.addListener(async (msg) => {
    const injectionStart = performance.now();
    try {
      if (!msg.userMessage || typeof msg.userMessage !== 'string') {
        port.postMessage({ requestId: msg.requestId, success: false, error: 'Missing userMessage' });
        return;
      }
      console.log('🔍 KYT Background: Context request (port) for:', msg.userMessage.substring(0, 50) + '...');
      updateInjectionStats({ attempt: true }).catch(() => {});

      const result = await chrome.storage.local.get(['kytDebugMode']);
      const config = { ...msg.config, debugMode: result.kytDebugMode || false };

      const contextData = await Promise.race([
        getContextForInjection(msg.userMessage, config),
        new Promise((_, reject) => setTimeout(() => reject(new Error('getContextForInjection timed out after 25000ms')), 25000))
      ]);

      const latencyMs = Math.round(performance.now() - injectionStart);
      const itemCount = contextData.items?.length || 0;
      console.log('✅ Context retrieved (port):', itemCount, 'items');

      if (itemCount > 0) {
        updateInjectionStats({ success: true, itemCount, latencyMs, result: true }).catch(() => {});
      } else {
        updateInjectionStats({ empty: true, latencyMs, result: true }).catch(() => {});
      }

      port.postMessage({ requestId: msg.requestId, ...contextData });
    } catch (error) {
      const latencyMs = Math.round(performance.now() - injectionStart);
      const isTimeout = error.message?.includes('timed out');
      console.error('❌ Context retrieval error (port):', error);
      updateInjectionStats({ error: !isTimeout, timeout: isTimeout, latencyMs, result: true, errorMsg: error.message }).catch(() => {});
      port.postMessage({ requestId: msg.requestId, success: false, error: error.message });
    }
  });
});

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

    case 'GET_CONTEXT': {
      // Day 3: Get context for RAG injection (CSP fix - runs in background, no CSP restrictions)
      // Async IIFE guarantees sendResponse is always called, even on unexpected throws.
      (async () => {
        const injectionStart = performance.now();
        try {
          if (!message.userMessage || typeof message.userMessage !== 'string') {
            sendResponse({ success: false, error: 'Missing userMessage' });
            return;
          }
          console.log('🔍 KYT Background: Context request for message:', message.userMessage.substring(0, 50) + '...');

          // Track injection attempt — fire-and-forget
          updateInjectionStats({ attempt: true }).catch(() => {});

          // Read debug mode from storage for Memory Injection Protocol
          const result = await chrome.storage.local.get(['kytDebugMode']);
          const config = {
            ...message.config,
            debugMode: result.kytDebugMode || false
          };

          // 25s overall timeout — Jina cold-start can take ~7.5s (5s timeout + 2.5s retry),
          // so 20s was too tight. 25s leaves headroom while staying under the 30s MAIN world timeout.
          const contextData = await Promise.race([
            getContextForInjection(message.userMessage, config),
            new Promise((_, reject) => setTimeout(() => {
              reject(new Error('getContextForInjection timed out after 25000ms'));
            }, 25000))
          ]);

          const latencyMs = Math.round(performance.now() - injectionStart);
          const itemCount = contextData.items?.length || 0;
          console.log('✅ Context retrieved:', itemCount, 'items');

          if (itemCount > 0) {
            updateInjectionStats({ success: true, itemCount, latencyMs, result: true }).catch(() => {});
          } else {
            updateInjectionStats({ empty: true, latencyMs, result: true }).catch(() => {});
          }

          sendResponse(contextData);
        } catch (error) {
          const latencyMs = Math.round(performance.now() - injectionStart);
          const isTimeout = error.message?.includes('timed out');
          console.error('❌ Context retrieval error:', error);

          updateInjectionStats({
            error: !isTimeout,
            timeout: isTimeout,
            latencyMs,
            result: true,
            errorMsg: error.message
          }).catch(() => {});

          sendResponse({ success: false, error: error.message });
        }
      })();
      return true; // Always reached — outside the IIFE
    }

    case 'GET_INJECTION_STATS':
      // Return injection health stats for popup/diagnostics
      chrome.storage.local.get([INJECTION_STATS_KEY]).then(result => {
        const stats = result[INJECTION_STATS_KEY] || {
          totalAttempts: 0, successful: 0, empty: 0, timeouts: 0, errors: 0,
          totalItemsReturned: 0, totalLatencyMs: 0, recentResults: []
        };
        stats.avgLatencyMs = stats.totalAttempts > 0
          ? Math.round(stats.totalLatencyMs / stats.totalAttempts)
          : 0;
        stats.successRate = stats.totalAttempts > 0
          ? Math.round((stats.successful / stats.totalAttempts) * 100)
          : 0;
        sendResponse(stats);
      });
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

    case 'FORCE_SYNC':
      // Force resync all messages (clear syncedMessageIds first in popup, then trigger sync)
      (async () => {
        try {
          console.log('🔄 Force sync triggered from popup');
          const mode = await getRoutingMode();

          if (mode === 'edge') {
            const stored = await chrome.storage.local.get(['captured_messages']);
            const messages = stored.captured_messages || [];
            const result = await syncViaEdgeFunction(messages);
            console.log('✅ Force sync (edge) result:', result);
            sendResponse(result);
          } else {
            const result = await syncToSupabase();
            console.log('✅ Force sync result:', result);
            sendResponse(result);
          }
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
 * Pre-warm embedding model every 30 minutes to avoid cold-start latency
 */
chrome.alarms.create('prewarmEmbedding', { delayInMinutes: 1, periodInMinutes: 30 });

/**
 * Refresh auth token every 45 minutes (Supabase JWT default TTL = 1 hour).
 * Keeps the session alive for authenticated users.
 */
chrome.alarms.create('tokenRefresh', { periodInMinutes: 45 });

/**
 * Sync-on-platform-switch: when user switches to a KYT-supported tab,
 * flush any pending messages so cross-platform search finds them immediately.
 */
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  try {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    if (!tab.url) return;
    const isKYTPlatform =
      tab.url.startsWith('https://claude.ai/') ||
      tab.url.startsWith('https://chatgpt.com/') ||
      tab.url.startsWith('https://chat.openai.com/');
    if (isKYTPlatform) {
      const pendingResult = await chrome.storage.local.get(['kyt_sync_pending']);
      if (pendingResult.kyt_sync_pending) {
        console.log(`Platform switch detected: ${new URL(tab.url).hostname} — flushing pending sync`);
        if (syncDebounceTimer) { clearTimeout(syncDebounceTimer); syncDebounceTimer = null; }
        if (syncMaxWaitTimer) { clearTimeout(syncMaxWaitTimer); syncMaxWaitTimer = null; }
        await executeDebouncedSync();
      }
    }
  } catch (_err) {
    // Tab may be inaccessible (e.g., chrome:// pages) — ignore
  }
});

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

    case 'backfillEmbeddings':
      try {
        console.log('⏰ Backfill retry alarm fired');
        const backfillResult = await backfillNullEmbeddings();
        if (backfillResult.success) {
          console.log(`✅ Backfill retry complete: ${backfillResult.backfilled} messages patched`);
          // Clear the alarm — no more retries needed
          chrome.alarms.clear('backfillEmbeddings');
        } else if (backfillResult.willRetry || backfillResult.remaining) {
          console.warn(`⚠️ Backfill retry incomplete, will try again in 5 minutes`);
          // Alarm is already periodic if created with periodInMinutes, but ours was one-shot
          chrome.alarms.create('backfillEmbeddings', { delayInMinutes: 5 });
        }
      } catch (error) {
        console.error('❌ Backfill retry alarm error:', error.message);
      }
      break;

    case 'backfillContextual':
      try {
        console.log('⏰ Contextual backfill alarm fired');
        const ctxResult = await callEdgeFunction('backfill_contextual', { limit: 15 });
        if (ctxResult.context_generated > 0) {
          console.log(`✅ Contextual backfill: ${ctxResult.context_generated} turns contextualized`);
          // If there may be more, schedule another run
          if (ctxResult.processed >= 15) {
            chrome.alarms.create('backfillContextual', { delayInMinutes: 5 });
          }
        } else {
          console.log('✅ Contextual backfill: no rows remaining');
        }
      } catch (error) {
        console.error('❌ Contextual backfill alarm error:', error.message);
        // Retry in 10 minutes
        chrome.alarms.create('backfillContextual', { delayInMinutes: 10 });
      }
      break;

    case 'prewarmEmbedding':
      try {
        await prewarmEmbeddingModel();
      } catch (error) {
        // Pre-warm is best-effort, don't log errors to avoid noise
      }
      break;

    case 'tokenRefresh':
      try {
        const authenticated = await isAuthenticated();
        if (authenticated) {
          await refreshSession();
          console.log('✅ Token refresh: session refreshed via alarm');
        }
      } catch (error) {
        console.warn('⚠️ Token refresh alarm failed:', error.message);
      }
      break;

    case 'reInjectContentScripts':
      console.log('🔄 Retry alarm: re-injecting content scripts...');
      reInjectContentScripts().catch(err => {
        console.error('❌ Retry re-injection also failed:', err.message);
      });
      break;

    default:
      console.warn(`⚠️ Unknown alarm: ${alarm.name}`);
  }
});

/**
 * Re-inject content scripts into all open ChatGPT/Claude tabs.
 * Called on extension update and by retry alarm.
 *
 * For each platform:
 * 1. Clear MAIN world duplicate-injection guard
 * 2. Re-inject ISOLATED world script (content.js / content_bridge.js)
 *    → gets fresh chrome.runtime, generation guard silences old handlers
 * 3. Re-inject MAIN world script (inject.js via content.js / content_test.js)
 *    → gets new code (retry logic), idempotent fetch wrapper prevents double-interception
 */
async function reInjectContentScripts() {
  console.log('🔌 Re-injecting content scripts into open tabs...');

  // ── ChatGPT tabs ──────────────────────────────────────────────────────
  try {
    const chatgptTabs = await chrome.tabs.query({
      url: ['https://chatgpt.com/*', 'https://chat.openai.com/*']
    });
    console.log(`🔌 Found ${chatgptTabs.length} ChatGPT tab(s)`);

    for (const tab of chatgptTabs) {
      try {
        // 1. Clear inject.js guard so it can re-load with fresh fetch wrapper.
        //    Do NOT clear KYT_DOM_OBSERVER_INJECTED — dom-observer runs in MAIN
        //    world, doesn't need chrome APIs, and re-running it causes a full
        //    DOM re-scan that floods the queue with hundreds of duplicate messages.
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => {
            window.KYT_CHATGPT_INJECTED = false;
          },
          world: 'MAIN'
        });

        // 2. Re-inject content.js (ISOLATED world) — gets valid chrome.runtime
        //    content.js also re-injects inject.js into MAIN world (guard was cleared)
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['platforms/chatgpt/content.js']
        });
        console.log(`✅ Re-injected ChatGPT scripts into tab ${tab.id}`);
      } catch (e) {
        console.warn(`⚠️ Failed to re-inject ChatGPT tab ${tab.id}:`, e.message);
      }
    }
  } catch (e) {
    console.error('❌ ChatGPT tab query failed:', e.message);
  }

  // ── Claude tabs ───────────────────────────────────────────────────────
  try {
    const claudeTabs = await chrome.tabs.query({ url: 'https://claude.ai/*' });
    console.log(`🔌 Found ${claudeTabs.length} Claude tab(s)`);

    for (const tab of claudeTabs) {
      try {
        // 1. Clear MAIN world guard so content_test.js can re-load with new code
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => { window.KYT_CLAUDE_INJECTED = false; },
          world: 'MAIN'
        });

        // 2. Re-inject content_test.js (MAIN world) — new code with retry logic
        //    Idempotent fetch wrapper via window.__kytOriginalFetch
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['platforms/claude/content_test.js'],
          world: 'MAIN'
        });

        // 3. Re-inject content_bridge.js (ISOLATED world) — gets valid chrome.runtime
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['platforms/claude/content_bridge.js']
        });
        console.log(`✅ Re-injected Claude scripts into tab ${tab.id}`);
      } catch (e) {
        console.warn(`⚠️ Failed to re-inject Claude tab ${tab.id}:`, e.message);
      }
    }
  } catch (e) {
    console.error('❌ Claude tab query failed:', e.message);
  }

  console.log('🔌 Content script re-injection complete');
}

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
      show_login_prompt: true, // Prompt user to sign in on first popup open
      api_config: {
        // Phase 1 Fix: Enable semantic search by default
        // Disables query transformation that breaks semantic matching
        disableQueryTransformation: true
      }
    }).then(() => {
      console.log('✅ KYT: Storage initialized');
      console.log('   Phase 1 fix enabled: disableQueryTransformation = true');
      console.log('   First-install onboarding: login prompt + import enabled');
    }).catch(error => {
      console.error('❌ KYT: Failed to initialize storage:', error);
    });
  } else if (details.reason === 'update') {
    // Reset circuit breakers on update (new code may fix provider issues)
    chrome.storage.local.remove('kyt_embedding_circuit_breaker', () => {
      console.log('🔌 Embedding circuit breaker reset on extension update');
    });
    chrome.storage.local.remove('kyt_jina_circuit_breaker', () => {
      console.log('🔌 Jina circuit breaker reset on extension update');
    });
    chrome.storage.local.remove('kyt_hyde_circuit_breaker', () => {
      console.log('🔌 HyDE circuit breaker reset on extension update');
    });

    // One-time userId backfill: extract from existing session (even if expired)
    // so all read paths (search, preferences, backfill) have userId immediately
    chrome.storage.local.get([AUTH_SESSION_KEY, 'user_id'], (stored) => {
      if (!stored.user_id) {
        const sessionUserId = stored[AUTH_SESSION_KEY]?.user?.id;
        if (sessionUserId) {
          chrome.storage.local.set({ user_id: sessionUserId }, () => {
            console.log(`🔑 Persisted user_id from existing session: ${sessionUserId}`);
          });
        } else {
          console.warn('⚠️ No user_id in session — user must sign in again');
        }
      } else {
        console.log(`🔑 user_id already persisted: ${stored.user_id}`);
      }
    });

    // Clear stale process_queue alarm (old snake_case naming)
    chrome.alarms.clear('process_queue', (wasCleared) => {
      if (wasCleared) console.log('🧹 Cleared stale process_queue alarm');
    });

    // Re-inject content scripts into open tabs (restore chrome.runtime connection)
    // Uses awaited promises (not callbacks) to ensure completion before SW idles.
    // Old ISOLATED world handlers become no-ops via generation guards.
    // MAIN world scripts are also re-injected after clearing their guards
    // (fetch wrappers are idempotent via window.__kytOriginalFetch).
    reInjectContentScripts().catch(err => {
      console.error('❌ Re-injection failed, scheduling retry:', err.message);
      chrome.alarms.create('reInjectContentScripts', { delayInMinutes: 0.1 }); // 6s retry
    });

    // Backfill null embeddings (messages synced during 403/422 era)
    // Run after a short delay to let service worker fully initialize
    setTimeout(async () => {
      console.log('🔄 Extension update: starting embedding backfill...');
      try {
        const result = await backfillNullEmbeddings();
        if (result.success) {
          console.log(`✅ Update backfill: ${result.backfilled} messages patched`);
        } else {
          console.warn(`⚠️ Update backfill incomplete: ${result.error} (backfilled: ${result.backfilled || 0})`);
          // Schedule retry alarm if backfill was interrupted
          if (result.willRetry || result.remaining) {
            chrome.alarms.create('backfillEmbeddings', { delayInMinutes: 5 });
            console.log('⏰ Backfill retry alarm set (5 minutes)');
          }
        }
      } catch (err) {
        console.error('❌ Update backfill error:', err.message);
      }

      // Schedule contextual backfill after embeddings settle
      chrome.alarms.create('backfillContextual', { delayInMinutes: 2 });
      console.log('⏰ Contextual backfill alarm set (2 minutes post-update)');
    }, 3000);

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
  clearStorage: () => chrome.storage.local.clear().then(() => console.log('✅ Storage cleared')),

  // Backfill null embeddings in Supabase (for messages synced during 403/422 era)
  backfillEmbeddings: () => backfillNullEmbeddings().then(console.log),

  // Backfill entity extraction (re-extract entities with CONCEPT/ANALOGY/THEME support)
  backfillEntities: (force = false) => callEdgeFunction('backfill_entities', { force_reextract: force })
    .then(result => {
      console.log('🔗 Entity backfill result:', result);
      return result;
    })
    .catch(err => {
      console.error('❌ Entity backfill failed:', err.message);
      return { success: false, error: err.message };
    }),

  // Backfill contextual retrieval (generate context summaries + re-embed)
  backfillContextual: (limit = 15) => callEdgeFunction('backfill_contextual', { limit })
    .then(result => { console.log('📝 Contextual backfill result:', result); return result; })
    .catch(err => { console.error('❌ Contextual backfill failed:', err.message); return { success: false, error: err.message }; }),
};

console.log('✅ KYT Background: Service worker ready');
console.log('   Debug: Use KYT_DEBUG object for testing');
console.log('   - KYT_DEBUG.getStats() - View storage statistics');
console.log('   - KYT_DEBUG.getContext("test message") - Test context retrieval');
console.log('   - KYT_DEBUG.viewStorage() - View all storage');
console.log('   - KYT_DEBUG.backfillEmbeddings() - Backfill null embeddings in Supabase');
console.log('   - KYT_DEBUG.backfillEntities() - Re-extract entities with CONCEPT/ANALOGY/THEME support');
console.log('   - KYT_DEBUG.backfillContextual() - Generate context summaries + re-embed');
console.log('   Note: chrome.runtime.sendMessage() from service worker to itself does not work');

// Initialize queue processor
queueProcessor.initialize();

// Note: queue processing alarm 'processQueue' is created above (line ~141)
// Consolidated alarm listener handles all alarms below
