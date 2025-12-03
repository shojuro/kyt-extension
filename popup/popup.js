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
const importBtn = document.getElementById('importBtn');
const testResult = document.getElementById('testResult');
const tierBadge = document.getElementById('tierBadge');
const tierDescription = document.getElementById('tierDescription');
const upgradeBtn = document.getElementById('upgradeBtn');
const manageBillingBtn = document.getElementById('manageBillingBtn');
const rescanBtn = document.getElementById('rescanBtn');

// Tier descriptions for display
const TIER_INFO = {
  free: { label: 'FREE', description: 'Basic features' },
  pro: { label: 'PRO', description: 'Unlimited memories, priority support' },
  dev: { label: 'DEV', description: 'API access, advanced features' }
};

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

/**
 * Open import modal
 */
function openImport() {
  chrome.windows.create({
    url: 'popup/import-modal.html',
    type: 'popup',
    width: 350,
    height: 600
  });
}

/**
 * Rescan page messages (Recovery Mode)
 */
async function rescanMessages() {
  rescanBtn.disabled = true;
  rescanBtn.textContent = '🔄 Scanning...';

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) throw new Error('No active tab');

    // Send message to content script
    await chrome.tabs.sendMessage(tab.id, { type: 'SCAN_DOM' });

    testResult.className = 'test-result success';
    testResult.textContent = '✅ Rescan command sent. Check console for details.';
    testResult.classList.remove('hidden');

  } catch (error) {
    console.error('Rescan failed:', error);
    testResult.className = 'test-result error';
    testResult.textContent = `❌ Rescan failed: ${error.message}`;
    testResult.classList.remove('hidden');
  } finally {
    setTimeout(() => {
      rescanBtn.disabled = false;
      rescanBtn.textContent = '🔄 Rescan Page Messages';
    }, 2000);
  }
}

/**
 * Load and display subscription tier
 */
async function loadSubscription() {
  try {
    // Get user tier from storage (synced from database via background script)
    const result = await chrome.storage.local.get(['user_tier', 'user_id', 'api_config']);
    const tier = result.user_tier || 'free';
    const userId = result.user_id;
    const config = result.api_config;

    // Update tier badge
    const info = TIER_INFO[tier] || TIER_INFO.free;
    tierBadge.textContent = info.label;
    tierBadge.className = `tier-badge tier-${tier}`;
    tierDescription.textContent = info.description;

    // Show/hide buttons based on tier
    if (tier === 'free') {
      upgradeBtn.classList.remove('hidden');
      manageBillingBtn.classList.add('hidden');
    } else {
      upgradeBtn.classList.add('hidden');
      manageBillingBtn.classList.remove('hidden');
    }

  } catch (error) {
    console.error('Error loading subscription:', error);
    // Default to free tier on error
    tierBadge.textContent = 'FREE';
    tierBadge.className = 'tier-badge tier-free';
    tierDescription.textContent = 'Basic features';
  }
}

/**
 * Handle upgrade button click - redirect to Stripe Checkout
 */
async function handleUpgrade() {
  upgradeBtn.disabled = true;
  upgradeBtn.textContent = '⏳ Loading...';

  try {
    const result = await chrome.storage.local.get(['user_id', 'api_config']);
    const userId = result.user_id;
    const config = result.api_config;

    if (!userId || !config?.supabaseUrl || !config?.supabaseKey) {
      throw new Error('Please configure API keys first');
    }

    // Call create-checkout Edge Function
    const response = await fetch(`${config.supabaseUrl}/functions/v1/create-checkout`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.supabaseKey}`,
      },
      body: JSON.stringify({
        userId: userId,
        priceId: 'price_xxx_pro', // TODO: Replace with real price ID after Stripe setup
      }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to create checkout session');
    }

    const { url } = await response.json();

    // Open checkout in new tab
    chrome.tabs.create({ url });

  } catch (error) {
    console.error('Upgrade error:', error);
    alert(`Upgrade failed: ${error.message}`);
  } finally {
    upgradeBtn.disabled = false;
    upgradeBtn.textContent = '⚡ Upgrade to Pro';
  }
}

/**
 * Handle manage billing button click - redirect to Stripe Billing Portal
 */
async function handleManageBilling() {
  manageBillingBtn.disabled = true;
  manageBillingBtn.textContent = '⏳ Loading...';

  try {
    const result = await chrome.storage.local.get(['user_id', 'api_config']);
    const userId = result.user_id;
    const config = result.api_config;

    if (!userId || !config?.supabaseUrl || !config?.supabaseKey) {
      throw new Error('Please configure API keys first');
    }

    // Call billing-portal Edge Function
    const response = await fetch(`${config.supabaseUrl}/functions/v1/billing-portal`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.supabaseKey}`,
      },
      body: JSON.stringify({
        userId: userId,
      }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to create billing portal session');
    }

    const { url } = await response.json();

    // Open billing portal in new tab
    chrome.tabs.create({ url });

  } catch (error) {
    console.error('Billing portal error:', error);
    alert(`Billing portal failed: ${error.message}`);
  } finally {
    manageBillingBtn.disabled = false;
    manageBillingBtn.textContent = '⚙️ Manage Subscription';
  }
}

// Event listeners
upgradeBtn.addEventListener('click', handleUpgrade);
manageBillingBtn.addEventListener('click', handleManageBilling);
debugModeToggle.addEventListener('change', saveDebugMode);
testCaptureBtn.addEventListener('click', testCapture);
rescanBtn.addEventListener('click', rescanMessages);
setupBtn.addEventListener('click', openSetup);
importBtn.addEventListener('click', openImport);

/**
 * Check if this is first install and redirect to import onboarding
 */
async function checkFirstInstallRedirect() {
  try {
    const result = await chrome.storage.local.get(['show_import_onboarding']);
    if (result.show_import_onboarding === true) {
      // Redirect to import modal with first-install mode
      window.location.href = 'import-modal.html?mode=first-install';
      return true; // Redirecting
    }
  } catch (error) {
    console.error('Error checking first install:', error);
  }
  return false; // Not redirecting
}

// Initial load - check for first-install redirect first
checkFirstInstallRedirect().then(redirecting => {
  if (!redirecting) {
    // Only load normal UI if not redirecting
    loadStats();
    loadConfig();
    loadDebugMode();
    loadSubscription();

    // Refresh stats every 5 seconds
    setInterval(loadStats, 5000);
  }
});
