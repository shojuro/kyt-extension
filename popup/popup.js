// popup.js - K.Y.T. Memory Extension Status Dashboard

const AUTH_SESSION_KEY = 'auth_session';

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
const hfKeyStatus = document.getElementById('hfKeyStatus');
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
const capturedCount = document.getElementById('capturedCount');
const syncedCount = document.getElementById('syncedCount');
const pendingCount = document.getElementById('pendingCount');
const lastSyncTime = document.getElementById('lastSyncTime');
const forceSyncBtn = document.getElementById('forceSyncBtn');
const syncResult = document.getElementById('syncResult');
const modeRadios = document.querySelectorAll('input[name="memoryMode"]');
const profileName = document.getElementById('profileName');
const newProfileBtn = document.getElementById('newProfileBtn');
const authLoggedIn = document.getElementById('authLoggedIn');
const authLoggedOut = document.getElementById('authLoggedOut');
const userEmailEl = document.getElementById('userEmail');
const signInBtn = document.getElementById('signInBtn');
const signOutBtnEl = document.getElementById('signOutBtn');

// Tier descriptions for display
const TIER_INFO = {
  free: { label: 'FREE', description: 'Basic features' },
  pro: { label: 'PRO', description: 'Unlimited memories, priority support' },
  dev: { label: 'DEV', description: 'API access, advanced features' }
};

// ============================================
// K.I.T.T. SCANNER ENGINE (header)
// ============================================
const LED_COUNT = 8;
const TRAIL_INTENSITIES = [5, 4, 3, 2, 1];
const BASE_STEP_MS = 120;

function initHeaderScanner() {
  const track = document.querySelector('.header-scanner');
  if (!track) return;
  startScannerSweep(track);
}

function startScannerSweep(track) {
  const leds = track.querySelectorAll('.kyt-scanner-led');
  let position = 0;
  let direction = 1;
  let paused = false;

  function step() {
    for (let i = 0; i < leds.length; i++) {
      leds[i].setAttribute('data-intensity', '0');
    }

    for (let t = 0; t < TRAIL_INTENSITIES.length; t++) {
      const idx = position - t * direction;
      if (idx >= 0 && idx < leds.length) {
        leds[idx].setAttribute('data-intensity', String(TRAIL_INTENSITIES[t]));
      }
    }

    position += direction;

    if (position >= leds.length) {
      position = leds.length - 1;
      direction = -1;
      paused = true;
    } else if (position < 0) {
      position = 0;
      direction = 1;
      paused = true;
    }

    const delay = paused ? BASE_STEP_MS * 2.5 : BASE_STEP_MS;
    paused = false;
    setTimeout(step, delay);
  }

  step();
}

// ============================================
// STATUS HELPERS
// ============================================

/**
 * Build a status-dot + text HTML string
 */
function statusHTML(dotClass, text) {
  return `<span class="status-dot ${dotClass}"></span> ${text}`;
}

/**
 * Update status indicator with color coding
 */
function updateStatus(element, active, text) {
  element.className = 'status-indicator';

  if (active === true) {
    element.innerHTML = statusHTML('status-dot--ok', text);
    element.classList.add('active');
  } else if (active === false) {
    element.innerHTML = statusHTML('status-dot--error', text);
    element.classList.add('inactive');
  } else {
    element.innerHTML = statusHTML('status-dot--warn', text);
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
      updateStatus(fetchStatus, null, 'Not on platform page');
      updateStatus(wsStatus, null, 'Navigate to chatgpt.com or claude.ai');
      updateStatus(domStatus, null, 'Then reopen this popup');
    } else {
      // On platform page - show actual status
      updateStatus(fetchStatus, stats.fetch?.active,
        stats.fetch?.active ? 'Active' : 'Inactive');
      updateStatus(wsStatus, stats.websocket?.active,
        stats.websocket?.active ? 'Active' : 'Inactive');
      updateStatus(domStatus, stats.domObserver?.active,
        stats.domObserver?.active ? 'Active' : 'Inactive');
    }

    // Update message counts
    totalMessages.textContent = stats.totalMessages || 0;
    sessionMessages.textContent = stats.sessionMessages || 0;
    lastCaptureTime.textContent = formatTimestamp(stats.lastCaptureTime);

    // Update platform detection with helpful hints
    if (!onPlatform && hasMessages) {
      chatgptPlatform.innerHTML = statusHTML('status-dot--warn', 'Open chatgpt.com for live stats');
      claudePlatform.innerHTML = statusHTML('status-dot--warn', 'Open claude.ai for live stats');
    } else {
      chatgptPlatform.innerHTML = stats.platform === 'chatgpt'
        ? statusHTML('status-dot--ok', 'Detected')
        : statusHTML('status-dot--error', 'Not Detected');
      claudePlatform.innerHTML = stats.platform === 'claude'
        ? statusHTML('status-dot--ok', 'Detected')
        : statusHTML('status-dot--error', 'Not Detected');
    }

  } catch (error) {
    console.error('Error loading stats:', error);
  }
}

