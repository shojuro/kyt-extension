/**
 * KYT Memory Extension - Claude Bridge Script
 *
 * Runs in ISOLATED world (traditional content script)
 * Listens for CustomEvents from MAIN world and forwards to background
 *
 * Architecture:
 * MAIN world (content_test.js) → CustomEvent → ISOLATED world (this file) → chrome.runtime → background.js
 *
 * NOTE: This file MUST remain a classic (non-module) script so that
 * chrome.scripting.executeScript() can re-inject it after extension reload.
 * ES module imports cause a SyntaxError in classic-script mode.
 * The 3-tier capture fallback from queue-manager.js is inlined below.
 */

// Generation guard: only the latest injected bridge responds to events.
// On extension reload, a new bridge is injected via chrome.scripting.executeScript().
// The new bridge overwrites window.__kytBridgeGeneration, silencing old bridge handlers.
var BRIDGE_GENERATION = Date.now();
window.__kytBridgeGeneration = BRIDGE_GENERATION;

console.log('🔵 BRIDGE: Content bridge loaded in ISOLATED world at:', new Date().toISOString());
console.log('🔵 BRIDGE: chrome.runtime available:', typeof chrome?.runtime !== 'undefined');
console.log('🔵 BRIDGE: Generation:', BRIDGE_GENERATION);

// ===== INLINED 3-TIER CAPTURE FALLBACK =====
// Replaces the ES module import of queue-manager.js.
// Tier 1: chrome.runtime.sendMessage (service worker alive)
// Tier 2: chrome.storage.local with key kyt_pending_unencrypted_queue (context partially valid)
// Tier 3: window.localStorage with key kyt_emergency_localStorage_queue (context fully invalid)

var UNENCRYPTED_QUEUE_KEY = 'kyt_pending_unencrypted_queue';
var LOCALSTORAGE_EMERGENCY_KEY = 'kyt_emergency_localStorage_queue';
var LOCALSTORAGE_MAX_SIZE = 50;

// ===== SERVICE WORKER DISCONNECTION TRACKING =====
// When the SW dies mid-request, Tier 1 (sendMessage) fails. Rather than permanently
// disabling Tier 1, we use an escalating cooldown. The SW restarts via chrome.alarms
// or the next sendMessage attempt, so we should retry after a short delay.
// Extension update re-injects the bridge script entirely, starting fresh.

var swDisconnectedUntil = 0;   // Timestamp when cooldown expires (0 = not cooling down)
var swDisconnectCount = 0;     // Consecutive failures — drives escalation

// Cooldown: 5s → 15s → 30s → 60s (capped)
var SW_COOLDOWN_STEPS = [5000, 15000, 30000, 60000];

function markDisconnected(errorMsg) {
  const cooldownMs = SW_COOLDOWN_STEPS[Math.min(swDisconnectCount, SW_COOLDOWN_STEPS.length - 1)];
  swDisconnectedUntil = Date.now() + cooldownMs;
  swDisconnectCount++;
  console.warn(`🔴 BRIDGE: SW disconnected — cooldown ${cooldownMs / 1000}s (attempt ${swDisconnectCount}). Trigger:`, errorMsg);
}

function isSwCoolingDown() {
  return Date.now() < swDisconnectedUntil;
}

function resetDisconnectState() {
  if (swDisconnectCount > 0) {
    console.log('🟢 BRIDGE: SW reconnected — resetting disconnect state');
  }
  swDisconnectedUntil = 0;
  swDisconnectCount = 0;
}

function isDisconnectionError(msg) {
  return typeof msg === 'string' && (
    msg.includes('message channel closed') ||
    msg.includes('Extension context invalidated') ||
    msg.includes('Receiving end does not exist') ||
    msg.includes('message port closed')
  );
}

/**
 * Capture a message using 3-tier fallback.
 * @param {Object} messageData - Raw message data from MAIN world event
 */
