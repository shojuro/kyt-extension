/**
 * KYT Memory Extension - Gemini Bridge Script
 *
 * Runs in ISOLATED world (traditional content script)
 * Listens for CustomEvents from MAIN world and forwards to background
 *
 * Architecture:
 * MAIN world (content_test.js) → CustomEvent → ISOLATED world (this file) → chrome.runtime → background.js
 *
 * NOTE: This file MUST remain a classic (non-module) script so that
 * chrome.scripting.executeScript() can re-inject it after extension reload.
 * The 3-tier capture fallback is inlined (no ES imports in classic scripts).
 */

// Generation guard: only the latest injected bridge responds to events
const BRIDGE_GENERATION = Date.now();
window.__kytGeminiBridgeGeneration = BRIDGE_GENERATION;

console.log('KYT Gemini BRIDGE: Loaded in ISOLATED world at:', new Date().toISOString());
console.log('KYT Gemini BRIDGE: chrome.runtime available:', typeof chrome?.runtime !== 'undefined');

// ===== INLINED 3-TIER CAPTURE FALLBACK =====
const UNENCRYPTED_QUEUE_KEY = 'kyt_pending_unencrypted_queue';
const LOCALSTORAGE_EMERGENCY_KEY = 'kyt_emergency_localStorage_queue';
const LOCALSTORAGE_MAX_SIZE = 50;

// ===== SERVICE WORKER DISCONNECTION TRACKING =====
let swDisconnectedUntil = 0;
let swDisconnectCount = 0;
const SW_COOLDOWN_STEPS = [5000, 15000, 30000, 60000];

function markDisconnected(errorMsg) {
  const cooldownMs = SW_COOLDOWN_STEPS[Math.min(swDisconnectCount, SW_COOLDOWN_STEPS.length - 1)];
  swDisconnectedUntil = Date.now() + cooldownMs;
  swDisconnectCount++;
  console.warn('KYT Gemini BRIDGE: SW disconnected — cooldown ' + (cooldownMs / 1000) + 's (attempt ' + swDisconnectCount + ')');
}

function isSwCoolingDown() {
  return Date.now() < swDisconnectedUntil;
}