/**
 * Load and display auth status in the Account section
 */
async function loadAuthStatus() {
  try {
    const result = await chrome.storage.local.get([AUTH_SESSION_KEY]);
    const session = result[AUTH_SESSION_KEY];

    if (session?.access_token && session.expires_at > Math.floor(Date.now() / 1000)) {
      // Authenticated
      authLoggedIn.classList.remove('hidden');
      authLoggedIn.style.display = 'flex';
      authLoggedOut.style.display = 'none';
      userEmailEl.textContent = session.user?.email || 'Authenticated';
    } else {
      // Not authenticated
      authLoggedIn.classList.add('hidden');
      authLoggedIn.style.display = 'none';
      authLoggedOut.style.display = 'block';
    }
  } catch (error) {
    console.error('Error loading auth status:', error);
  }
}

/**
 * Load and display active profile
 */
async function loadProfile() {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'GET_PROFILE' });
    if (response && response.success && response.profileId) {
      profileName.textContent = 'Default';
      profileName.title = response.profileId;
    }
  } catch (error) {
    console.error('Error loading profile:', error);
  }
}

/**
 * Load and display configuration status
 */
async function loadConfig() {
  try {
    const result = await chrome.storage.local.get(['api_config', AUTH_SESSION_KEY]);
    const config = result.api_config;
    const session = result[AUTH_SESSION_KEY];
    const isAuthed = session?.access_token && session.expires_at > Math.floor(Date.now() / 1000);

    if (isAuthed) {
      apiStatus.innerHTML = statusHTML('status-dot--ok', 'Authenticated');
      hfKeyStatus.innerHTML = statusHTML('status-dot--ok', 'Server-side');
    } else if (!config) {
      apiStatus.innerHTML = statusHTML('status-dot--error', 'Not Configured');
      hfKeyStatus.innerHTML = statusHTML('status-dot--error', 'Not Configured');
      transformStatus.innerHTML = statusHTML('status-dot--warn', 'Unknown');
      return;
    } else {
      const hasKeys = config.supabaseUrl && config.supabaseKey && config.openaiKey;
      apiStatus.innerHTML = hasKeys
        ? statusHTML('status-dot--ok', 'Configured')
        : statusHTML('status-dot--warn', 'Incomplete');

      const hasHfKey = !!config.huggingfaceKey;
      if (hasHfKey) {
        hfKeyStatus.innerHTML = statusHTML('status-dot--ok', 'Configured');
      } else {
        hfKeyStatus.innerHTML = statusHTML('status-dot--error', 'Missing (Required!)');
      }
    }

    // Check query transformation (applies to both modes)
    const transformDisabled = config?.disableQueryTransformation ?? false;
    transformStatus.innerHTML = transformDisabled
      ? statusHTML('status-dot--warn', 'Disabled')
      : statusHTML('status-dot--ok', 'Enabled');

  } catch (error) {
    console.error('Error loading config:', error);
    apiStatus.innerHTML = statusHTML('status-dot--error', 'Error');
    hfKeyStatus.innerHTML = statusHTML('status-dot--error', 'Error');
    transformStatus.innerHTML = statusHTML('status-dot--error', 'Error');
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
    console.log('K.Y.T. Debug Mode:', debugMode ? 'ENABLED' : 'DISABLED');
  } catch (error) {
    console.error('Error saving debug mode:', error);
  }
}

