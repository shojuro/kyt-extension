/**
 * KYT Memory Extension - Claude Bridge Script
 *
 * Runs in ISOLATED world (traditional content script)
 * Listens for CustomEvents from MAIN world and forwards to background
 *
 * Architecture:
 * MAIN world (content_test.js) → CustomEvent → ISOLATED world (this file) → chrome.runtime → background.js
 */

console.log('🔵 BRIDGE: Content bridge loaded in ISOLATED world at:', new Date().toISOString());
console.log('🔵 BRIDGE: chrome.runtime available:', typeof chrome?.runtime !== 'undefined');

// Listen for messages from MAIN world via CustomEvent
window.addEventListener('KYT_MESSAGE_CAPTURED', (event) => {
  console.log('🔵 BRIDGE: Received KYT_MESSAGE_CAPTURED event');
  console.log('🔵 BRIDGE: Event detail:', event.detail);

  if (!event.detail) {
    console.error('🔵 BRIDGE: Event has no detail data');
    return;
  }

  // Forward to background script
  if (chrome?.runtime) {
    console.log('🔵 BRIDGE: Forwarding to background...');
    chrome.runtime.sendMessage({
      type: 'SAVE_MESSAGE',
      data: event.detail
    }, (response) => {
      if (chrome.runtime.lastError) {
        console.error('🔵 BRIDGE: Background message failed:', chrome.runtime.lastError.message);
      } else {
        console.log('🔵 BRIDGE: ✅ Background confirmed receipt:', response);
      }
    });
  } else {
    console.error('🔵 BRIDGE: chrome.runtime not available - cannot forward to background');
  }
});

// Listen for context requests from MAIN world
window.addEventListener('KYT_CONTEXT_REQUEST', async (event) => {
  const { requestId, userMessage, config } = event.detail;
  console.log('🔍 BRIDGE: Context request from MAIN world');

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
