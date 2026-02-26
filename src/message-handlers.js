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
import { classifyIntent, PASSIVE_CONFIDENCE_THRESHOLD } from './intent-classifier.js';
import { getMemoryMode, setMemoryMode } from './memory-mode.js';
import { getActiveProfileId } from './profile-manager.js';

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
        const classification = classifyIntent(msg.userMessage);
        console.log(`🎯 Intent: ${classification.intent} (${classification.reason}) for: "${msg.userMessage.substring(0, 80)}${msg.userMessage.length > 80 ? '...' : ''}"`);

        if (classification.intent === 'SKIP') {
          console.log(`⏭️ Skipping injection: ${classification.reason}`);
          port.postMessage({ requestId: msg.requestId, success: true, items: [], formattedContext: null, intentSkipped: true, skipReason: classification.reason });
          return;
        }

        updateInjectionStats({ attempt: true }).catch(() => {});

        const result = await chrome.storage.local.get(['kytDebugMode']);
        const config = { ...msg.config, debugMode: result.kytDebugMode || false };

        // PASSIVE intent: raise confidence threshold to filter low-quality matches
        if (classification.intent === 'PASSIVE') {
          config.confidenceThreshold = PASSIVE_CONFIDENCE_THRESHOLD;
          console.log(`📊 Passive query — confidence threshold raised to ${PASSIVE_CONFIDENCE_THRESHOLD}`);
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
            const classification = classifyIntent(message.userMessage);
            console.log(`🎯 Intent: ${classification.intent} (${classification.reason}) for: "${message.userMessage.substring(0, 80)}${message.userMessage.length > 80 ? '...' : ''}"`);

            if (classification.intent === 'SKIP') {
              console.log(`⏭️ Skipping injection: ${classification.reason}`);
              sendResponse({ success: true, items: [], formattedContext: null, intentSkipped: true, skipReason: classification.reason });
              return;
            }

            updateInjectionStats({ attempt: true }).catch(() => {});

            const result = await chrome.storage.local.get(['kytDebugMode']);
            const config = {
              ...message.config,
              debugMode: result.kytDebugMode || false
            };

            // PASSIVE intent: raise confidence threshold to filter low-quality matches
            if (classification.intent === 'PASSIVE') {
              config.confidenceThreshold = PASSIVE_CONFIDENCE_THRESHOLD;
              console.log(`📊 Passive query — confidence threshold raised to ${PASSIVE_CONFIDENCE_THRESHOLD}`);
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

      default:
        console.warn('Unknown message type:', message.type);
        sendResponse({ success: false, error: 'Unknown message type' });
        return true;
    }
  });
}