/**
 * Test message capture functionality
 */
async function testCapture() {
  testCaptureBtn.disabled = true;
  testCaptureBtn.textContent = 'Testing...';

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'TEST_CAPTURE'
    });

    if (response && response.success) {
      testResult.className = 'test-result success';
      testResult.textContent = `Captured ${response.messageCount} test message(s). Interception working.`;
    } else {
      testResult.className = 'test-result error';
      testResult.textContent = `Test failed: ${response?.error || 'Unknown error'}`;
    }

    testResult.classList.remove('hidden');
    setTimeout(loadStats, 500);

  } catch (error) {
    console.error('Test failed:', error);
    testResult.className = 'test-result error';
    testResult.textContent = `Test error: ${error.message}`;
    testResult.classList.remove('hidden');
  } finally {
    testCaptureBtn.disabled = false;
    testCaptureBtn.textContent = 'Test Message Capture';
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
  rescanBtn.textContent = 'Scanning...';

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) throw new Error('No active tab');

    await chrome.tabs.sendMessage(tab.id, { type: 'SCAN_DOM' });

    testResult.className = 'test-result success';
    testResult.textContent = 'Rescan command sent. Check console for details.';
    testResult.classList.remove('hidden');

  } catch (error) {
    console.error('Rescan failed:', error);
    testResult.className = 'test-result error';
    testResult.textContent = `Rescan failed: ${error.message}`;
    testResult.classList.remove('hidden');
  } finally {
    setTimeout(() => {
      rescanBtn.disabled = false;
      rescanBtn.textContent = 'Rescan Page Messages';
    }, 2000);
  }
}

/**
 * Load and display subscription tier
 */
async function loadSubscription() {
  try {
    const result = await chrome.storage.local.get(['user_tier', 'user_id', 'api_config']);
    const tier = result.user_tier || 'free';

    const info = TIER_INFO[tier] || TIER_INFO.free;
    tierBadge.textContent = info.label;
    tierBadge.className = `tier-badge tier-${tier}`;
    tierDescription.textContent = info.description;

    if (tier === 'free') {
      upgradeBtn.classList.remove('hidden');
      manageBillingBtn.classList.add('hidden');
    } else {
      upgradeBtn.classList.add('hidden');
      manageBillingBtn.classList.remove('hidden');
    }

  } catch (error) {
    console.error('Error loading subscription:', error);
    tierBadge.textContent = 'FREE';
    tierBadge.className = 'tier-badge tier-free';
    tierDescription.textContent = 'Basic features';
  }
}

/**
 * Handle upgrade button click
 */
