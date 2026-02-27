/**
 * KYT Memory Extension - Background Service Worker (Day 1-2)
 * Initialized: true
 *
 * Purpose: Receive captured messages from content script and store in chrome.storage
 * Day 2: Added sync and search capabilities for unified memory
 *
 * MODULARIZED (2026-02-25): Core logic extracted into:
 *   src/auth-config.js       — getApiConfig(), getRoutingMode(), config cache
 *   src/sync-controller.js   — scheduleDebouncedSync(), executeDebouncedSync()
 *   src/context-retrieval.js — getContextForInjection(), preference router, scoring pipeline
 *   src/message-handlers.js  — chrome.runtime.onConnect/onMessage handlers
 *
 * This file remains the orchestrator: lifecycle listeners, alarm handlers,
 * circuit breaker state, saveMessage, storage management, KYT_DEBUG.
 *
 * Compliance: CLAUDE.md Anti-Theater Rules
 * - Real storage verification (not console.log theater)
 * - Actual error handling
 * - Health monitoring for API fragility
 */

// ===== STATIC IMPORTS (MV3 — no dynamic import()) =====
import { syncToSupabase, backfillNullEmbeddings } from './src/browser-sync.js';
import { prewarmEmbeddingModel } from './src/browser-search.js';
import { queueProcessor } from './src/background/queue-processor.js';
import { callEdgeFunction } from './src/api-client.js';
import { HistoryImporter } from './src/history-import/index.js';
import { refreshSession, isAuthenticated, AUTH_SESSION_KEY } from './src/auth/auth-service.js';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './src/supabase-config.js';
import { detectDeflection } from './src/assistant-quality-detector.js';

// Extracted modules
import { getApiConfig, clearConfigCache } from './src/auth-config.js';
import { scheduleDebouncedSync, executeDebouncedSync, cancelTimersAndFlush } from './src/sync-controller.js';
import {
  getContextForInjection as _getContextForInjection,
  stripInjectionPrefix,
  detectIsQuestion,
} from './src/context-retrieval.js';
import { registerPortHandler, registerMessageHandler } from './src/message-handlers.js';
import { getMemoryMode, updateBadge } from './src/memory-mode.js';

self.HistoryImporter = HistoryImporter; // Expose for debugging

let activeImporter = null;
// Ref object so message-handlers can read/write activeImporter
const activeImporterRef = { get current() { return activeImporter; }, set current(v) { activeImporter = v; } };

// ===== CIRCUIT BREAKER & RETRY LOGIC =====
let consecutiveApiFailures = 0;
let circuitBreakerOpenUntil = 0;
const CIRCUIT_BREAKER_THRESHOLD = 5;
const CIRCUIT_BREAKER_RESET_MS = 60 * 1000;
const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY_MS = 1000;

let apiMetrics = {
  totalAttempts: 0,
  successfulAttempts: 0,
  failedAttempts: 0,
  retriedAttempts: 0,
  circuitBreakerTrips: 0
};

let totalMessagesSaved = 0;
let lastSaveTime = 0;
let totalErrors = 0;

function isCircuitBreakerOpen() {
  const now = Date.now();
  if (circuitBreakerOpenUntil > now) return true;
  if (circuitBreakerOpenUntil > 0 && now >= circuitBreakerOpenUntil) {
    console.log('🔄 Circuit breaker auto-reset - resuming API calls');
    consecutiveApiFailures = 0;
    circuitBreakerOpenUntil = 0;
  }
  return false;
}

function recordApiSuccess() {
  consecutiveApiFailures = 0;
  circuitBreakerOpenUntil = 0;
  apiMetrics.successfulAttempts++;
}

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

