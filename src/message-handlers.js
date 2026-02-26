/**
 * Message Handlers Module
 * Extracted from background.js — chrome.runtime.onConnect (port) and
 * chrome.runtime.onMessage (legacy) handlers.
 *
 * IMPORTANT (MV3): All imports must be static. No dynamic import().
 */

import { syncToSupabase } from './browser-sync.js';
import { searchMessages, findSimilarMessages } from './browser-search.js';
import { syncViaEdgeFunction } from './edge-sync.js';
import { getApiConfig, getRoutingMode } from './auth-config.js';
import { HistoryImporter } from './history-import/index.js';
import { classifyIntent } from './intent-classifier.js';
import { classifyWithHaiku, isHaikuEnabled } from './haiku-tiebreaker.js';
import { getMemoryMode, setMemoryMode } from './memory-mode.js';
import { getActiveProfileId } from './profile-manager.js';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './supabase-config.js';
import { AUTH_SESSION_KEY } from './auth/auth-service.js';

// ===== LAYER 2 INTENT CLASSIFICATION (LLM Judge) =====

/**
 * Escalate a PASSIVE classification to the LLM judge (Haiku 4.5) for a
 * second opinion. Only called for PASSIVE — QUERY and SKIP bypass this.
 *
 * Routing:
 *   MEMORY_QUERY  → intent=QUERY, threshold=0.50 (pipeline fires, elevated threshold)
 *   NO_RETRIEVAL  → intent=SKIP (no pipeline)
 *   FALLBACK      → unchanged PASSIVE at 0.60 (Haiku unavailable/timeout/rate-limited)
 *
 * @param {string} message - The user's message
 * @param {Object} classification - Layer 1 result from classifyIntent()
 * @returns {Promise<Object>} Updated classification
 */
async function escalateToLayer2(message, classification) {
  // Feature toggle — when disabled, PASSIVE uses v2 behavior unchanged
  if (!(await isHaikuEnabled())) {
    return classification;
  }

  const haiku = await classifyWithHaiku(message, classification.scores, classification.reason);

  if (haiku.classification === 'MEMORY_QUERY') {
    const s = classification.scores;
    console.log(
      `🤖 Haiku: MEMORY_QUERY (${haiku.latencyMs}ms) ` +
      `[D:${s.directive.toFixed(2)} M:${s.memory.toFixed(2)} ` +
      `Q:${s.question.toFixed(2)} P:${s.personal.toFixed(2)} ` +
      `T:${s.temporal.toFixed(2)} ρ:${s.density.toFixed(2)}] ` +
      `→ "${message.substring(0, 80)}"`
    );
    return {
      ...classification,
      intent: 'QUERY',
      confidenceThreshold: 0.50,
      reason: 'haiku_memory_query',
      layer: 2,
      haikuLatencyMs: haiku.latencyMs,
    };
  }

  if (haiku.classification === 'NO_RETRIEVAL') {
    const s = classification.scores;
    console.log(
      `🤖 Haiku: NO_RETRIEVAL (${haiku.latencyMs}ms, ${haiku.source}) ` +
      `[D:${s.directive.toFixed(2)} M:${s.memory.toFixed(2)} ` +
      `Q:${s.question.toFixed(2)} P:${s.personal.toFixed(2)} ` +
      `T:${s.temporal.toFixed(2)} ρ:${s.density.toFixed(2)}] ` +
      `→ "${message.substring(0, 80)}"`
    );
    return {
      ...classification,
      intent: 'SKIP',
      confidenceThreshold: null,
      reason: 'haiku_no_retrieval',
      layer: 2,
      haikuLatencyMs: haiku.latencyMs,
    };
  }

  // FALLBACK — Haiku unavailable (timeout, rate limit, error)
  // Fall through to v2 PASSIVE behavior unchanged
  console.log(`🤖 Haiku: fallback (${haiku.latencyMs}ms, ${haiku.source}) — using v2 PASSIVE`);
  return classification;
}

// ===== GDPR DATA HELPERS =====

/**
 * Get auth headers for Supabase REST calls.
 * Prefers JWT session, falls back to anon key.
 */