async function handleUpgrade() {
  upgradeBtn.disabled = true;
  upgradeBtn.textContent = 'Loading...';

  try {
    const result = await chrome.storage.local.get(['user_id', 'api_config', AUTH_SESSION_KEY]);
    const session = result[AUTH_SESSION_KEY];
    const config = result.api_config;

    let supabaseUrl, bearerToken, userId;

    if (session?.access_token) {
      const SUPABASE_URL = 'https://svrcvfzlwhnixzuxaccf.supabase.co';
      supabaseUrl = SUPABASE_URL;
      bearerToken = session.access_token;
      userId = session.user?.id;
    } else if (config?.supabaseUrl && config?.supabaseKey) {
      supabaseUrl = config.supabaseUrl;
      bearerToken = config.supabaseKey;
      userId = result.user_id || config.userId;
    } else {
      throw new Error('Please sign in or configure API keys first');
    }

    const response = await fetch(`${supabaseUrl}/functions/v1/create-checkout`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${bearerToken}`,
      },
      body: JSON.stringify({
        userId: userId,
        priceId: 'price_xxx_pro',
      }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to create checkout session');
    }

    const { url } = await response.json();
    chrome.tabs.create({ url });

  } catch (error) {
    console.error('Upgrade error:', error);
    alert(`Upgrade failed: ${error.message}`);
  } finally {
    upgradeBtn.disabled = false;
    upgradeBtn.textContent = 'Upgrade to Pro';
  }
}

/**
 * Handle manage billing button click
 */
async function handleManageBilling() {
  manageBillingBtn.disabled = true;
  manageBillingBtn.textContent = 'Loading...';

  try {
    const result = await chrome.storage.local.get(['user_id', 'api_config', AUTH_SESSION_KEY]);
    const session = result[AUTH_SESSION_KEY];
    const config = result.api_config;

    let supabaseUrl, bearerToken, userId;

    if (session?.access_token) {
      const SUPABASE_URL = 'https://svrcvfzlwhnixzuxaccf.supabase.co';
      supabaseUrl = SUPABASE_URL;
      bearerToken = session.access_token;
      userId = session.user?.id;
    } else if (config?.supabaseUrl && config?.supabaseKey) {
      supabaseUrl = config.supabaseUrl;
      bearerToken = config.supabaseKey;
      userId = result.user_id || config.userId;
    } else {
      throw new Error('Please sign in or configure API keys first');
    }

    const response = await fetch(`${supabaseUrl}/functions/v1/billing-portal`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${bearerToken}`,
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
    chrome.tabs.create({ url });

  } catch (error) {
    console.error('Billing portal error:', error);
    alert(`Billing portal failed: ${error.message}`);
  } finally {
    manageBillingBtn.disabled = false;
    manageBillingBtn.textContent = 'Manage Subscription';
  }
}

/**
 * Load and display sync status
 */
async function loadSyncStatus() {
  try {
    const result = await chrome.storage.local.get(['captured_messages', 'last_sync_status']);
    const messages = result.captured_messages || [];
    const syncStatus = result.last_sync_status || { syncedMessageIds: [], lastSyncTime: 0 };

    const captured = messages.length;
    const synced = (syncStatus.syncedMessageIds || []).length;
    const pending = Math.max(0, captured - synced);

    capturedCount.textContent = captured;
    syncedCount.textContent = synced;
    pendingCount.textContent = pending;
    lastSyncTime.textContent = formatTimestamp(syncStatus.lastSyncTime);

    if (pending > 0) {
      pendingCount.style.color = 'var(--scanner-red)';
      pendingCount.style.fontWeight = '700';
    } else {
      pendingCount.style.color = 'var(--phosphor)';
      pendingCount.style.fontWeight = '';
    }

  } catch (error) {
    console.error('Error loading sync status:', error);
  }
}

/**
 * Force resync all messages
 */
async function forceResync() {
  forceSyncBtn.disabled = true;
  forceSyncBtn.textContent = 'Checking config...';

  try {
    const configResult = await chrome.storage.local.get(['api_config']);
    const config = configResult.api_config;

    if (!config?.huggingfaceKey) {
      syncResult.className = 'test-result error';
      syncResult.textContent = 'HuggingFace API key required. Click "Configure API Keys" to add it.';
      syncResult.classList.remove('hidden');
      forceSyncBtn.disabled = false;
      forceSyncBtn.textContent = 'Force Resync All Messages';
      return;
    }

    forceSyncBtn.textContent = 'Clearing sync state...';

    const result = await chrome.storage.local.get(['last_sync_status']);
    const syncStatus = result.last_sync_status || {};
    const previousCount = (syncStatus.syncedMessageIds || []).length;

    await chrome.storage.local.set({
      last_sync_status: {
        ...syncStatus,
        syncedMessageIds: [],
        lastSyncTime: 0
      }
    });

    console.log(`Cleared ${previousCount} synced message IDs`);

    forceSyncBtn.textContent = 'Syncing to database...';

    const syncResponse = await chrome.runtime.sendMessage({
      type: 'FORCE_SYNC'
    });

    if (syncResponse && syncResponse.success) {
      syncResult.className = 'test-result success';
      syncResult.textContent = `Synced ${syncResponse.synced} messages to database.`;
    } else {
      throw new Error(syncResponse?.error || 'Sync failed');
    }

    syncResult.classList.remove('hidden');
    await loadSyncStatus();

  } catch (error) {
    console.error('Force resync failed:', error);
    syncResult.className = 'test-result error';
    syncResult.textContent = `Resync failed: ${error.message}`;
    syncResult.classList.remove('hidden');
  } finally {
    forceSyncBtn.disabled = false;
    forceSyncBtn.textContent = 'Force Resync All Messages';
  }
}

// DOM elements — Retrieval Health
const embeddingCBStatus = document.getElementById('embeddingCBStatus');
const hydeCBStatus = document.getElementById('hydeCBStatus');
const jinaCBStatus = document.getElementById('jinaCBStatus');

/**
 * Load and display circuit breaker status
 */
async function loadCircuitBreakerStatus() {
  const CB_KEYS = [
    { key: 'kyt_embedding_circuit_breaker', el: embeddingCBStatus, label: 'Embeddings' },
    { key: 'kyt_hyde_circuit_breaker', el: hydeCBStatus, label: 'HyDE' },
    { key: 'kyt_jina_circuit_breaker', el: jinaCBStatus, label: 'Jina' },
  ];

  try {
    const keys = CB_KEYS.map(cb => cb.key);
    const result = await chrome.storage.local.get(keys);

    for (const cb of CB_KEYS) {
      const state = result[cb.key];
      if (!state || !state.isOpen) {
        cb.el.innerHTML = statusHTML('status-dot--ok', 'OK');
      } else {
        const elapsed = Date.now() - state.openedAt;
        const remaining = Math.max(0, state.cooldownMs - elapsed);
        if (remaining <= 0) {
          cb.el.innerHTML = statusHTML('status-dot--warn', 'Probing');
        } else {
          const remainingSec = Math.ceil(remaining / 1000);
          const display = remainingSec >= 60
            ? `${Math.ceil(remainingSec / 60)}m`
            : `${remainingSec}s`;
          cb.el.innerHTML = statusHTML('status-dot--error', `OPEN (${display})`);
        }
      }
    }
  } catch (error) {
    console.error('Error loading CB status:', error);
  }
}

/**
 * Load and display current memory mode
 */
async function loadMemoryMode() {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'GET_MEMORY_MODE' });
    if (response && response.success) {
      const radio = document.querySelector(`input[name="memoryMode"][value="${response.mode}"]`);
      if (radio) radio.checked = true;
    }
  } catch (error) {
    console.error('Error loading memory mode:', error);
    const radio = document.querySelector('input[name="memoryMode"][value="full"]');
    if (radio) radio.checked = true;
  }
}