async function captureMessage(messageData) {
  const msgId = messageData.messageId || messageData.originalId || `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  const queuedMessage = {
    id: msgId,
    messageId: msgId,
    timestamp: messageData.timestamp || Date.now(),
    platform: messageData.platform || 'claude',
    content: messageData.content,
    role: messageData.role,
    conversationId: messageData.conversationId,
    model: messageData.model,
    source: messageData.source || messageData.captureMethod,
    retryCount: 0
  };

  // Tier 1: sendMessage to background (context valid, service worker alive, not cooling down)
  if (chrome.runtime?.id && !isSwCoolingDown()) {
    try {
      await chrome.runtime.sendMessage({ type: 'SAVE_MESSAGE', data: queuedMessage });
      resetDisconnectState();
      console.log(`✅ BRIDGE: Message ${msgId} sent to background (Tier 1)`);
      return;
    } catch (e) {
      console.warn(`⚠️ BRIDGE: Tier 1 sendMessage failed: ${e.message}`);
      if (isDisconnectionError(e.message)) {
        markDisconnected(e.message);
      }
      // Fall through to Tier 2
    }
  }

  // Tier 2: chrome.storage.local unencrypted queue (context partially valid)
  // Guard: when chrome.runtime.id is gone, chrome.storage exists as an object
  // but operations throw. Only attempt if extension context is still valid.
  if (chrome.runtime?.id) {
    try {
      const result = await chrome.storage.local.get([UNENCRYPTED_QUEUE_KEY]);
      const queue = result[UNENCRYPTED_QUEUE_KEY] || [];
      queue.push({ ...queuedMessage, emergencyBackup: true });
      await chrome.storage.local.set({ [UNENCRYPTED_QUEUE_KEY]: queue });
      console.log(`💾 BRIDGE: Message ${msgId} saved to chrome.storage (Tier 2)`);
      return;
    } catch (e) {
      console.warn(`⚠️ BRIDGE: Tier 2 chrome.storage failed: ${e.message}`);
      // Fall through to Tier 3
    }
  }

  // Tier 3: window.localStorage emergency queue (context fully invalid)
  try {
    const stored = window.localStorage.getItem(LOCALSTORAGE_EMERGENCY_KEY);
    const queue = stored ? JSON.parse(stored) : [];
    // Prevent overflow
    while (queue.length >= LOCALSTORAGE_MAX_SIZE) {
      queue.shift();
    }
    queue.push({ ...queuedMessage, emergencyStorage: true, storedAt: Date.now() });
    window.localStorage.setItem(LOCALSTORAGE_EMERGENCY_KEY, JSON.stringify(queue));
    console.log(`🆘 BRIDGE: Message ${msgId} saved to localStorage (Tier 3)`);
  } catch (e) {
    console.error('❌ BRIDGE: All 3 capture tiers failed:', e);
  }
}

// ===== LOCALSTORAGE RECOVERY ON STARTUP =====
// Drain kyt_emergency_localStorage_queue via sendMessage to background.
// The service worker has no window.localStorage access, so recovery must happen here.
(async function recoverLocalStorageQueue() {
  if (!chrome.runtime?.id) return;

  try {
    const stored = window.localStorage.getItem(LOCALSTORAGE_EMERGENCY_KEY);
    if (!stored) return;

    const queue = JSON.parse(stored);
    if (!Array.isArray(queue) || queue.length === 0) return;

    console.log(`🔄 BRIDGE: Recovering ${queue.length} messages from emergency localStorage`);

    // Clear immediately to prevent double-recovery
    window.localStorage.removeItem(LOCALSTORAGE_EMERGENCY_KEY);

    // Await all sends — no 2s gap where queue is empty
    const results = await Promise.allSettled(
      queue.map(msg =>
        chrome.runtime.sendMessage({ type: 'SAVE_MESSAGE', data: msg })
      )
    );

    // Generation check: if a newer bridge was injected while we awaited,
    // don't re-write failures — the new bridge owns recovery now
    if (window.__kytBridgeGeneration !== BRIDGE_GENERATION) {
      console.log('🔵 BRIDGE: Stale generation after recovery — skipping failure re-queue');
      return;
    }

    // Collect and re-store failures immediately (no setTimeout gap)
    const failures = [];
    results.forEach((result, i) => {
      if (result.status === 'rejected') {
        console.warn(`⚠️ BRIDGE: Failed to recover message ${queue[i].id}:`, result.reason?.message);
        failures.push(queue[i]);
      }
    });

    if (failures.length > 0) {
      try {
        window.localStorage.setItem(LOCALSTORAGE_EMERGENCY_KEY, JSON.stringify(failures));
        console.warn(`⚠️ BRIDGE: ${failures.length} messages re-queued to localStorage`);
      } catch (e) {
        // Give up
      }
    }
  } catch (e) {
    console.warn('⚠️ BRIDGE: localStorage recovery failed:', e.message);
  }
})();

// ===== EVENT LISTENERS =====

// Listen for messages from MAIN world via CustomEvent
window.addEventListener('KYT_MESSAGE_CAPTURED', async (event) => {
  if (window.__kytBridgeGeneration !== BRIDGE_GENERATION) return; // stale bridge

  const messageData = event.detail;
  if (!messageData) {
    console.error('🔵 BRIDGE: Event has no detail data');
    return;
  }

  console.log('🔵 BRIDGE: Received KYT_MESSAGE_CAPTURED event');
  await captureMessage(messageData);
});

// Listen for context requests from MAIN world
window.addEventListener('KYT_CONTEXT_REQUEST', async (event) => {
  if (window.__kytBridgeGeneration !== BRIDGE_GENERATION) return; // stale bridge

  const { requestId, userMessage, config } = event.detail;
  console.log('🔍 BRIDGE: Context request from MAIN world');

  // Fast-fail when extension context is truly invalidated (unloaded).
  // For SW cooldown, we still fast-fail but with a different message —
  // the cooldown will expire and the next request will retry Tier 1.
  if (!chrome.runtime?.id) {
    // Extension was reloaded — wait briefly for re-injection to complete
    console.warn('⚠️ BRIDGE: Extension context invalidated — waiting for re-injection...');
    await new Promise(r => setTimeout(r, 2000));
    if (!chrome.runtime?.id) {
      console.warn('⚠️ BRIDGE: Still invalidated after 2s - fast-failing context request');
      window.dispatchEvent(new CustomEvent('KYT_CONTEXT_RESPONSE', {
        detail: {
          requestId: requestId,
          success: false,
          formattedContext: null,
          items: [],
          elapsedMs: 0,
          error: 'Extension context invalidated'
        }
      }));
      return;
    }
    console.log('✅ BRIDGE: Context restored after re-injection');
  }

  if (isSwCoolingDown()) {
    const remainingSec = Math.ceil((swDisconnectedUntil - Date.now()) / 1000);
    console.warn(`⚠️ BRIDGE: SW cooling down (${remainingSec}s remaining) - fast-failing context request`);
    window.dispatchEvent(new CustomEvent('KYT_CONTEXT_RESPONSE', {
      detail: {
        requestId: requestId,
        success: false,
        formattedContext: null,
        items: [],
        elapsedMs: 0,
        error: `Service worker cooling down (${remainingSec}s remaining)`
      }
    }));
    return;
  }

  // Port-based GET_CONTEXT: no "return true" on background side → no
  // "message channel closed" error in chrome://extensions on SW death.
  try {
    const port = chrome.runtime.connect({ name: 'kyt-context' });
    let responded = false;

    // Slightly longer than background's 25s internal timeout
    const timeoutId = setTimeout(() => {
      if (responded) return;
      responded = true;
      try { port.disconnect(); } catch (_) {}
      console.warn('⚠️ BRIDGE: Context request timed out (26s)');
      window.dispatchEvent(new CustomEvent('KYT_CONTEXT_RESPONSE', {
        detail: {
          requestId: requestId,
          success: false,
          formattedContext: null,
          items: [],
          elapsedMs: 0,
          error: 'Context request timed out'
        }
      }));
    }, 26000);

    port.onMessage.addListener((response) => {
      if (responded) return;
      responded = true;
      clearTimeout(timeoutId);
      resetDisconnectState();
      try { port.disconnect(); } catch (_) {}

      window.dispatchEvent(new CustomEvent('KYT_CONTEXT_RESPONSE', {
        detail: {
          requestId: requestId,
          success: response.success,
          formattedContext: response.formattedContext,
          items: response.items,
          elapsedMs: response.elapsedMs,
          error: response.error
        }
      }));
      console.log('✅ BRIDGE: Context response sent to MAIN world (port)');
    });

    port.onDisconnect.addListener(() => {
      if (responded) return;
      responded = true;
      clearTimeout(timeoutId);
      const err = chrome.runtime.lastError?.message || 'Port disconnected';
      if (isDisconnectionError(err) || err === 'Port disconnected') {
        markDisconnected(err);
      }
      console.warn('⚠️ BRIDGE: Context port disconnected:', err);
      window.dispatchEvent(new CustomEvent('KYT_CONTEXT_RESPONSE', {
        detail: {
          requestId: requestId,
          success: false,
          formattedContext: null,
          items: [],
          elapsedMs: 0,
          error: err
        }
      }));
    });

    port.postMessage({ requestId, userMessage, config });
  } catch (error) {
    // connect() itself can throw if context is invalidated
    if (isDisconnectionError(error.message)) {
      markDisconnected(error.message);
    }
    console.error('❌ BRIDGE: Failed to open context port:', error);
    window.dispatchEvent(new CustomEvent('KYT_CONTEXT_RESPONSE', {
      detail: {
        requestId: requestId,
        success: false,
        formattedContext: null,
        items: [],
        elapsedMs: 0,
        error: error.message
      }
    }));
  }
});

// Health check for bridge
window.addEventListener('KYT_BRIDGE_PING', () => {
  if (window.__kytBridgeGeneration !== BRIDGE_GENERATION) return; // stale bridge
  console.log('🔵 BRIDGE: Ping received, responding...');
  window.dispatchEvent(new CustomEvent('KYT_BRIDGE_PONG', {
    detail: {
      status: 'alive',
      hasRuntime: typeof chrome?.runtime !== 'undefined',
      timestamp: Date.now()
    }
  }));
});

console.log('🔵 BRIDGE: Listening for KYT_MESSAGE_CAPTURED and KYT_CONTEXT_REQUEST events');