function resetDisconnectState() {
  if (swDisconnectCount > 0) {
    console.log('KYT Gemini BRIDGE: SW reconnected — resetting disconnect state');
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
 */
async function captureMessage(messageData) {
  const msgId = messageData.messageId || 'msg_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
  const queuedMessage = {
    id: msgId,
    messageId: msgId,
    timestamp: messageData.timestamp || Date.now(),
    platform: messageData.platform || 'gemini',
    content: messageData.content,
    role: messageData.role,
    conversationId: messageData.conversationId,
    model: messageData.model,
    source: messageData.source,
    retryCount: 0
  };

  // Tier 1: sendMessage to background
  if (chrome.runtime?.id && !isSwCoolingDown()) {
    try {
      await chrome.runtime.sendMessage({ type: 'SAVE_MESSAGE', data: queuedMessage });
      resetDisconnectState();
      console.log('KYT Gemini BRIDGE: Message sent to background (Tier 1)');
      return;
    } catch (e) {
      console.warn('KYT Gemini BRIDGE: Tier 1 failed:', e.message);
      if (isDisconnectionError(e.message)) {
        markDisconnected(e.message);
      }
    }
  }

  // Tier 2: chrome.storage.local
  if (chrome.runtime?.id) {
    try {
      const result = await chrome.storage.local.get([UNENCRYPTED_QUEUE_KEY]);
      const queue = result[UNENCRYPTED_QUEUE_KEY] || [];
      queue.push({ ...queuedMessage, emergencyBackup: true });
      await chrome.storage.local.set({ [UNENCRYPTED_QUEUE_KEY]: queue });
      console.log('KYT Gemini BRIDGE: Message saved to chrome.storage (Tier 2)');
      return;
    } catch (e) {
      console.warn('KYT Gemini BRIDGE: Tier 2 failed:', e.message);
    }
  }

  // Tier 3: window.localStorage
  try {
    const stored = window.localStorage.getItem(LOCALSTORAGE_EMERGENCY_KEY);
    const queue = stored ? JSON.parse(stored) : [];
    while (queue.length >= LOCALSTORAGE_MAX_SIZE) queue.shift();
    queue.push({ ...queuedMessage, emergencyStorage: true, storedAt: Date.now() });
    window.localStorage.setItem(LOCALSTORAGE_EMERGENCY_KEY, JSON.stringify(queue));
    console.log('KYT Gemini BRIDGE: Message saved to localStorage (Tier 3)');
  } catch (e) {
    console.error('KYT Gemini BRIDGE: All 3 capture tiers failed:', e);
  }
}

// ===== LOCALSTORAGE RECOVERY ON STARTUP =====
(function recoverLocalStorageQueue() {
  if (!chrome.runtime?.id) return;

  try {
    const stored = window.localStorage.getItem(LOCALSTORAGE_EMERGENCY_KEY);
    if (!stored) return;

    const queue = JSON.parse(stored);
    if (!Array.isArray(queue) || queue.length === 0) return;

    console.log('KYT Gemini BRIDGE: Recovering ' + queue.length + ' messages from emergency localStorage');
    window.localStorage.removeItem(LOCALSTORAGE_EMERGENCY_KEY);

    const failures = [];
    queue.forEach(msg => {
      chrome.runtime.sendMessage({ type: 'SAVE_MESSAGE', data: msg }).catch(err => {
        failures.push(msg);
      });
    });

    setTimeout(() => {
      if (failures.length > 0) {
        try {
          window.localStorage.setItem(LOCALSTORAGE_EMERGENCY_KEY, JSON.stringify(failures));
        } catch (_) { /* give up */ }
      }
    }, 2000);
  } catch (e) {
    console.warn('KYT Gemini BRIDGE: localStorage recovery failed:', e.message);
  }
})();

// ===== EVENT LISTENERS =====

// Messages from MAIN world
window.addEventListener('KYT_MESSAGE_CAPTURED', async (event) => {
  if (window.__kytGeminiBridgeGeneration !== BRIDGE_GENERATION) return;

  const messageData = event.detail;
  if (!messageData) return;

  console.log('KYT Gemini BRIDGE: Received KYT_MESSAGE_CAPTURED event');
  await captureMessage(messageData);
});

// Context requests from MAIN world
window.addEventListener('KYT_CONTEXT_REQUEST', async (event) => {
  if (window.__kytGeminiBridgeGeneration !== BRIDGE_GENERATION) return;

  const { requestId, userMessage, config } = event.detail;
  console.log('KYT Gemini BRIDGE: Context request from MAIN world');

  if (!chrome.runtime?.id) {
    window.dispatchEvent(new CustomEvent('KYT_CONTEXT_RESPONSE', {
      detail: { requestId, success: false, formattedContext: null, items: [], elapsedMs: 0, error: 'Extension context invalidated' }
    }));
    return;
  }

  if (isSwCoolingDown()) {
    const remainingSec = Math.ceil((swDisconnectedUntil - Date.now()) / 1000);
    window.dispatchEvent(new CustomEvent('KYT_CONTEXT_RESPONSE', {
      detail: { requestId, success: false, formattedContext: null, items: [], elapsedMs: 0, error: 'Service worker cooling down (' + remainingSec + 's remaining)' }
    }));
    return;
  }

  try {
    const port = chrome.runtime.connect({ name: 'kyt-context' });
    let responded = false;

    const timeoutId = setTimeout(() => {
      if (responded) return;
      responded = true;
      try { port.disconnect(); } catch (_) {}
      window.dispatchEvent(new CustomEvent('KYT_CONTEXT_RESPONSE', {
        detail: { requestId, success: false, formattedContext: null, items: [], elapsedMs: 0, error: 'Context request timed out' }
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
          requestId,
          success: response.success,
          formattedContext: response.formattedContext,
          items: response.items,
          elapsedMs: response.elapsedMs,
          error: response.error
        }
      }));
    });

    port.onDisconnect.addListener(() => {
      if (responded) return;
      responded = true;
      clearTimeout(timeoutId);
      const err = chrome.runtime.lastError?.message || 'Port disconnected';
      if (isDisconnectionError(err) || err === 'Port disconnected') {
        markDisconnected(err);
      }
      window.dispatchEvent(new CustomEvent('KYT_CONTEXT_RESPONSE', {
        detail: { requestId, success: false, formattedContext: null, items: [], elapsedMs: 0, error: err }
      }));
    });

    port.postMessage({ requestId, userMessage, config });
  } catch (error) {
    if (isDisconnectionError(error.message)) {
      markDisconnected(error.message);
    }
    window.dispatchEvent(new CustomEvent('KYT_CONTEXT_RESPONSE', {
      detail: { requestId, success: false, formattedContext: null, items: [], elapsedMs: 0, error: error.message }
    }));
  }
});

// Debug log forwarding
window.addEventListener('KYT_DEBUG_LOG', (event) => {
  if (window.__kytGeminiBridgeGeneration !== BRIDGE_GENERATION) return;
  console.log('KYT Gemini BRIDGE [debug]:', event.detail);
});

// Health check
window.addEventListener('KYT_BRIDGE_PING', () => {
  if (window.__kytGeminiBridgeGeneration !== BRIDGE_GENERATION) return;
  window.dispatchEvent(new CustomEvent('KYT_BRIDGE_PONG', {
    detail: { status: 'alive', hasRuntime: typeof chrome?.runtime !== 'undefined', timestamp: Date.now() }
  }));
});

console.log('KYT Gemini BRIDGE: Listening for KYT_MESSAGE_CAPTURED and KYT_CONTEXT_REQUEST events');