// DOM elements — Your Data section
const viewMemoriesBtn = document.getElementById('viewMemoriesBtn');
const exportDataBtn = document.getElementById('exportDataBtn');
const deleteAllBtn = document.getElementById('deleteAllBtn');
const dataResult = document.getElementById('dataResult');

/**
 * Open the Memory Management page
 */
function openMemories() {
  chrome.tabs.create({ url: chrome.runtime.getURL('popup/memories.html') });
}

/**
 * Export all user data as JSON
 */
async function handleExportData() {
  exportDataBtn.disabled = true;
  exportDataBtn.textContent = 'Exporting...';
  dataResult.classList.add('hidden');

  try {
    const response = await chrome.runtime.sendMessage({ type: 'EXPORT_MY_DATA' });
    if (!response?.success) throw new Error(response?.error || 'Export failed');

    const json = JSON.stringify(response.data, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = `kyt-data-export-${new Date().toISOString().slice(0,10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    const counts = Object.entries(response.data)
      .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.length : '?'}`)
      .join(', ');
    dataResult.className = 'test-result success';
    dataResult.textContent = `Export complete: ${counts}`;
    dataResult.classList.remove('hidden');
  } catch (error) {
    dataResult.className = 'test-result error';
    dataResult.textContent = `Export failed: ${error.message}`;
    dataResult.classList.remove('hidden');
  } finally {
    exportDataBtn.disabled = false;
    exportDataBtn.textContent = 'Download My Data';
  }
}