async function getAuthConfig() {
  const result = await chrome.storage.local.get([AUTH_SESSION_KEY, 'api_config']);
  const session = result[AUTH_SESSION_KEY];
  const config = result.api_config;

  let supabaseUrl = SUPABASE_URL;
  let bearerToken = SUPABASE_ANON_KEY;
  let userId = null;

  if (session?.access_token && session.expires_at > Math.floor(Date.now() / 1000)) {
    bearerToken = session.access_token;
    userId = session.user?.id;
  } else if (config?.supabaseUrl) {
    supabaseUrl = config.supabaseUrl;
    if (config.supabaseKey) bearerToken = config.supabaseKey;
    userId = config.userId;
  }

  return {
    supabaseUrl,
    headers: {
      'Authorization': `Bearer ${bearerToken}`,
      'apikey': SUPABASE_ANON_KEY,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation',
    },
    userId,
  };
}

// ===== INJECTION HEALTH STATS =====
const INJECTION_STATS_KEY = 'kyt_injection_stats';

export async function updateInjectionStats(update) {
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

/**
 * Register the port-based handler for GET_CONTEXT requests.
 * Using chrome.runtime.connect() instead of sendMessage+return true avoids
 * the "message channel closed" error in chrome://extensions when the SW dies
 * mid-request.
 *
 * @param {Function} getContextForInjection - The context retrieval function
 */
export function registerPortHandler(getContextForInjection) {
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

        // Memory mode gate — skip injection unless full mode
        const memMode = await getMemoryMode();
        if (memMode !== 'full') {
          console.log(`🚫 ${memMode} mode — injection skipped`);
          port.postMessage({ requestId: msg.requestId, success: true, items: [], formattedContext: null, modeBlocked: true, mode: memMode });
          return;
        }

        // Intent classification gate — skip retrieval for directives/filler
        let classification = classifyIntent(msg.userMessage);
        const s = classification.scores;
        console.log(`🎯 Intent: ${classification.intent} (${classification.reason})` +
          (s ? ` [D:${s.directive.toFixed(2)} M:${s.memory.toFixed(2)} Q:${s.question.toFixed(2)} P:${s.personal.toFixed(2)} T:${s.temporal.toFixed(2)} ρ:${s.density.toFixed(2)}]` : '') +
          (classification.confidenceThreshold ? ` threshold=${classification.confidenceThreshold}` : '') +
          ` → "${msg.userMessage.substring(0, 80)}${msg.userMessage.length > 80 ? '...' : ''}"`);

        if (classification.intent === 'SKIP') {
          console.log(`⏭️ Skipping injection: ${classification.reason}`);
          port.postMessage({ requestId: msg.requestId, success: true, items: [], formattedContext: null, intentSkipped: true, skipReason: classification.reason });
          return;
        }

        // Layer 2: LLM judge for PASSIVE cases — may override to SKIP
        if (classification.intent === 'PASSIVE') {
          classification = await escalateToLayer2(msg.userMessage, classification);
          if (classification.intent === 'SKIP') {
            console.log(`⏭️ Skipping injection (Layer 2): ${classification.reason}`);
            port.postMessage({ requestId: msg.requestId, success: true, items: [], formattedContext: null, intentSkipped: true, skipReason: classification.reason });
            return;
          }
        }

        updateInjectionStats({ attempt: true }).catch(() => {});

        const result = await chrome.storage.local.get(['kytDebugMode']);
        const config = { ...msg.config, debugMode: result.kytDebugMode || false };

        // Apply per-message confidence threshold from intent classifier
        if (classification.confidenceThreshold) {
          config.confidenceThreshold = classification.confidenceThreshold;
        }

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
}

/**
 * Register the chrome.runtime.onMessage listener.
 *
 * @param {Object} deps - Injectable dependencies
 * @param {Function} deps.getContextForInjection - Context retrieval function
 * @param {Function} deps.saveMessage - Save message to local storage
 * @param {Function} deps.scheduleDebouncedSync - Schedule sync
 * @param {Function} deps.getStorageStats - Get storage statistics
 * @param {Object} deps.queueProcessor - Queue processor instance
 * @param {Function} deps.processPendingLocalQueues - Process emergency/pending queues
 * @param {Object} deps.activeImporterRef - { current: HistoryImporter | null }
 */
export function registerMessageHandler(deps) {
  const {
    getContextForInjection,
    saveMessage,
    scheduleDebouncedSync,
    getStorageStats,
    queueProcessor,
    processPendingLocalQueues,
    activeImporterRef,
  } = deps;

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log('📨 KYT Background: Received message:', message.type);

    switch (message.type) {
      case 'FLUSH_QUEUE':
        Promise.all([
          queueProcessor.processQueue(),
          processPendingLocalQueues()
        ])
          .then(([queueResult]) => sendResponse(queueResult || { success: true }))
          .catch(err => sendResponse({ error: err.message }));
        return true;

      case 'SYNC_MESSAGE':
        queueProcessor.syncSingle(message.payload)
          .then(success => sendResponse({ success }))
          .catch(err => sendResponse({ success: false, error: err.message }));
        return true;

      case 'SAVE_MESSAGE':
        (async () => {
          try {
            const mode = await getMemoryMode();
            if (mode === 'incognito') {
              console.log('👻 Incognito mode — message not captured');
              sendResponse({ success: true, queued: false, reason: 'incognito_mode' });
              return;
            }
            console.log(`📝 Captured message (mode: ${mode})`);
            const result = await saveMessage(message.data);
            if (result && result.saved !== false) {
              scheduleDebouncedSync();
              sendResponse({ success: true, queued: true });
            } else {
              sendResponse({ success: true, queued: false, reason: result?.reason });
            }
          } catch (error) {
            console.error('❌ Save failed:', error);
            sendResponse({ success: false, error: error.message });
          }
        })();
        return true;

      case 'EXTRACTION_ERROR':
        console.error('⚠️ Content script extraction error:', message.error);
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
        return true;

      case 'HEALTH_WARNING':
        console.warn('⚠️ Health warning from content script:', message.message);
        console.warn(`   Last intercept: ${new Date(message.lastIntercept).toLocaleString()}`);
        console.warn(`   Total interceptions: ${message.totalInterceptions}`);
        chrome.storage.local.set({
          last_health_warning: {
            message: message.message,
            timestamp: Date.now(),
            lastIntercept: message.lastIntercept,
            totalInterceptions: message.totalInterceptions
          }
        });
        sendResponse({ acknowledged: true });
        return true;

      case 'DEBUG_LOG':
        console.log(`🐛 [Page Log]: ${message.message}`);
        if (message.data) {
          console.log('   Data:', message.data);
        }
        sendResponse({ acknowledged: true });
        return true;

      case 'DOM_OBSERVER_STATUS':
        console.log(`🔍 DOM Observer Status: ${message.status}`);
        if (message.restartAttempts > 0) {
          console.log(`   Restart attempts: ${message.restartAttempts}`);
        }
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
        return true;

      case 'GET_CONTEXT': {
        (async () => {
          const injectionStart = performance.now();
          try {
            if (!message.userMessage || typeof message.userMessage !== 'string') {
              sendResponse({ success: false, error: 'Missing userMessage' });
              return;
            }
            console.log('🔍 KYT Background: Context request for message:', message.userMessage.substring(0, 50) + '...');

            // Memory mode gate — skip injection unless full mode
            const memMode = await getMemoryMode();
            if (memMode !== 'full') {
              console.log(`🚫 ${memMode} mode — injection skipped`);
              sendResponse({ success: true, items: [], formattedContext: null, modeBlocked: true, mode: memMode });
              return;
            }

            // Intent classification gate — skip retrieval for directives/filler
            let classification = classifyIntent(message.userMessage);
            const s = classification.scores;
            console.log(`🎯 Intent: ${classification.intent} (${classification.reason})` +
              (s ? ` [D:${s.directive.toFixed(2)} M:${s.memory.toFixed(2)} Q:${s.question.toFixed(2)} P:${s.personal.toFixed(2)} T:${s.temporal.toFixed(2)} ρ:${s.density.toFixed(2)}]` : '') +
              (classification.confidenceThreshold ? ` threshold=${classification.confidenceThreshold}` : '') +
              ` → "${message.userMessage.substring(0, 80)}${message.userMessage.length > 80 ? '...' : ''}"`);

            if (classification.intent === 'SKIP') {
              console.log(`⏭️ Skipping injection: ${classification.reason}`);
              sendResponse({ success: true, items: [], formattedContext: null, intentSkipped: true, skipReason: classification.reason });
              return;
            }

            // Layer 2: LLM judge for PASSIVE cases — may override to SKIP
            if (classification.intent === 'PASSIVE') {
              classification = await escalateToLayer2(message.userMessage, classification);
              if (classification.intent === 'SKIP') {
                console.log(`⏭️ Skipping injection (Layer 2): ${classification.reason}`);
                sendResponse({ success: true, items: [], formattedContext: null, intentSkipped: true, skipReason: classification.reason });
                return;
              }
            }

            updateInjectionStats({ attempt: true }).catch(() => {});

            const result = await chrome.storage.local.get(['kytDebugMode']);
            const config = {
              ...message.config,
              debugMode: result.kytDebugMode || false
            };

            // Apply per-message confidence threshold from intent classifier
            if (classification.confidenceThreshold) {
              config.confidenceThreshold = classification.confidenceThreshold;
            }

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
        return true;
      }

      case 'GET_INJECTION_STATS':
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
        (async () => {
          try {
            const storageStats = await getStorageStats();
            const apiResult = await chrome.storage.local.get(['api_config']);

            let pageStats = null;
            try {
              const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
              if (tab && tab.id) {
                const response = await chrome.tabs.sendMessage(tab.id, {
                  type: 'GET_PAGE_STATS'
                });
                if (response && response.success) {
                  pageStats = response.stats;
                }
              }
            } catch (error) {
              console.warn('⚠️ Could not get page stats:', error.message);
            }

            const stats = {
              fetch: pageStats?.fetch || { active: false },
              websocket: pageStats?.websocket || { active: false },
              domObserver: pageStats?.domObserver || { active: false },
              totalMessages: storageStats?.totalMessages || 0,
              sessionMessages: pageStats?.totalInterceptions || 0,
              lastCaptureTime: pageStats?.lastInterceptionTime || storageStats?.lastSaveTime || null,
              platform: pageStats?.platform || null
            };

            sendResponse({ success: true, stats });
          } catch (error) {
            sendResponse({ success: false, error: error.message });
          }
        })();
        return true;

      case 'TEST_CAPTURE':
        (async () => {
          try {
            const testMessage = {
              content: 'Test message from diagnostic popup',
              role: 'user',
              source: 'test',
              timestamp: Date.now()
            };
            const saved = await saveMessage(testMessage);
            if (saved) {
              const stats = await getStorageStats();
              sendResponse({ success: true, messageCount: stats.totalMessages });
            } else {
              sendResponse({ success: false, error: 'Failed to save test message' });
            }
          } catch (error) {
            sendResponse({ success: false, error: error.message });
          }
        })();
        return true;

      case 'FORCE_SYNC':
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
        return true;

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

            if (activeImporterRef.current) {
              await activeImporterRef.current.cancelImport();
            }

            activeImporterRef.current = new HistoryImporter(config.supabaseUrl, config.supabaseKey, config.userId);

            activeImporterRef.current.startImport(
              message.platform,
              (progress) => {
                chrome.runtime.sendMessage({
                  type: 'IMPORT_PROGRESS',
                  progress
                }).catch(() => {});
              },
              async () => {
                return null;
              }
            ).then(result => {
              sendResponse({ success: true, result });
              activeImporterRef.current = null;
              // Trigger post-import backfill chain
              chrome.alarms.create('backfillContextual', { delayInMinutes: 1 });
              chrome.alarms.create('postImportBackfill', { delayInMinutes: 3 });
              console.log('⏰ Post-import backfill alarms scheduled (contextual: 1min, orchestrator: 3min)');
            }).catch(error => {
              sendResponse({ success: false, error: error.message });
              activeImporterRef.current = null;
            });

          } catch (error) {
            console.error('Start import failed:', error);
            sendResponse({ success: false, error: error.message });
          }
        })();
        return true;

      case 'CANCEL_HISTORY_IMPORT':
        if (activeImporterRef.current) {
          activeImporterRef.current.cancelImport();
          activeImporterRef.current = null;
        }
        sendResponse({ success: true });
        return true;

      case 'PROCESS_IMPORTED_MESSAGES':
        (async () => {
          try {
            const { platform, messages, source } = message;

            if (!messages || !Array.isArray(messages) || messages.length === 0) {
              sendResponse({ success: false, error: 'No messages to process' });
              return;
            }

            console.log(`📥 Processing ${messages.length} imported messages from ${platform} (${source})`);

            const config = await getApiConfig();
            const importer = new HistoryImporter(config.supabaseUrl, config.supabaseKey, config.userId);

            let savedCount = 0;
            let skippedCount = 0;
            const batchSize = 50;

            for (let i = 0; i < messages.length; i += batchSize) {
              const batch = messages.slice(i, i + batchSize);
              try {
                await importer.processBatch(batch);
                savedCount += batch.length;
                console.log(`   Batch ${Math.floor(i / batchSize) + 1}: ${batch.length} processed`);
              } catch (batchError) {
                console.error(`   Batch ${Math.floor(i / batchSize) + 1} error:`, batchError);
              }
            }

            console.log(`✅ ZIP import complete: ${savedCount} saved, ${skippedCount} skipped`);

            // Trigger post-import backfill chain
            chrome.alarms.create('backfillContextual', { delayInMinutes: 1 });
            chrome.alarms.create('postImportBackfill', { delayInMinutes: 3 });
            console.log('⏰ Post-import backfill alarms scheduled (contextual: 1min, orchestrator: 3min)');

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

      case 'BACKFILL_STATUS':
        (async () => {
          try {
            const allAlarms = await chrome.alarms.getAll();
            const backfillAlarms = allAlarms.filter(a =>
              ['backfillContextual', 'backfillEntities', 'postImportBackfill', 'backfillEmbeddings'].includes(a.name)
            );
            sendResponse({
              success: true,
              active: backfillAlarms.length > 0,
              alarms: backfillAlarms.map(a => ({
                name: a.name,
                scheduledTime: a.scheduledTime,
                periodInMinutes: a.periodInMinutes || null,
              })),
            });
          } catch (error) {
            sendResponse({ success: false, error: error.message });
          }
        })();
        return true;

      case 'GET_PROFILE':
        (async () => {
          try {
            const profileId = await getActiveProfileId();
            sendResponse({ success: true, profileId });
          } catch (error) {
            sendResponse({ success: false, error: error.message });
          }
        })();
        return true;

      case 'SET_MEMORY_MODE':
        (async () => {
          try {
            await setMemoryMode(message.mode);
            // Best-effort sync to Supabase profiles table
            // NOTE: profiles.memory_mode CHECK constraint uses different values
            // (standard/journal/research/minimal) than client modes (full/clean_room/incognito).
            // Sync onboarding_completed only until schema is aligned via migration.
            try {
              const auth = await getAuthConfig();
              if (auth.userId) {
                await fetch(`${auth.supabaseUrl}/rest/v1/profiles?id=eq.${auth.userId}`, {
                  method: 'PATCH',
                  headers: auth.headers,
                  body: JSON.stringify({ onboarding_completed: true }),
                });
              }
            } catch (syncErr) {
              console.warn('Failed to sync mode to profiles:', syncErr.message);
            }
            sendResponse({ success: true, mode: message.mode });
          } catch (error) {
            sendResponse({ success: false, error: error.message });
          }
        })();
        return true;

      case 'GET_MEMORY_MODE':
        (async () => {
          try {
            const mode = await getMemoryMode();
            sendResponse({ success: true, mode });
          } catch (error) {
            sendResponse({ success: false, error: error.message });
          }
        })();
        return true;

      // ===== GDPR: Data Export =====
      case 'EXPORT_MY_DATA':
        (async () => {
          try {
            const auth = await getAuthConfig();
            if (!auth.userId) {
              sendResponse({ success: false, error: 'Not authenticated' });
              return;
            }

            const tables = ['chat_turns', 'entities', 'entity_mentions', 'user_preferences', 'conversations', 'messages', 'user_history_imports'];
            const exported = {};

            for (const table of tables) {
              const url = `${auth.supabaseUrl}/rest/v1/${table}?user_id=eq.${auth.userId}&select=*`;
              const resp = await fetch(url, { headers: auth.headers });
              if (resp.ok) {
                exported[table] = await resp.json();
              } else {
                exported[table] = [];
                console.warn(`Export: failed to fetch ${table}:`, resp.status);
              }
            }

            // Also export local storage messages
            const local = await chrome.storage.local.get(['captured_messages']);
            exported.local_messages = local.captured_messages || [];

            sendResponse({ success: true, data: exported });
          } catch (error) {
            console.error('EXPORT_MY_DATA failed:', error);
            sendResponse({ success: false, error: error.message });
          }
        })();
        return true;

      // ===== GDPR: Delete All User Data =====
      case 'DELETE_ALL_MY_DATA':
        (async () => {
          try {
            const auth = await getAuthConfig();
            if (!auth.userId) {
              sendResponse({ success: false, error: 'Not authenticated' });
              return;
            }

            const deleted = {};
            // Order matters: delete children before parents (FK constraints)
            // Full table list for GDPR Article 17 compliance
            const tables = [
              'entity_mentions',
              'user_preferences',
              'chat_turns',
              'entities',
              'messages',
              'user_history_imports',
              'conversations',
            ];

            for (const table of tables) {
              const url = `${auth.supabaseUrl}/rest/v1/${table}?user_id=eq.${auth.userId}`;
              const resp = await fetch(url, {
                method: 'DELETE',
                headers: auth.headers,
              });
              if (resp.ok) {
                const rows = await resp.json();
                deleted[table] = Array.isArray(rows) ? rows.length : 0;
              } else {
                // Table may not exist or have no user_id column — not fatal
                deleted[table] = 0;
                console.warn(`Delete: failed on ${table}:`, resp.status);
              }
            }

            // Clear user-associated local storage (preserve auth_session so
            // user stays logged in to verify deletion; preserve api_config
            // so they can re-configure if needed)
            await chrome.storage.local.remove([
              'captured_messages',
              'last_sync_status',
              'kyt_stats',
              'kyt_injection_stats',
              'user_tier',
              'kyt_active_profile_id',
            ]);
            deleted.local_storage = 'cleared';

            console.log('DELETE_ALL_MY_DATA result:', deleted);
            sendResponse({ success: true, deleted });
          } catch (error) {
            console.error('DELETE_ALL_MY_DATA failed:', error);
            sendResponse({ success: false, error: error.message });
          }
        })();
        return true;

      // ===== Memory Management: Get Conversations =====
      case 'GET_CONVERSATIONS':
        (async () => {
          try {
            const auth = await getAuthConfig();
            if (!auth.userId) {
              sendResponse({ success: false, error: 'Not authenticated' });
              return;
            }

            const offset = message.offset || 0;
            const limit = message.limit || 50;
            const url = `${auth.supabaseUrl}/rest/v1/conversations?user_id=eq.${auth.userId}&select=*&order=last_message_at.desc.nullslast&offset=${offset}&limit=${limit}`;

            const resp = await fetch(url, {
              headers: { ...auth.headers, 'Prefer': 'count=exact' },
            });

            if (!resp.ok) {
              throw new Error(`Failed to fetch conversations: ${resp.status}`);
            }

            const conversations = await resp.json();
            const totalHeader = resp.headers.get('content-range');
            let total = conversations.length;
            if (totalHeader) {
              const match = totalHeader.match(/\/(\d+)/);
              if (match) total = parseInt(match[1], 10);
            }

            sendResponse({ success: true, conversations, total });
          } catch (error) {
            console.error('GET_CONVERSATIONS failed:', error);
            sendResponse({ success: false, error: error.message });
          }
        })();
        return true;

      // ===== Memory Management: Delete Single Conversation =====
      case 'DELETE_CONVERSATION':
        (async () => {
          try {
            const auth = await getAuthConfig();
            if (!auth.userId || !message.conversationId) {
              sendResponse({ success: false, error: 'Missing userId or conversationId' });
              return;
            }

            const convId = encodeURIComponent(message.conversationId);
            const deleted = {};

            // Delete entity_mentions for chat_turns in this conversation
            // (no direct conversation_id FK, so delete via chat_turn_ids)
            const turnsUrl = `${auth.supabaseUrl}/rest/v1/chat_turns?conversation_id=eq.${convId}&user_id=eq.${auth.userId}&select=id`;
            const turnsResp = await fetch(turnsUrl, { headers: auth.headers });
            if (turnsResp.ok) {
              const turns = await turnsResp.json();
              const turnIds = turns.map(t => t.id);
              if (turnIds.length > 0) {
                // Delete mentions for these turns in batches
                const mentionsUrl = `${auth.supabaseUrl}/rest/v1/entity_mentions?chat_turn_id=in.(${turnIds.join(',')})&user_id=eq.${auth.userId}`;
                const mResp = await fetch(mentionsUrl, { method: 'DELETE', headers: auth.headers });
                deleted.entity_mentions = mResp.ok ? (await mResp.json()).length : 0;
              }
            }

            // Delete chat_turns
            const ctUrl = `${auth.supabaseUrl}/rest/v1/chat_turns?conversation_id=eq.${convId}&user_id=eq.${auth.userId}`;
            const ctResp = await fetch(ctUrl, { method: 'DELETE', headers: auth.headers });
            deleted.chat_turns = ctResp.ok ? (await ctResp.json()).length : 0;

            // Delete the conversation row
            const cUrl = `${auth.supabaseUrl}/rest/v1/conversations?external_id=eq.${convId}&user_id=eq.${auth.userId}`;
            const cResp = await fetch(cUrl, { method: 'DELETE', headers: auth.headers });
            deleted.conversations = cResp.ok ? (await cResp.json()).length : 0;

            sendResponse({ success: true, deleted });
          } catch (error) {
            console.error('DELETE_CONVERSATION failed:', error);
            sendResponse({ success: false, error: error.message });
          }
        })();
        return true;

      // ===== Memory Management: Toggle Exclude from Search =====
      case 'TOGGLE_EXCLUDE_CONVERSATION':
        (async () => {
          try {
            const auth = await getAuthConfig();
            if (!auth.userId || !message.conversationId) {
              sendResponse({ success: false, error: 'Missing userId or conversationId' });
              return;
            }

            const convId = encodeURIComponent(message.conversationId);
            const exclude = !!message.exclude;

            // Update chat_turns
            const ctUrl = `${auth.supabaseUrl}/rest/v1/chat_turns?conversation_id=eq.${convId}&user_id=eq.${auth.userId}`;
            const ctResp = await fetch(ctUrl, {
              method: 'PATCH',
              headers: auth.headers,
              body: JSON.stringify({ exclude_from_search: exclude }),
            });

            // Update conversations table
            const cUrl = `${auth.supabaseUrl}/rest/v1/conversations?external_id=eq.${convId}&user_id=eq.${auth.userId}`;
            await fetch(cUrl, {
              method: 'PATCH',
              headers: auth.headers,
              body: JSON.stringify({ exclude_from_search: exclude }),
            });

            const updated = ctResp.ok ? (await ctResp.json()).length : 0;
            sendResponse({ success: true, updated, exclude });
          } catch (error) {
            console.error('TOGGLE_EXCLUDE_CONVERSATION failed:', error);
            sendResponse({ success: false, error: error.message });
          }
        })();
        return true;

      default:
        console.warn('Unknown message type:', message.type);
        sendResponse({ success: false, error: 'Unknown message type' });
        return true;
    }
  });
}