async function retryWithBackoff(fn, options = {}) {
  const {
    maxRetries = MAX_RETRIES,
    initialDelay = INITIAL_RETRY_DELAY_MS,
    shouldRetry = (error) => {
      if (error.message?.includes('503') || error.message?.includes('Overloaded')) return true;
      if (error.message?.includes('500') || error.message?.includes('Internal server error')) return true;
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
      if (attempt > 0) {
        apiMetrics.retriedAttempts++;
        console.log(`✅ Retry successful on attempt ${attempt + 1}`);
      }
      recordApiSuccess();
      return result;
    } catch (error) {
      lastError = error;
      if (attempt === maxRetries || !shouldRetry(error)) {
        recordApiFailure();
        throw error;
      }
      const delay = initialDelay * Math.pow(2, attempt);
      onRetry(attempt + 1, error, delay);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}

function logApiMetrics() {
  const successRate = apiMetrics.totalAttempts > 0
    ? ((apiMetrics.successfulAttempts / apiMetrics.totalAttempts) * 100).toFixed(1) : 0;
  const retryRate = apiMetrics.successfulAttempts > 0
    ? ((apiMetrics.retriedAttempts / apiMetrics.successfulAttempts) * 100).toFixed(1) : 0;
  console.log(
    `📊 API Metrics: ${apiMetrics.successfulAttempts}/${apiMetrics.totalAttempts} successful (${successRate}%), ` +
    `${apiMetrics.retriedAttempts} retried (${retryRate}%), ` +
    `${apiMetrics.failedAttempts} failed, ` +
    `${apiMetrics.circuitBreakerTrips} circuit breaker trips`
  );
}

// ===== BOUND getContextForInjection =====
// Wraps the extracted function with background.js-local state (circuit breaker, sync)
function getContextForInjection(userMessage, config) {
  return _getContextForInjection(userMessage, config, {
    isCircuitBreakerOpen,
    circuitBreakerOpenUntil,
    consecutiveApiFailures,
    apiMetrics,
    logApiMetrics,
    syncBeforeSearch: async () => {
      const pendingResult = await chrome.storage.local.get(['kyt_sync_pending']);
      if (pendingResult.kyt_sync_pending) {
        console.log('Sync-before-search: triggering flush (non-blocking)...');
        cancelTimersAndFlush();
        executeDebouncedSync().catch(err =>
          console.warn('Sync-before-search background flush failed:', err.message)
        );
      }
    },
  });
}

// ===== STORAGE MANAGEMENT =====
let saveMessageCounter = 0;

const STORAGE_CONFIG = {
  MAX_USAGE_PERCENT: 80,
  TARGET_USAGE_PERCENT: 70,
  MIN_MESSAGES_TO_KEEP: 100
};

async function hashContent(content) {
  const normalized = content.trim().normalize('NFC');
  const encoder = new TextEncoder();
  const data = encoder.encode(normalized);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

function findDuplicate(messages, contentHash, maxScan = 200) {
  const startIdx = Math.max(0, messages.length - maxScan);
  for (let i = messages.length - 1; i >= startIdx; i--) {
    if (messages[i].contentHash === contentHash) return messages[i];
  }
  return null;
}

function generateMessageId() {
  return `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

async function saveMessage(messageData) {
  try {
    if (!messageData || typeof messageData !== 'object') {
      throw new Error('Invalid message data: expected object');
    }
    if (!messageData.content || typeof messageData.content !== 'string') {
      throw new Error('Invalid message content: expected non-empty string');
    }

    const result = await chrome.storage.local.get(['captured_messages', 'kyt_stats']);
    const messages = result.captured_messages || [];
    const stats = {
      messagesCaptured: { api: 0, dom: 0 },
      lastCapture: { api: null, dom: null },
      duplicatesBlocked: 0,
      ...(result.kyt_stats || {})
    };
    if (!stats.messagesCaptured) stats.messagesCaptured = { api: 0, dom: 0 };
    if (!stats.lastCapture) stats.lastCapture = { api: null, dom: null };

    const contentHash = await hashContent(messageData.content);
    const timestamp = messageData.timestamp || Date.now();

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

    // Strip KYT injection prefix before any analysis
    const injectionResult = stripInjectionPrefix(messageData.content);
    messageData.content = injectionResult.content;
    const hadInjection = injectionResult.hadInjection;

    // Detect assistant deflections/echoes (Layer 1: capture-time tagging)
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

    const source = messageData.source || 'api';
    stats.messagesCaptured[source] = (stats.messagesCaptured[source] || 0) + 1;
    stats.lastCapture[source] = Date.now();

    await chrome.storage.local.set({
      captured_messages: messages,
      kyt_stats: stats
    });

    totalMessagesSaved++;
    lastSaveTime = Date.now();
    chrome.storage.local.set({ kyt_last_save_time: lastSaveTime });

    console.log(`✅ KYT Background: Message saved (total: ${messages.length})`);
    console.log(`   Content: "${messageData.content.substring(0, 50)}..."`);
    console.log(`   Source: ${source}`);
    console.log(`   Hash: ${contentHash.substring(0, 16)}...`);

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
    try {
      const errorLog = await chrome.storage.local.get(['error_log']);
      const errors = errorLog.error_log || [];
      errors.push({ type: 'STORAGE_ERROR', message: error.message, timestamp: Date.now() });
      if (errors.length > 100) errors.splice(0, errors.length - 100);
      await chrome.storage.local.set({ error_log: errors });
    } catch (logError) {
      console.error('❌ Failed to log error:', logError);
    }
    return { saved: false, reason: 'error', error: error.message };
  }
}

async function checkStorageQuota() {
  try {
    const result = await chrome.storage.local.get(['captured_messages']);
    const messages = result.captured_messages || [];
    const storageSize = JSON.stringify(messages).length;
    const storageLimitBytes = chrome.storage.local.QUOTA_BYTES;
    const usagePercent = (storageSize / storageLimitBytes) * 100;
    return {
      isExceeded: usagePercent > STORAGE_CONFIG.MAX_USAGE_PERCENT,
      usagePercent, storageSize, storageLimitBytes,
      messageCount: messages.length
    };
  } catch (error) {
    console.error('❌ Failed to check storage quota:', error);
    return { isExceeded: false, error: error.message };
  }
}

async function evictOldMessages() {
  try {
    console.log('🗑️  Storage quota exceeded - starting LRU eviction...');
    const result = await chrome.storage.local.get(['captured_messages']);
    const messages = result.captured_messages || [];

    if (messages.length <= STORAGE_CONFIG.MIN_MESSAGES_TO_KEEP) {
      console.warn('⚠️  Cannot evict - already at minimum message count');
      return { evicted: 0, reason: 'at_minimum' };
    }

    const sorted = [...messages].sort((a, b) => {
      const timeA = a.capturedAt || a.timestamp || 0;
      const timeB = b.capturedAt || b.timestamp || 0;
      return timeA - timeB;
    });

    const currentSize = JSON.stringify(messages).length;
    const targetSize = chrome.storage.local.QUOTA_BYTES * (STORAGE_CONFIG.TARGET_USAGE_PERCENT / 100);

    let evictedCount = 0;
    let currentMessages = [...messages];

    while (currentMessages.length > STORAGE_CONFIG.MIN_MESSAGES_TO_KEEP) {
      const newSize = JSON.stringify(currentMessages).length;
      if (newSize <= targetSize) break;

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
      newUsagePercent
    };
  } catch (error) {
    console.error('❌ Eviction failed:', error);
    return { evicted: 0, error: error.message };
  }
}

async function getStorageStats() {
  try {
    const result = await chrome.storage.local.get(['captured_messages', 'error_log']);
    const messages = result.captured_messages || [];
    const errors = result.error_log || [];
    const storageSize = JSON.stringify(messages).length;
    const storageLimitBytes = chrome.storage.local.QUOTA_BYTES;
    const usagePercent = ((storageSize / storageLimitBytes) * 100).toFixed(2);
    return {
      totalMessages: messages.length,
      totalErrors: errors.length,
      storageSize, storageSizeKB: (storageSize / 1024).toFixed(2),
      storageLimitKB: (storageLimitBytes / 1024).toFixed(0),
      usagePercent, lastSaveTime,
      timeSinceLastSave: Date.now() - lastSaveTime
    };
  } catch (error) {
    console.error('❌ Failed to get storage stats:', error);
    return null;
  }
}

// ===== PENDING LOCAL QUEUES =====
async function processPendingLocalQueues() {
  try {
    // Process emergency queue
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
      await chrome.storage.local.set({ [emergencyKey]: failed });
      if (failed.length === 0) {
        console.log('✅ Emergency queue fully processed');
      } else {
        console.warn(`⚠️ ${failed.length} emergency messages failed, will retry later`);
      }
    }

    // Process unencrypted fallback queue
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

// ===== REGISTER MESSAGE HANDLERS =====
registerPortHandler(getContextForInjection);
registerMessageHandler({
  getContextForInjection,
  saveMessage,
  scheduleDebouncedSync,
  getStorageStats,
  queueProcessor,
  processPendingLocalQueues,
  activeImporterRef,
});

// ===== LIFECYCLE: onSuspend =====
chrome.runtime.onSuspend.addListener(() => {
  console.log('⏸️ Service worker suspending - clearing config cache');
  clearConfigCache();
});

// ===== LIFECYCLE: onInstalled (sync existing) =====
chrome.runtime.onInstalled.addListener(async (details) => {
  console.log('🔄 KYT Background: Extension installed/updated');
  console.log(`   Reason: ${details.reason}`);

  // Diagnostic: verify host_permissions
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

  getMemoryMode().then(updateBadge);
});

// ===== LIFECYCLE: onStartup (queue processor + auth refresh) =====
chrome.runtime.onStartup.addListener(() => {
  try {
    queueProcessor.initialize();
    queueProcessor.processQueue();
    processPendingLocalQueues();
    getMemoryMode().then(updateBadge);
  } catch (error) {
    console.error('❌ Failed to initialize queue processor on startup:', error);
    chrome.storage.local.get(['error_log'], (result) => {
      const errors = result.error_log || [];
      errors.push({ timestamp: Date.now(), context: 'queue_processor_startup', error: error.message, stack: error.stack });
      chrome.storage.local.set({ error_log: errors });
    });
  }
});

// Also initialize on install
chrome.runtime.onInstalled.addListener(() => {
  try {
    queueProcessor.initialize();
    queueProcessor.processQueue();
    processPendingLocalQueues();
  } catch (error) {
    console.error('❌ Failed to initialize queue processor on install:', error);
    chrome.storage.local.get(['error_log'], (result) => {
      const errors = result.error_log || [];
      errors.push({ timestamp: Date.now(), context: 'queue_processor_install', error: error.message, stack: error.stack });
      chrome.storage.local.set({ error_log: errors });
    });
  }
});

// Periodic queue processing (every 1 min)
chrome.alarms.create('processQueue', { periodInMinutes: 1 });

// ===== LIFECYCLE: onInstalled (initial sync) =====
chrome.runtime.onInstalled.addListener(async (details) => {
  console.log('🔄 KYT Background: Extension installed/updated');
  console.log(`   Reason: ${details.reason}`);

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

// ===== LIFECYCLE: onStartup (auth refresh + pending recovery) =====
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

  // Restore lastSaveTime so health check doesn't show misleading "1770780747s ago"
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

// ===== RE-INJECT CONTENT SCRIPTS =====
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
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => { window.KYT_CHATGPT_INJECTED = false; },
          world: 'MAIN'
        });
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
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => { window.KYT_CLAUDE_INJECTED = false; },
          world: 'MAIN'
        });
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['platforms/claude/content_test.js'],
          world: 'MAIN'
        });
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

  // ── Gemini tabs ───────────────────────────────────────────────────────
  try {
    const geminiTabs = await chrome.tabs.query({ url: 'https://gemini.google.com/*' });
    console.log(`🔌 Found ${geminiTabs.length} Gemini tab(s)`);

    for (const tab of geminiTabs) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => { window.KYT_GEMINI_INJECTED = false; },
          world: 'MAIN'
        });
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['platforms/gemini/content_test.js'],
          world: 'MAIN'
        });
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['platforms/gemini/content_bridge.js']
        });
        console.log(`✅ Re-injected Gemini scripts into tab ${tab.id}`);
      } catch (e) {
        console.warn(`⚠️ Failed to re-inject Gemini tab ${tab.id}:`, e.message);
      }
    }
  } catch (e) {
    console.error('❌ Gemini tab query failed:', e.message);
  }

  console.log('🔌 Content script re-injection complete');
}

// ===== LIFECYCLE: onInstalled (storage init / update handlers) =====
chrome.runtime.onInstalled.addListener((details) => {
  console.log('🔧 KYT: Extension installed/updated:', details.reason);
  getMemoryMode().then(updateBadge);

  if (details.reason === 'install') {
    chrome.storage.local.set({
      captured_messages: [],
      error_log: [],
      install_date: Date.now(),
      version: chrome.runtime.getManifest().version,
      show_import_onboarding: true,
      show_login_prompt: true,
      api_config: {
        disableQueryTransformation: true
      }
    }).then(() => {
      console.log('✅ KYT: Storage initialized');
      console.log('   Phase 1 fix enabled: disableQueryTransformation = true');
      console.log('   First-install onboarding: login prompt + import enabled');

      // Auto-open welcome flow on first install
      chrome.tabs.create({
        url: chrome.runtime.getURL('popup/import-modal.html?mode=first-install'),
        active: true,
      });
    }).catch(error => {
      console.error('❌ KYT: Failed to initialize storage:', error);
    });
  } else if (details.reason === 'update') {
    // Reset circuit breakers on update
    chrome.storage.local.remove('kyt_embedding_circuit_breaker', () => {
      console.log('🔌 Embedding circuit breaker reset on extension update');
    });
    chrome.storage.local.remove('kyt_jina_circuit_breaker', () => {
      console.log('🔌 Jina circuit breaker reset on extension update');
    });
    chrome.storage.local.remove('kyt_hyde_circuit_breaker', () => {
      console.log('🔌 HyDE circuit breaker reset on extension update');
    });

    // One-time userId backfill
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

    // Clear stale process_queue alarm
    chrome.alarms.clear('process_queue', (wasCleared) => {
      if (wasCleared) console.log('🧹 Cleared stale process_queue alarm');
    });

    // Re-inject content scripts into open tabs
    reInjectContentScripts().catch(err => {
      console.error('❌ Re-injection failed, scheduling retry:', err.message);
      chrome.alarms.create('reInjectContentScripts', { delayInMinutes: 0.1 });
    });

    // Backfill null embeddings
    setTimeout(async () => {
      console.log('🔄 Extension update: starting embedding backfill...');
      try {
        const result = await backfillNullEmbeddings();
        if (result.success) {
          console.log(`✅ Update backfill: ${result.backfilled} messages patched`);
        } else {
          console.warn(`⚠️ Update backfill incomplete: ${result.error} (backfilled: ${result.backfilled || 0})`);
          if (result.willRetry || result.remaining) {
            chrome.alarms.create('backfillEmbeddings', { delayInMinutes: 5 });
            console.log('⏰ Backfill retry alarm set (5 minutes)');
          }
        }
      } catch (err) {
        console.error('❌ Update backfill error:', err.message);
      }
      chrome.alarms.create('backfillContextual', { delayInMinutes: 2 });
      console.log('⏰ Contextual backfill alarm set (2 minutes post-update)');
    }, 3000);

    // Migration: Set Phase 1 default for existing users
    chrome.storage.local.get(['api_config'], (result) => {
      const existingConfig = result.api_config || {};
      if (existingConfig.disableQueryTransformation === undefined) {
        const updatedConfig = { ...existingConfig, disableQueryTransformation: true };
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

// ===== ALARM CREATION =====
chrome.alarms.create('health_check', { periodInMinutes: 5 });
chrome.alarms.create('prewarmEmbedding', { delayInMinutes: 1, periodInMinutes: 30 });
chrome.alarms.create('tokenRefresh', { periodInMinutes: 45 });

// ===== SYNC-ON-PLATFORM-SWITCH =====
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  try {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    if (!tab.url) return;
    const isKYTPlatform =
      tab.url.startsWith('https://claude.ai/') ||
      tab.url.startsWith('https://chatgpt.com/') ||
      tab.url.startsWith('https://chat.openai.com/') ||
      tab.url.startsWith('https://gemini.google.com/');
    if (isKYTPlatform) {
      const pendingResult = await chrome.storage.local.get(['kyt_sync_pending']);
      if (pendingResult.kyt_sync_pending) {
        console.log(`Platform switch detected: ${new URL(tab.url).hostname} — flushing pending sync`);
        cancelTimersAndFlush();
        await executeDebouncedSync();
      }
    }
  } catch (_err) {
    // Tab may be inaccessible — ignore
  }
});

// ===== CONSOLIDATED ALARM LISTENER =====
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
          errors.push({ timestamp: Date.now(), context: 'queue_processor_alarm', error: error.message, stack: error.stack });
          chrome.storage.local.set({ error_log: errors });
        });
      }
      break;

    case 'periodicSync':
      try {
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
          chrome.alarms.clear('backfillEmbeddings');
        } else if (backfillResult.willRetry || backfillResult.remaining) {
          console.warn(`⚠️ Backfill retry incomplete, will try again in 5 minutes`);
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
          if (ctxResult.processed >= 15) {
            chrome.alarms.create('backfillContextual', { delayInMinutes: 5 });
          }
        } else {
          console.log('✅ Contextual backfill: no rows remaining');
        }
      } catch (error) {
        console.error('❌ Contextual backfill alarm error:', error.message);
        chrome.alarms.create('backfillContextual', { delayInMinutes: 10 });
      }
      break;

    case 'backfillEntities':
      try {
        console.log('⏰ Entity backfill alarm fired');
        const entResult = await callEdgeFunction('backfill_entities', { fast_mode: true, max_rows: 50 });
        console.log(`✅ Entity backfill: ${entResult.processed} processed, ${entResult.entities_created} entities, ${entResult.remaining} remaining`);
        if (entResult.remaining > 0) {
          chrome.alarms.create('backfillEntities', { delayInMinutes: 3 });
        }
      } catch (error) {
        console.error('❌ Entity backfill alarm error:', error.message);
        chrome.alarms.create('backfillEntities', { delayInMinutes: 10 });
      }
      break;

    case 'postImportBackfill':
      try {
        console.log('⏰ Post-import backfill orchestrator fired');
        // Check if contextual backfill still has work
        const ctxCheck = await callEdgeFunction('backfill_contextual', { limit: 1 });
        if (ctxCheck.context_generated > 0 || ctxCheck.processed > 0) {
          console.log('📝 Contextual backfill still has work — rescheduling post-import in 3min');
          chrome.alarms.create('backfillContextual', { delayInMinutes: 1 });
          chrome.alarms.create('postImportBackfill', { delayInMinutes: 3 });
        } else {
          // Contextual done → start entity backfill chain
          console.log('✅ Contextual complete — starting entity backfill chain');
          chrome.alarms.create('backfillEntities', { delayInMinutes: 0.5 });
        }
      } catch (error) {
        console.error('❌ Post-import backfill error:', error.message);
        // Still try entity backfill even if contextual check fails
        chrome.alarms.create('backfillEntities', { delayInMinutes: 3 });
      }
      break;

    case 'prewarmEmbedding':
      try {
        await prewarmEmbeddingModel();
      } catch (error) {
        // Pre-warm is best-effort
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

// ===== HELPER FUNCTIONS FOR KYT_DEBUG =====
// getConfig and getAuthHeaders for exclude/include conversation debug commands
async function getConfig() {
  const apiConfig = await getApiConfig();
  return {
    supabaseUrl: apiConfig.supabaseUrl || SUPABASE_URL,
    supabaseKey: apiConfig.supabaseKey || SUPABASE_ANON_KEY,
    accessToken: apiConfig.accessToken,
    userId: apiConfig.userId,
  };
}

function getAuthHeaders(config) {
  const authToken = config.accessToken || config.supabaseKey;
  return {
    'apikey': config.supabaseKey,
    'Authorization': `Bearer ${authToken}`,
  };
}

// ===== KYT_DEBUG =====
globalThis.KYT_DEBUG = {
  getStats: () => getStorageStats().then(console.log),
  getContext: (message) => getContextForInjection(message, {}).then(console.log),
  viewStorage: () => chrome.storage.local.get(null).then(console.log),
  clearStorage: () => chrome.storage.local.clear().then(() => console.log('✅ Storage cleared')),
  backfillEmbeddings: () => backfillNullEmbeddings().then(console.log),
  backfillEntities: (force = false) => callEdgeFunction('backfill_entities', { force_reextract: force })
    .then(result => { console.log('🔗 Entity backfill result:', result); return result; })
    .catch(err => { console.error('❌ Entity backfill failed:', err.message); return { success: false, error: err.message }; }),
  backfillContextual: (limit = 15) => callEdgeFunction('backfill_contextual', { limit })
    .then(result => { console.log('📝 Contextual backfill result:', result); return result; })
    .catch(err => { console.error('❌ Contextual backfill failed:', err.message); return { success: false, error: err.message }; }),
  backfillPostImport: () => {
    console.log('🔄 Starting post-import backfill chain...');
    chrome.alarms.create('backfillContextual', { delayInMinutes: 0.1 });
    chrome.alarms.create('postImportBackfill', { delayInMinutes: 1 });
    return 'Post-import backfill chain started (contextual → entities)';
  },
  excludeConversation: async (conversationId) => {
    const config = await getConfig();
    const headers = getAuthHeaders(config);
    const r1 = await fetch(
      `${config.supabaseUrl}/rest/v1/chat_turns?conversation_id=eq.${encodeURIComponent(conversationId)}&user_id=eq.${config.userId}`,
      { method: 'PATCH', headers: { ...headers, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
        body: JSON.stringify({ exclude_from_search: true }) }
    );
    const r2 = await fetch(
      `${config.supabaseUrl}/rest/v1/messages?conversation_id=eq.${encodeURIComponent(conversationId)}&user_id=eq.${config.userId}`,
      { method: 'PATCH', headers: { ...headers, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
        body: JSON.stringify({ exclude_from_search: true }) }
    );
    const d1 = await r1.json(), d2 = await r2.json();
    console.log(`🚫 Excluded conversation ${conversationId}: ${d1.length} chat_turns, ${d2.length} messages`);
    return { chat_turns: d1.length, messages: d2.length };
  },
  includeConversation: async (conversationId) => {
    const config = await getConfig();
    const headers = getAuthHeaders(config);
    const r1 = await fetch(
      `${config.supabaseUrl}/rest/v1/chat_turns?conversation_id=eq.${encodeURIComponent(conversationId)}&user_id=eq.${config.userId}`,
      { method: 'PATCH', headers: { ...headers, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
        body: JSON.stringify({ exclude_from_search: false }) }
    );
    const r2 = await fetch(
      `${config.supabaseUrl}/rest/v1/messages?conversation_id=eq.${encodeURIComponent(conversationId)}&user_id=eq.${config.userId}`,
      { method: 'PATCH', headers: { ...headers, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
        body: JSON.stringify({ exclude_from_search: false }) }
    );
    const d1 = await r1.json(), d2 = await r2.json();
    console.log(`✅ Re-included conversation ${conversationId}: ${d1.length} chat_turns, ${d2.length} messages`);
    return { chat_turns: d1.length, messages: d2.length };
  },
};

console.log('✅ KYT Background: Service worker ready');
console.log('   Debug: Use KYT_DEBUG object for testing');
console.log('   - KYT_DEBUG.getStats() - View storage statistics');
console.log('   - KYT_DEBUG.getContext("test message") - Test context retrieval');
console.log('   - KYT_DEBUG.viewStorage() - View all storage');
console.log('   - KYT_DEBUG.backfillEmbeddings() - Backfill null embeddings in Supabase');
console.log('   - KYT_DEBUG.backfillEntities() - Re-extract entities with CONCEPT/ANALOGY/THEME support');
console.log('   - KYT_DEBUG.backfillContextual() - Generate context summaries + re-embed');
console.log('   - KYT_DEBUG.backfillPostImport() - Full post-import chain (contextual → entities)');
console.log('   - KYT_DEBUG.excludeConversation(id) - Hide a conversation from search (reversible)');
console.log('   - KYT_DEBUG.includeConversation(id) - Un-hide a conversation from search');
console.log('   Note: chrome.runtime.sendMessage() from service worker to itself does not work');

// Initialize queue processor
queueProcessor.initialize();

// Note: queue processing alarm 'processQueue' is created above
// Consolidated alarm listener handles all alarms below