/**
 * Delete all user data after double confirmation
 */
async function handleDeleteAll() {
  const confirmed = confirm(
    'This will permanently delete ALL your stored conversations, preferences, and entities.\n\n' +
    'This cannot be undone. Are you sure?'
  );
  if (!confirmed) return;

  const doubleConfirmed = confirm(
    'FINAL WARNING: All data will be permanently deleted from K.Y.T. servers.\n\n' +
    'Click OK to proceed.'
  );
  if (!doubleConfirmed) return;

  deleteAllBtn.disabled = true;
  deleteAllBtn.textContent = 'Deleting...';
  dataResult.classList.add('hidden');

  try {
    const response = await chrome.runtime.sendMessage({ type: 'DELETE_ALL_MY_DATA' });
    if (!response?.success) throw new Error(response?.error || 'Deletion failed');

    const counts = Object.entries(response.deleted)
      .filter(([, v]) => typeof v === 'number')
      .map(([k, v]) => `${k}: ${v}`)
      .join(', ');
    dataResult.className = 'test-result success';
    dataResult.textContent = `All data deleted. ${counts}`;
    dataResult.classList.remove('hidden');

    setTimeout(loadStats, 500);
    setTimeout(loadSyncStatus, 500);
  } catch (error) {
    dataResult.className = 'test-result error';
    dataResult.textContent = `Deletion failed: ${error.message}`;
    dataResult.classList.remove('hidden');
  } finally {
    deleteAllBtn.disabled = false;
    deleteAllBtn.textContent = 'Delete All My Data';
  }
}

// Event listeners
forceSyncBtn.addEventListener('click', forceResync);
upgradeBtn.addEventListener('click', handleUpgrade);
manageBillingBtn.addEventListener('click', handleManageBilling);
debugModeToggle.addEventListener('change', saveDebugMode);
testCaptureBtn.addEventListener('click', testCapture);
rescanBtn.addEventListener('click', rescanMessages);
setupBtn.addEventListener('click', openSetup);
importBtn.addEventListener('click', openImport);
viewMemoriesBtn.addEventListener('click', openMemories);
exportDataBtn.addEventListener('click', handleExportData);
deleteAllBtn.addEventListener('click', handleDeleteAll);

// Memory mode change
modeRadios.forEach(radio => {
  radio.addEventListener('change', async (e) => {
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'SET_MEMORY_MODE',
        mode: e.target.value
      });
      if (!response?.success) {
        console.error('Failed to set memory mode:', response?.error);
      }
    } catch (error) {
      console.error('Error setting memory mode:', error);
    }
  });
});

// Auth buttons
signInBtn.addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});
signOutBtnEl.addEventListener('click', async () => {
  await chrome.storage.local.remove(AUTH_SESSION_KEY);
  loadAuthStatus();
  loadConfig();
});

/**
 * Check if this is first install and redirect to import onboarding
 */
async function checkFirstInstallRedirect() {
  try {
    const result = await chrome.storage.local.get(['show_import_onboarding']);
    if (result.show_import_onboarding === true) {
      window.location.href = 'import-modal.html?mode=first-install';
      return true;
    }
  } catch (error) {
    console.error('Error checking first install:', error);
  }
  return false;
}

// Initial load
checkFirstInstallRedirect().then(redirecting => {
  if (!redirecting) {
    initHeaderScanner();
    loadAuthStatus();
    loadMemoryMode();
    loadProfile();
    loadStats();
    loadConfig();
    loadDebugMode();
    loadSubscription();
    loadSyncStatus();
    loadCircuitBreakerStatus();

    setInterval(() => {
      loadStats();
      loadSyncStatus();
      loadCircuitBreakerStatus();
    }, 5000);
  }
});
