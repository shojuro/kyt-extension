/**
 * Sync Controller Module
 * Extracted from background.js — debounced sync scheduling and execution.
 *
 * IMPORTANT (MV3): All imports must be static. No dynamic import().
 */

import { syncToSupabase } from './browser-sync.js';
import { syncViaEdgeFunction } from './edge-sync.js';
import { getRoutingMode } from './auth-config.js';

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
 * Uses edge functions for authenticated users, legacy direct API otherwise.
 */
export async function executeDebouncedSync() {
  try {
    console.log('🔄 Debounced sync triggered');
    const mode = await getRoutingMode();

    if (mode === 'edge') {
      // Check rate limit backoff before attempting edge sync
      const rlResult = await chrome.storage.local.get(['kyt_sync_rate_limited']);
      const rl = rlResult.kyt_sync_rate_limited;
      if (rl?.retryAfter && Date.now() < rl.retryAfter) {
        const waitSec = Math.ceil((rl.retryAfter - Date.now()) / 1000);
        console.log(`⏳ Edge sync rate-limited — retrying in ${waitSec}s`);
        setTimeout(() => executeDebouncedSync(), rl.retryAfter - Date.now());
        return;
      }
      // Clear stale rate limit flag
      if (rl) {
        chrome.storage.local.remove('kyt_sync_rate_limited');
      }

      // Edge function path: load messages and sync via server
      const stored = await chrome.storage.local.get(['captured_messages', 'last_sync_status']);
      const messages = stored.captured_messages || [];
      const syncStatus = stored.last_sync_status || { syncedMessageIds: [] };
      const syncedSet = new Set(syncStatus.syncedMessageIds || []);

      // Filter to unsynced messages
      const unsynced = messages.filter((m) => !syncedSet.has(m.messageId));
      if (unsynced.length === 0) {
        console.log('✅ Debounced sync: nothing to sync (all messages already synced)');
        return;
      }

      const syncResult = await syncViaEdgeFunction(unsynced);
      if (syncResult.success || syncResult.synced > 0) {
        // Mark synced
        const newSyncedIds = [...syncedSet, ...unsynced.map((m) => m.messageId)].slice(-100);
        await chrome.storage.local.set({
          last_sync_status: {
            syncedMessageIds: newSyncedIds,
            lastSyncTime: Date.now(),
          },
        });
        console.log(`✅ Debounced sync (edge): ${syncResult.synced} synced, ${syncResult.duplicates} dupes`);
        // Clear auth failure flag on successful sync
        chrome.storage.local.remove('kyt_sync_auth_failed');
      } else {
        console.warn('⚠️ Debounced sync (edge) failed:', syncResult.errors, 'errors');
      }
    } else {
      // Legacy path
      const syncResult = await syncToSupabase();
      if (syncResult.success) {
        console.log(`✅ Debounced sync: ${syncResult.synced} messages synced (embeddings: ${syncResult.embeddingsGenerated ?? 'n/a'})`);
      } else {
        console.warn('⚠️ Debounced sync failed:', syncResult.error);
      }
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
