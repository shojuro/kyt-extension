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

console.log('🔵 BRIDGE: Listening for KYT_MESSAGE_CAPTURED events');
