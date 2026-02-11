/**
 * KYT Memory Extension - Claude Bridge Script
 *
 * Runs in ISOLATED world (traditional content script)
 * Listens for CustomEvents from MAIN world and forwards to background
 *
 * Architecture:
 * MAIN world (content_test.js) → CustomEvent → ISOLATED world (this file) → chrome.runtime → background.js
 */

// Generation guard: only the latest injected bridge responds to events.
// On extension reload, a new bridge is injected via chrome.scripting.executeScript().
// The new bridge overwrites window.__kytBridgeGeneration, silencing old bridge handlers.
const BRIDGE_GENERATION = Date.now();
window.__kytBridgeGeneration = BRIDGE_GENERATION;

console.log('🔵 BRIDGE: Content bridge loaded in ISOLATED world at:', new Date().toISOString());
console.log('🔵 BRIDGE: chrome.runtime available:', typeof chrome?.runtime !== 'undefined');
console.log('🔵 BRIDGE: Generation:', BRIDGE_GENERATION);

// Queue Manager — provides 3-tier offline fallback for captured messages
let queueManager = null;

(async () => {
  try {
    const src = chrome.runtime.getURL('src/content/queue-manager.js');
    const module = await import(src);
    queueManager = module.queueManager;
    await queueManager.initialize();
    console.log('🔵 BRIDGE: Queue Manager initialized');
  } catch (e) {
    console.warn('🔵 BRIDGE: Queue Manager not available, using direct send only', e.message);
  }
})();

// Listen for messages from MAIN world via CustomEvent
window.addEventListener('KYT_MESSAGE_CAPTURED', async (event) => {
  if (window.__kytBridgeGeneration !== BRIDGE_GENERATION) return; // stale bridge

  const messageData = event.detail;
  if (!messageData) {
    console.error('🔵 BRIDGE: Event has no detail data');
    return;
  }

  console.log('🔵 BRIDGE: Received KYT_MESSAGE_CAPTURED event');

  // Use Queue Manager if available — handles context invalidation gracefully
  if (queueManager) {
    console.log('🔵 BRIDGE: Enqueuing via Queue Manager');
    await queueManager.capture(messageData);
    return;
  }

  // Queue Manager not ready — check context validity
  if (!chrome.runtime?.id) {
    console.warn('⚠️ BRIDGE: Extension context invalidated and Queue Manager not ready');
    // Emergency fallback: store directly in chrome.storage.local
    try {
      const emergencyKey = 'kyt_emergency_queue';
      const result = await chrome.storage.local.get([emergencyKey]);
      const queue = result[emergencyKey] || [];
      queue.push({
        ...messageData,
        id: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        timestamp: Date.now(),
        emergencyBackup: true
      });
      await chrome.storage.local.set({ [emergencyKey]: queue });
      console.log('💾 BRIDGE: Message saved to emergency backup');
    } catch (e) {
      console.error('❌ BRIDGE: Emergency backup failed:', e);
    }
    return;
  }

  // Direct send (legacy fallback — QM not ready but context valid)
  console.log('🔵 BRIDGE: Forwarding to background (direct)...');
  chrome.runtime.sendMessage({
    type: 'SAVE_MESSAGE',
    data: messageData
  }, (response) => {
    if (chrome.runtime.lastError) {
      const error = chrome.runtime.lastError.message;
      if (error.includes('Extension context invalidated')) {
        console.warn('⚠️ BRIDGE: Extension was reloaded - please refresh page');
      } else {
        console.error('🔵 BRIDGE: Background message failed:', error);
      }
    } else {
      console.log('🔵 BRIDGE: ✅ Background confirmed receipt:', response);
    }
  });
});

// Listen for context requests from MAIN world
window.addEventListener('KYT_CONTEXT_REQUEST', async (event) => {
  if (window.__kytBridgeGeneration !== BRIDGE_GENERATION) return; // stale bridge

  const { requestId, userMessage, config } = event.detail;
  console.log('🔍 BRIDGE: Context request from MAIN world');

  // Check if extension context is still valid
  // If invalid and we're the latest bridge (no newer bridge injected), return silently.
  // The MAIN world's 10s timeout will handle it. Do NOT dispatch an error response here —
  // it would race with a newly injected bridge's success response.
  if (!chrome.runtime?.id) {
    console.warn('⚠️ BRIDGE: Extension context invalidated - cannot get context');
    console.warn('   Please reload the page to restore functionality');
    return;
  }

  try {
    // Forward to background script (no CSP restrictions there!)
    const response = await chrome.runtime.sendMessage({
      type: 'GET_CONTEXT',
      userMessage: userMessage,
      config: config
    });

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
    // Better error handling for context invalidation
    if (error.message && error.message.includes('Extension context invalidated')) {
      console.warn('⚠️ BRIDGE: Extension was reloaded - please refresh page');
    } else {
      console.error('❌ BRIDGE: Failed to get context:', error);
    }

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
