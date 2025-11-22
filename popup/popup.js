// popup.js - K.Y.T. Memory Extension Status Dashboard

// DOM elements
const fetchStatus = document.getElementById('fetchStatus');
const wsStatus = document.getElementById('wsStatus');
const domStatus = document.getElementById('domStatus');
const totalMessages = document.getElementById('totalMessages');
const sessionMessages = document.getElementById('sessionMessages');
const lastCaptureTime = document.getElementById('lastCaptureTime');
const chatgptPlatform = document.getElementById('chatgptPlatform');
const claudePlatform = document.getElementById('claudePlatform');
const apiStatus = document.getElementById('apiStatus');
const transformStatus = document.getElementById('transformStatus');
const debugModeToggle = document.getElementById('debugModeToggle');
const testCaptureBtn = document.getElementById('testCaptureBtn');
const setupBtn = document.getElementById('setupBtn');
const testResult = document.getElementById('testResult');

/**
 * Update status indicator with color coding
 */
function updateStatus(element, active, text) {
  element.textContent = text;
  element.className = 'status-indicator';

  if (active === true) {
    element.classList.add('active');
  } else if (active === false) {
    element.classList.add('inactive');
  } else {
    element.classList.add('partial');
  }
}

/**
 * Format timestamp for display
 */
function formatTimestamp(timestamp) {
  if (!timestamp) return 'Never';

  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now - date;
  const diffMins = Math.floor(diffMs / 60000);

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;

  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;

  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

/**
 * Load and display current statistics
 */
async function loadStats() {
  try {
    // Get stats from background script
    const response = await chrome.runtime.sendMessage({
      type: 'GET_STATS'
    });

    if (!response || response.error) {
      console.error('Failed to get stats:', response?.error);
      return;
    }

    const stats = response.stats;

    // Check if we're on a supported platform page
    const onPlatform = stats.platform === 'chatgpt' || stats.platform === 'claude';
    const hasMessages = stats.totalMessages > 0;

    // Update interception status with helpful context
    if (!onPlatform && !stats.fetch?.active) {
      // Not on platform page - show helpful message
      updateStatus(fetchStatus, null, '⚠️ Not on platform page');
      updateStatus(wsStatus, null, '⚠️ Navigate to chatgpt.com or claude.ai');
      updateStatus(domStatus, null, '⚠️ Then reopen this popup');
    } else {
      // On platform page - show actual status
      updateStatus(fetchStatus, stats.fetch?.active,
        stats.fetch?.active ? '🟢 Active' : '🔴 Inactive');
      updateStatus(wsStatus, stats.websocket?.active,
        stats.websocket?.active ? '🟢 Active' : '🔴 Inactive');
      updateStatus(domStatus, stats.domObserver?.active,
        stats.domObserver?.active ? '🟢 Active' : '🔴 Inactive');
    }

    // Update message counts
    totalMessages.textContent = stats.totalMessages || 0;
    sessionMessages.textContent = stats.sessionMessages || 0;
    lastCaptureTime.textContent = formatTimestamp(stats.lastCaptureTime);

    // Update platform detection with helpful hints
    if (!onPlatform && hasMessages) {
      // Has messages but not currently on platform
      chatgptPlatform.textContent = '💡 Open chatgpt.com to see live stats';
      claudePlatform.textContent = '💡 Open claude.ai to see live stats';
    } else {
      chatgptPlatform.textContent = stats.platform === 'chatgpt' ? '✅ Detected' : '❌ Not Detected';
      claudePlatform.textContent = stats.platform === 'claude' ? '✅ Detected' : '❌ Not Detected';
    }

  } catch (error) {
    console.error('Error loading stats:', error);
  }
}

/**
 * Load and display configuration status
 */
async function loadConfig() {
  try {
    const result = await chrome.storage.local.get(['api_config']);
    const config = result.api_config;

    if (!config) {
      apiStatus.textContent = '❌ Not Configured';
      apiStatus.style.color = '#721c24';
      transformStatus.textContent = '⚠️ Unknown';
      transformStatus.style.color = '#856404';
      return;
    }

    // Check API keys
    const hasKeys = config.supabaseUrl && config.supabaseKey && config.openaiKey;
    apiStatus.textContent = hasKeys ? '✅ Configured' : '⚠️ Incomplete';
    apiStatus.style.color = hasKeys ? '#155724' : '#856404';

    // Check query transformation
    const transformDisabled = config.disableQueryTransformation;
    transformStatus.textContent = transformDisabled ? '✅ Disabled (Phase 1)' : '⚠️ Enabled';
    transformStatus.style.color = transformDisabled ? '#155724' : '#856404';

  } catch (error) {
    console.error('Error loading config:', error);
    apiStatus.textContent = '❌ Error';
    transformStatus.textContent = '❌ Error';
  }
}

/**
 * Load and update debug mode toggle
 */
async function loadDebugMode() {
  try {
    const result = await chrome.storage.local.get(['kytDebugMode']);
    const debugMode = result.kytDebugMode || false;
    debugModeToggle.checked = debugMode;
  } catch (error) {
    console.error('Error loading debug mode:', error);
  }
}

/**
 * Save debug mode setting
 */
async function saveDebugMode() {
  try {
    const debugMode = debugModeToggle.checked;
    await chrome.storage.local.set({ kytDebugMode: debugMode });
    console.log('🐛 K.Y.T. Debug Mode:', debugMode ? 'ENABLED' : 'DISABLED');
  } catch (error) {
    console.error('Error saving debug mode:', error);
  }
}

/**
 * Test message capture functionality
 */
async function testCapture() {
  testCaptureBtn.disabled = true;
  testCaptureBtn.textContent = '🔄 Testing...';

  try {
    // Send test message to background script
    const response = await chrome.runtime.sendMessage({
      type: 'TEST_CAPTURE'
    });

    if (response && response.success) {
      testResult.className = 'test-result success';
      testResult.textContent = `✅ Success! Captured ${response.messageCount} test message(s). Interception is working correctly.`;
    } else {
      testResult.className = 'test-result error';
      testResult.textContent = `❌ Test failed: ${response?.error || 'Unknown error'}`;
    }

    testResult.classList.remove('hidden');

    // Reload stats to show updated counts
    setTimeout(loadStats, 500);

  } catch (error) {
    console.error('Test failed:', error);
    testResult.className = 'test-result error';
    testResult.textContent = `❌ Test error: ${error.message}`;
    testResult.classList.remove('hidden');
  } finally {
    testCaptureBtn.disabled = false;
    testCaptureBtn.textContent = '🔬 Test Message Capture';
  }
}

/**
 * Open setup page
 */
function openSetup() {
  chrome.runtime.openOptionsPage();
}

// Event listeners
debugModeToggle.addEventListener('change', saveDebugMode);
testCaptureBtn.addEventListener('click', testCapture);
setupBtn.addEventListener('click', openSetup);

// Initial load
loadStats();
loadConfig();
loadDebugMode();

// Refresh stats every 5 seconds
setInterval(loadStats, 5000);
