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
const BRIDGE_GENERATION = Date.now();
window.__kytBridgeGeneration = BRIDGE_GENERATION;

console.log('🔵 BRIDGE: Content bridge loaded in ISOLATED world at:', new Date().toISOString());
console.log('🔵 BRIDGE: chrome.runtime available:', typeof chrome?.runtime !== 'undefined');
console.log('🔵 BRIDGE: Generation:', BRIDGE_GENERATION);

// ===== INLINED 3-TIER CAPTURE FALLBACK =====
// Replaces the ES module import of queue-manager.js.
// Tier 1: chrome.runtime.sendMessage (service worker alive)
// Tier 2: chrome.storage.local with key kyt_pending_unencrypted_queue (context partially valid)
// Tier 3: window.localStorage with key kyt_emergency_localStorage_queue (context fully invalid)

const UNENCRYPTED_QUEUE_KEY = 'kyt_pending_unencrypted_queue';
const LOCALSTORAGE_EMERGENCY_KEY = 'kyt_emergency_localStorage_queue';
const LOCALSTORAGE_MAX_SIZE = 50;

// ===== SERVICE WORKER DISCONNECTION TRACKING =====
// Once the SW dies mid-session, Tier 1 (sendMessage) will fail on every call.
// Repeated failures trip the queue-manager circuit breaker → messages get dropped.
// By tracking disconnection, we skip Tier 1 entirely and go straight to Tier 2/3.
// Never reset to false — extension update re-injects the bridge script, starting fresh.
let swDisconnected = false;

function markDisconnected(errorMsg) {
  if (swDisconnected) return;
  swDisconnected = true;
  console.warn('🔴 BRIDGE: SW disconnected — skipping Tier 1 for future requests. Trigger:', errorMsg);
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
  const msgId = `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  const queuedMessage = {
    id: msgId,
    messageId: msgId,
    timestamp: Date.now(),
    platform: messageData.platform || 'claude',
    content: messageData.content,
    role: messageData.role,
    conversationId: messageData.conversationId,
    model: messageData.model,
    retryCount: 0
  };

  // Tier 1: sendMessage to background (context valid, service worker alive, not disconnected)
  if (chrome.runtime?.id && !swDisconnected) {
    try {
      await chrome.runtime.sendMessage({ type: 'SAVE_MESSAGE', data: queuedMessage });
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
(function recoverLocalStorageQueue() {
  if (!chrome.runtime?.id) return; // Can't recover without valid context

  try {
    const stored = window.localStorage.getItem(LOCALSTORAGE_EMERGENCY_KEY);
    if (!stored) return;

    const queue = JSON.parse(stored);
    if (!Array.isArray(queue) || queue.length === 0) return;

    console.log(`🔄 BRIDGE: Recovering ${queue.length} messages from emergency localStorage`);

    // Clear immediately to prevent double-recovery from another bridge instance
    window.localStorage.removeItem(LOCALSTORAGE_EMERGENCY_KEY);

    // Send each recovered message to background
    const failures = [];
    queue.forEach(msg => {
      chrome.runtime.sendMessage({ type: 'SAVE_MESSAGE', data: msg }).catch(err => {
        console.warn(`⚠️ BRIDGE: Failed to recover message ${msg.id}:`, err.message);
        failures.push(msg);
      });
    });

    // Re-store any failures (best effort, async)
    setTimeout(() => {
      if (failures.length > 0) {
        try {
          window.localStorage.setItem(LOCALSTORAGE_EMERGENCY_KEY, JSON.stringify(failures));
          console.warn(`⚠️ BRIDGE: ${failures.length} messages re-queued to localStorage`);
        } catch (e) {
          // Give up
        }
      }
    }, 2000);
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

  // Fast-fail when SW is known-dead or context invalidated.
  // The generation guard already prevents stale-bridge races, so dispatching
  // an error response is safe — no newer bridge will collide.
  if (!chrome.runtime?.id || swDisconnected) {
    console.warn('⚠️ BRIDGE: Extension context invalidated or SW disconnected - fast-failing context request');
    window.dispatchEvent(new CustomEvent('KYT_CONTEXT_RESPONSE', {
      detail: {
        requestId: requestId,
        success: false,
        formattedContext: null,
        items: [],
        elapsedMs: 0,
        error: swDisconnected ? 'Service worker disconnected' : 'Extension context invalidated'
      }
    }));
    return;
  }

  try {
    // Forward to background script (no CSP restrictions there!)
    const response = await chrome.runtime.sendMessage({
      type: 'GET_CONTEXT',
      userMessage: userMessage,
      config: config
    });

    // Null guard: Chrome can resolve sendMessage with undefined when the channel closes
    if (!response) {
      markDisconnected('sendMessage resolved with undefined response');
      window.dispatchEvent(new CustomEvent('KYT_CONTEXT_RESPONSE', {
        detail: {
          requestId: requestId,
          success: false,
          formattedContext: null,
          items: [],
          elapsedMs: 0,
          error: 'Service worker did not respond'
        }
      }));
      return;
    }

    // Send response back to MAIN world
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

    console.log('✅ BRIDGE: Context response sent to MAIN world');
  } catch (error) {
    if (isDisconnectionError(error.message)) {
      markDisconnected(error.message);
    }
    console.error('❌ BRIDGE: Failed to get context:', error);

    // Send error response
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
