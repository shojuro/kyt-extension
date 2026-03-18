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
import { checkTurnLimit, incrementTurnCount, getTurnUsage } from './turn-limiter.js';
import { startPostCheckoutPoll } from './tier-sync.js';
import { getActiveProfileId } from './profile-manager.js';
import { getActiveProject, setActiveProject, clearActiveProject } from './project-manager.js';
import { getSyncStatus as getNLMSyncStatus, enableSync as enableNLMSync, disableSync as disableNLMSync, checkGoogleSignIn as checkNLMSignIn } from './notebooklm-sync.js';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './supabase-config.js';
import { AUTH_SESSION_KEY } from './auth/auth-service.js';
import { withStorageMutex } from './utils/storage-mutex.js';

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

  let haiku;
  try {
    haiku = await classifyWithHaiku(message, classification.scores, classification.reason);
  } catch (err) {
    console.warn('⚠️ Haiku tiebreaker failed:', err.message);
    return classification;
  }

  if (!haiku || typeof haiku.classification !== 'string') {
    console.warn('⚠️ Haiku returned invalid result — falling back to v2');
    return classification;
  }

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
  await withStorageMutex(INJECTION_STATS_KEY, (stats) => {
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
      stats.recentResults = stats.recentResults || [];
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

    return stats;
  }, {
    totalAttempts: 0, successful: 0, empty: 0, timeouts: 0, errors: 0,
    totalItemsReturned: 0, totalLatencyMs: 0, lastAttempt: null, lastSuccess: null, recentResults: []
  });
}

/**
 * Standalone async handler for GET_CONTEXT messages.
 * Called from a DEDICATED onMessage listener that returns this Promise directly,
 * so Chrome MV3 properly tracks the async lifecycle and keeps the SW alive.
 *
 * @param {Object} message - The GET_CONTEXT message
 * @param {Function} getContextForInjection - The context retrieval function
 * @returns {Promise<Object>} The context response (Chrome sends resolved value to caller)
 */
