/**
 * Sync Controller Module
 * Extracted from background.js — debounced sync scheduling and execution.
 *
 * IMPORTANT (MV3): All imports must be static. No dynamic import().
 */

import { syncToSupabase } from './browser-sync.js';

// ===== DEBOUNCED SYNC SCHEDULING =====
// Replaces per-message immediate sync with batched debounce
let syncDebounceTimer = null;
let syncMaxWaitTimer = null;
const SYNC_DEBOUNCE_MS = 5000;   // 5 seconds after last save
const SYNC_MAX_WAIT_MS = 30000;  // Force sync after 30 seconds of continuous saves

/**
 * Schedule a debounced sync to Supabase.
 * Resets the 5s debounce timer on each call. Forces sync after 30s max-wait.
 * Persists kyt_sync_pending flag for service worker restart recovery.
 */
export function scheduleDebouncedSync() {
  // Persist pending flag for crash recovery
  chrome.storage.local.set({ kyt_sync_pending: true });

  // Reset debounce timer
  if (syncDebounceTimer) {
    clearTimeout(syncDebounceTimer);
  }

  syncDebounceTimer = setTimeout(async () => {
    syncDebounceTimer = null;
    if (syncMaxWaitTimer) {
      clearTimeout(syncMaxWaitTimer);
      syncMaxWaitTimer = null;
    }
    await executeDebouncedSync();
  }, SYNC_DEBOUNCE_MS);

  // Start max-wait timer if not already running
  if (!syncMaxWaitTimer) {
    syncMaxWaitTimer = setTimeout(async () => {
      syncMaxWaitTimer = null;
      if (syncDebounceTimer) {
        clearTimeout(syncDebounceTimer);
        syncDebounceTimer = null;
      }
      await executeDebouncedSync();
    }, SYNC_MAX_WAIT_MS);
  }
}

/**
 * Execute the actual sync (called by debounce/max-wait timers).
 * Uses browser-sync.js which syncs to both messages + chat_turns tables.
 */
export async function executeDebouncedSync() {
  try {
    console.log('🔄 Debounced sync triggered');

    // Always use legacy path (browser-sync.js) — it syncs to BOTH messages + chat_turns
    // and handles its own timestamp-based dedup via getMessagesToSync().
    // Edge path (save_chat_turn_batch) is disabled: it only syncs chat_turns and
    // frequently times out due to server-side AI processing exceeding 30s.
    const syncResult = await syncToSupabase();
    if (syncResult.success) {
      console.log(`✅ Debounced sync: ${syncResult.synced} messages synced (embeddings: ${syncResult.embeddingsGenerated ?? 'n/a'})`);
      chrome.storage.local.remove('kyt_sync_auth_failed');
    } else {
      console.warn('⚠️ Debounced sync failed:', syncResult.error || syncResult.message);
    }
  } catch (err) {
    console.warn('⚠️ Debounced sync error:', err.message);
    // Surface auth failures so UI/popup can detect and display the issue
    if (err.message?.includes('Not authenticated') || err.message?.includes('No authenticated user')) {
      chrome.storage.local.set({
        kyt_sync_auth_failed: { timestamp: Date.now(), error: err.message },
      });
    }
  } finally {
    chrome.storage.local.set({ kyt_sync_pending: false });
  }
}

/**
 * Cancel pending debounce/max-wait timers and flush immediately.
 * Used by sync-before-search and platform-switch flush.
 */
export function cancelTimersAndFlush() {
  if (syncDebounceTimer) { clearTimeout(syncDebounceTimer); syncDebounceTimer = null; }
  if (syncMaxWaitTimer) { clearTimeout(syncMaxWaitTimer); syncMaxWaitTimer = null; }
}