async function handleGetContextAsync(message, getContextForInjection) {
  const injectionStart = performance.now();
  const diag = { steps: [], startMs: Date.now(), query: '' };
  async function diagSave() {
    try { await chrome.storage.local.set({ kyt_context_diag: diag }); } catch (_) {}
  }
  try {
    if (!message.userMessage || typeof message.userMessage !== 'string') {
      return { success: false, error: 'Missing userMessage' };
    }
    diag.query = message.userMessage.substring(0, 80);
    diag.steps.push('start');

    const memMode = await getMemoryMode();
    diag.steps.push('memMode:' + memMode);
    if (memMode !== 'full') {
      return { success: true, items: [], formattedContext: null, modeBlocked: true, mode: memMode };
    }

    // Turn limit: capture always proceeds, but retrieval pauses when limit hit
    const turnCheck = await checkTurnLimit();
    diag.steps.push('turns:' + turnCheck.used + '/' + turnCheck.limit);
    if (!turnCheck.allowed) {
      diag.steps.push('turn_limit_reached');
      await diagSave();
      // Notify active tab to show upgrade banner
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]?.id) {
          chrome.tabs.sendMessage(tabs[0].id, {
            type: 'KYT_TURN_LIMIT_REACHED',
            used: turnCheck.used,
            limit: turnCheck.limit,
            tier: turnCheck.tier
          }).catch(() => {});
        }
      });
      return { success: true, items: [], formattedContext: null, turnLimitReached: true, used: turnCheck.used, limit: turnCheck.limit, tier: turnCheck.tier };
    }

    let classification = classifyIntent(message.userMessage);
    diag.steps.push('intent:' + classification.intent + ':' + classification.reason);

    if (classification.intent === 'SKIP') {
      diag.steps.push('SKIP');
      await diagSave();
      return { success: true, items: [], formattedContext: null, intentSkipped: true, skipReason: classification.reason };
    }

    if (classification.intent === 'PASSIVE') {
      diag.steps.push('layer2_start');
      classification = await escalateToLayer2(message.userMessage, classification);
      diag.steps.push('layer2:' + classification.intent);
      if (classification.intent === 'SKIP') {
        await diagSave();
        return { success: true, items: [], formattedContext: null, intentSkipped: true, skipReason: classification.reason };
      }
    }

    updateInjectionStats({ attempt: true }).catch(() => {});

    const result = await chrome.storage.local.get(['kytDebugMode']);
    const config = {
      ...message.config,
      debugMode: result.kytDebugMode || false
    };
    if (classification.confidenceThreshold) {
      config.confidenceThreshold = classification.confidenceThreshold;
    }

    // Pass conversation window context for implicit query resolution
    if (message.conversationWindow && Array.isArray(message.conversationWindow)) {
      config.conversationWindow = message.conversationWindow;
    }

    diag.steps.push('pipeline_start');
    await diagSave();
    const contextData = await Promise.race([
      getContextForInjection(message.userMessage, config),
      new Promise((_, reject) => setTimeout(() => {
        reject(new Error('getContextForInjection timed out after 25000ms'));
      }, 25000))
    ]);

    const latencyMs = Math.round(performance.now() - injectionStart);
    const itemCount = contextData.items?.length || 0;
    diag.steps.push('done:' + itemCount + 'items:' + latencyMs + 'ms');
    diag.hasContext = !!(contextData.formattedContext);
    diag.diagnostics = contextData.diagnostics || null;
    diag.endMs = Date.now();
    await diagSave();

    if (itemCount > 0) {
      updateInjectionStats({ success: true, itemCount, latencyMs, result: true }).catch(() => {});
    } else {
      updateInjectionStats({ empty: true, latencyMs, result: true }).catch(() => {});
    }

    // Sanitize for Chrome message serialization
    return {
      success: contextData.success !== false,
      items: (contextData.items || []).map(item => ({
        id: item.id,
        content: typeof item.content === 'string' ? item.content : String(item.content || ''),
        platform: item.platform || 'unknown',
        timestamp: item.timestamp || null,
        similarity: typeof item.similarity === 'number' ? item.similarity : 0,
        source_type: item.source_type || null,
      })),
      formattedContext: contextData.formattedContext || null,
      elapsedMs: latencyMs,
    };
  } catch (error) {
    const latencyMs = Math.round(performance.now() - injectionStart);
    const isTimeout = error.message?.includes('timed out');
    diag.steps.push('ERROR:' + (error.message || String(error)));
    diag.endMs = Date.now();
    await diagSave();
    updateInjectionStats({
      error: !isTimeout, timeout: isTimeout, latencyMs, result: true, errorMsg: error.message
    }).catch(() => {});
    return { success: false, error: error.message };
  }
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

    // Track port lifecycle so we don't postMessage to a dead port
    let portAlive = true;
    port.onDisconnect.addListener(() => {
      portAlive = false;
      const err = chrome.runtime.lastError?.message || 'unknown';
      console.warn('🔌 KYT Background: Context port disconnected:', err);
    });

    function safePostMessage(data) {
      if (!portAlive) {
        console.warn('🔌 KYT Background: Skipping postMessage — port already disconnected');
        return;
      }
      try {
        port.postMessage(data);
      } catch (e) {
        console.warn('🔌 KYT Background: postMessage failed:', e.message);
      }
    }

    port.onMessage.addListener(async (msg) => {
      console.log('🔍 KYT Background: Context request (port) for:', (msg.userMessage || '').substring(0, 50) + '...');
      // Reuse handleGetContextAsync — same pipeline, same diagnostics, same diag storage
      const result = await handleGetContextAsync(msg, getContextForInjection);
      safePostMessage({ requestId: msg.requestId, ...result });
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

  // Throttle noisy SAVE_MESSAGE logs — only log every Nth
  let saveMessageCount = 0;
  const SAVE_MSG_LOG_INTERVAL = 50;

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'SAVE_MESSAGE') {
      saveMessageCount++;
      if (saveMessageCount % SAVE_MSG_LOG_INTERVAL === 1) {
        console.log(`📨 KYT Background: SAVE_MESSAGE #${saveMessageCount} (logging every ${SAVE_MSG_LOG_INTERVAL})`);
      }
    } else {
      console.log('📨 KYT Background: Received message:', message.type);
    }

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
              await incrementTurnCount();
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

      case 'GET_CONTEXT': {
        // Storage-based async: Chrome MV3 kills async continuations in onMessage
        // handlers, so we can't use sendResponse or returned Promises for long ops.
        // Instead: acknowledge immediately, run pipeline, write result to storage.
        // The bridge picks up the result via chrome.storage.onChanged.
        const ctxRequestId = message.requestId;
        const ctxStorageKey = 'kyt_ctx_' + ctxRequestId;
        // Fire-and-forget: pipeline runs independently of message channel
        handleGetContextAsync(message, getContextForInjection)
          .then(result => chrome.storage.local.set({ [ctxStorageKey]: { ...result, timestamp: Date.now() } }))
          .catch(err => {
            console.error('❌ Context pipeline failed:', err.message);
            chrome.storage.local.set({
              [ctxStorageKey]: { success: false, error: err.message, timestamp: Date.now() }
            }).catch(writeErr =>
              console.error('❌ Failed to write error to storage:', writeErr.message)
            );
          });
        // Immediate sync response — channel closes, pipeline continues via storage
        sendResponse({ acknowledged: true, requestId: ctxRequestId });
        return false;
      }

      case 'EXTRACTION_ERROR':
        console.error('⚠️ Content script extraction error:', message.error);
        withStorageMutex('error_log', (errors) => {
          errors.push({
            type: 'EXTRACTION_ERROR',
            message: message.error,
            timestamp: message.timestamp
          });
          if (errors.length > 100) errors.splice(0, errors.length - 100);
          return errors;
        }, []);
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
        withStorageMutex('kyt_stats', (stats) => {
          stats.observerStatus = message.status;
          stats.observerRestarts = message.restartAttempts;
          stats.lastObserverUpdate = Date.now();
          return stats;
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
        }).catch(err => {
          console.error('❌ Failed to read injection stats:', err.message);
          sendResponse({ totalAttempts: 0, successful: 0, empty: 0, timeouts: 0, errors: 0,
            totalItemsReturned: 0, totalLatencyMs: 0, recentResults: [], error: err.message });
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
              sendResponse({ success: false, error: 'Import already in progress' });
              return;
            }

            activeImporterRef.current = new HistoryImporter(config.supabaseUrl, config.supabaseKey, config.userId);

            let fallbackTriggered = false;

            activeImporterRef.current.startImport(
              message.platform,
              (progress) => {
                chrome.runtime.sendMessage({
                  type: 'IMPORT_PROGRESS',
                  progress
                }).catch(() => {});
              },
              async () => {
                // Notify modal to show ZIP upload UI
                fallbackTriggered = true;
                chrome.runtime.sendMessage({
                  type: 'IMPORT_FALLBACK_REQUIRED',
                  platform: message.platform,
                  reason: 'API import failed. Please upload a ZIP export instead.'
                }).catch(() => {});
                return null;
              }
            ).then(result => {
              sendResponse({ success: true, result });
              activeImporterRef.current = null;
              // Trigger post-import backfill chain
              chrome.alarms.create('backfillContextual', { delayInMinutes: 1 });
              chrome.alarms.create('backfillEmbeddings', { delayInMinutes: 1.5 });
              chrome.alarms.create('postImportBackfill', { delayInMinutes: 3 });
              console.log('⏰ Post-import backfill alarms scheduled (contextual: 1min, embeddings: 1.5min, orchestrator: 3min)');
            }).catch(error => {
              if (fallbackTriggered) {
                // Don't send error — modal is showing fallback ZIP upload UI
                activeImporterRef.current = null;
                return;
              }
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
            chrome.alarms.create('backfillEmbeddings', { delayInMinutes: 1.5 });
            chrome.alarms.create('postImportBackfill', { delayInMinutes: 3 });
            chrome.alarms.create('backfillGravity', { delayInMinutes: 5 });
            console.log('⏰ Post-import backfill alarms scheduled (contextual: 1min, embeddings: 1.5min, orchestrator: 3min, gravity: 5min)');

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
              ['backfillContextual', 'backfillEntities', 'postImportBackfill', 'backfillEmbeddings', 'backfillGravity'].includes(a.name)
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

      case 'GET_TURN_USAGE':
        (async () => {
          try {
            const usage = await getTurnUsage();
            sendResponse({ success: true, ...usage });
          } catch (error) {
            sendResponse({ success: false, error: error.message });
          }
        })();
        return true;

      case 'KYT_START_CHECKOUT':
        (async () => {
          try {
            const auth = await getAuthConfig();
            if (!auth.userId) {
              sendResponse({ success: false, error: 'Not authenticated' });
              return;
            }
            const tier = message.tier || 'pro';
            const interval = message.interval || 'monthly';
            const resp = await fetch(`${auth.supabaseUrl}/functions/v1/create-checkout`, {
              method: 'POST',
              headers: auth.headers,
              body: JSON.stringify({ userId: auth.userId, tier, interval }),
            });
            if (!resp.ok) {
              const err = await resp.json().catch(() => ({}));
              throw new Error(err.error || 'Checkout request failed');
            }
            const { url } = await resp.json();
            chrome.tabs.create({ url });
            startPostCheckoutPoll();
            sendResponse({ success: true });
          } catch (error) {
            console.error('Checkout error:', error);
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

      case 'SET_ACTIVE_PROJECT':
        (async () => {
          try {
            if (message.data?.id) {
              // Vault PIN gate: verify PIN before activating vault projects
              if (message.data.isVault) {
                if (!message.data.pin) {
                  sendResponse({ success: false, error: 'This is a vault project. Provide the PIN to unlock it.' });
                  return;
                }
                const session = (await chrome.storage.local.get(['auth_session'])).auth_session;
                if (!session?.access_token) {
                  sendResponse({ success: false, error: 'Not authenticated' });
                  return;
                }
                const verifyRes = await fetch(
                  `${SUPABASE_URL}/rest/v1/rpc/verify_vault_pin`,
                  {
                    method: 'POST',
                    headers: {
                      'Content-Type': 'application/json',
                      'Authorization': `Bearer ${session.access_token}`,
                      'apikey': SUPABASE_ANON_KEY,
                    },
                    body: JSON.stringify({
                      p_project_id: message.data.id,
                      p_user_id: session.user.id,
                      p_pin: message.data.pin,
                    }),
                  }
                );
                if (!verifyRes.ok) {
                  const errBody = await verifyRes.json().catch(() => ({}));
                  sendResponse({ success: false, error: errBody.message || 'PIN verification failed' });
                  return;
                }
                const verified = await verifyRes.json();
                if (!verified) {
                  sendResponse({ success: false, error: 'Incorrect vault PIN.' });
                  return;
                }
              }
              await setActiveProject(message.data.id, message.data.name, message.data.isVault);
            } else {
              await clearActiveProject();
            }
            sendResponse({ success: true });
          } catch (e) {
            sendResponse({ success: false, error: e.message });
          }
        })();
        return true;

      case 'GET_ACTIVE_PROJECT':
        (async () => {
          try {
            const project = await getActiveProject();
            sendResponse({ success: true, project });
          } catch (e) {
            sendResponse({ success: false, error: e.message });
          }
        })();
        return true;

      case 'CREATE_PROJECT':
        (async () => {
          try {
            const session = (await chrome.storage.local.get(['auth_session'])).auth_session;
            if (!session?.access_token) {
              sendResponse({ success: false, error: 'Not authenticated' });
              return;
            }
            const res = await fetch(
              `${SUPABASE_URL}/rest/v1/rpc/create_project_rpc`,
              {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${session.access_token}`,
                  'apikey': SUPABASE_ANON_KEY,
                },
                body: JSON.stringify({
                  p_user_id: session.user.id,
                  p_name: message.data.name,
                  p_description: message.data.description || null,
                  p_is_vault: message.data.isVault || false,
                  p_pin: message.data.pin || null,
                }),
              }
            );
            if (!res.ok) {
              const errBody = await res.json().catch(() => ({}));
              throw new Error(errBody.message || `HTTP ${res.status}`);
            }
            const data = await res.json();
            const project = Array.isArray(data) ? data[0] : data;
            sendResponse({ success: true, project });
          } catch (e) {
            sendResponse({ success: false, error: e.message });
          }
        })();
        return true;

      case 'NOTEBOOKLM_STATUS':
        (async () => {
          try {
            const status = await getNLMSyncStatus();
            sendResponse(status);
          } catch (e) {
            sendResponse({ enabled: false, error: e.message });
          }
        })();
        return true;

      case 'NOTEBOOKLM_ENABLE':
        (async () => {
          try {
            const { signedIn } = await checkNLMSignIn();
            if (!signedIn) {
              sendResponse({ error: 'Sign into Google first' });
              return;
            }
            await enableNLMSync();
            sendResponse({ success: true });
          } catch (e) {
            sendResponse({ error: e.message });
          }
        })();
        return true;

      case 'NOTEBOOKLM_DISABLE':
        (async () => {
          try {
            await disableNLMSync();
            sendResponse({ success: true });
          } catch (e) {
            sendResponse({ error: e.message });
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
