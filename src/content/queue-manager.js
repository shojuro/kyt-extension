/**
 * KYT Message Queue Manager
 *
 * Runs in the Content Script.
 * Manages the lifecycle of captured messages:
 * 1. In-memory queue
 * 2. Immediate sync attempt via Service Worker
 * 3. Fallback to encrypted local storage on failure
 * 4. Recovery mechanism when service worker wakes up
 *
 * Handles Chrome MV3 service worker termination gracefully:
 * - Detects context invalidation (chrome.runtime.id undefined)
 * - Falls back to local storage when service worker unreachable
 * - Retries pending queue when context is restored
 */

import { LocalQueueStorage } from '../storage/local-queue.js';
import { deriveKey } from '../utils/crypto.js';
import { normalizePlatform } from '../utils/normalize-platform.js';

// Storage key for unencrypted fallback queue (edge case: no API key)
const UNENCRYPTED_QUEUE_KEY = 'kyt_pending_unencrypted_queue';

// localStorage key for EMERGENCY fallback when chrome.storage is completely unavailable
// This is the ONLY reliable storage when extension context is fully invalidated
const LOCALSTORAGE_EMERGENCY_KEY = 'kyt_emergency_localStorage_queue';
const LOCALSTORAGE_MAX_SIZE = 50; // Keep localStorage usage reasonable

// Circuit breaker configuration
const CIRCUIT_BREAKER_THRESHOLD = 5;  // Open circuit after 5 consecutive failures
const CIRCUIT_BREAKER_RESET_MS = 10000; // Auto-reset after 10 seconds

export class MessageQueueManager {
    constructor() {
        this.memoryQueue = new Map();
        this.localQueue = new LocalQueueStorage();
        this.isSyncing = false;
        this.cryptoKey = null;
        this.apiKey = null;
        this.contextValid = true;
        this.recoveryIntervalId = null;
        this.userNotified = false; // Track if we've already notified the user
        this.contextInvalidatedCount = 0; // Consecutive checks showing invalid context

        // Circuit breaker state
        this.consecutiveFailures = 0;
        this.circuitOpen = false;
        this.circuitOpenTime = null;
    }

    /**
     * Show a non-intrusive notification to the user when context is invalidated
     * This helps them understand why capture may be failing
     */
    showContextInvalidatedNotification() {
        // Only show once per session to avoid spam
        if (this.userNotified) return;
        this.userNotified = true;

        // Create toast notification element
        const toast = document.createElement('div');
        toast.id = 'kyt-context-notification';
        toast.style.cssText = `
            position: fixed;
            bottom: 20px;
            right: 20px;
            background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
            color: #fff;
            padding: 16px 24px;
            border-radius: 12px;
            box-shadow: 0 4px 20px rgba(0,0,0,0.3);
            z-index: 999999;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            font-size: 14px;
            max-width: 320px;
            border: 1px solid rgba(255,255,255,0.1);
            animation: kyt-slide-in 0.3s ease-out;
        `;
        toast.innerHTML = `
            <style>
                @keyframes kyt-slide-in {
                    from { transform: translateX(100%); opacity: 0; }
                    to { transform: translateX(0); opacity: 1; }
                }
                #kyt-context-notification button {
                    background: #4a90d9;
                    border: none;
                    color: white;
                    padding: 8px 16px;
                    border-radius: 6px;
                    cursor: pointer;
                    margin-top: 12px;
                    font-size: 13px;
                    transition: background 0.2s;
                }
                #kyt-context-notification button:hover {
                    background: #357abd;
                }
                #kyt-context-notification .kyt-dismiss {
                    position: absolute;
                    top: 8px;
                    right: 12px;
                    background: none;
                    border: none;
                    color: #888;
                    cursor: pointer;
                    font-size: 18px;
                    padding: 0;
                    margin: 0;
                }
            </style>
            <button class="kyt-dismiss" onclick="this.parentElement.remove()">×</button>
            <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 8px;">
                <span style="font-size: 24px;">🔄</span>
                <strong style="font-size: 15px;">KYT Extension Updated</strong>
            </div>
            <p style="margin: 0; color: #ccc; line-height: 1.5;">
                Message capture is paused. Refresh this page to resume.
            </p>
            <button onclick="location.reload()">Refresh Page</button>
        `;

        // Remove any existing notification
        const existing = document.getElementById('kyt-context-notification');
        if (existing) existing.remove();

        document.body.appendChild(toast);

        // Auto-dismiss after 30 seconds
        setTimeout(() => {
            const el = document.getElementById('kyt-context-notification');
            if (el) el.remove();
        }, 30000);
    }

    /**
     * Check if extension context is still valid
     * @returns {boolean} True if chrome.runtime.id is defined
     */
    isContextValid() {
        return typeof chrome !== 'undefined' &&
               typeof chrome.runtime !== 'undefined' &&
               typeof chrome.runtime.id !== 'undefined';
    }

    /**
     * Record a storage failure and potentially open the circuit
     */
    recordStorageFailure() {
        this.consecutiveFailures++;
        if (this.consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD && !this.circuitOpen) {
            this.circuitOpen = true;
            this.circuitOpenTime = Date.now();
            console.warn(`🔴 [KYT Queue] Circuit breaker OPEN after ${this.consecutiveFailures} failures. Pausing captures for ${CIRCUIT_BREAKER_RESET_MS / 1000}s`);
        }
    }

    /**
     * Record a storage success and reset the circuit
     */
    recordStorageSuccess() {
        if (this.consecutiveFailures > 0) {
            console.log(`✅ [KYT Queue] Storage success, resetting failure counter (was ${this.consecutiveFailures})`);
        }
        this.consecutiveFailures = 0;
        if (this.circuitOpen) {
            console.log(`🟢 [KYT Queue] Circuit breaker CLOSED - resuming normal operation`);
            this.circuitOpen = false;
            this.circuitOpenTime = null;
        }
    }

    /**
     * Check if circuit breaker allows operations
     * Auto-resets after timeout period
     * @returns {boolean} True if operations are allowed
     */
    isCircuitClosed() {
        if (!this.circuitOpen) return true;

        // Check if enough time has passed to auto-reset
        const elapsed = Date.now() - this.circuitOpenTime;
        if (elapsed >= CIRCUIT_BREAKER_RESET_MS) {
            console.log(`🟡 [KYT Queue] Circuit breaker auto-reset after ${elapsed}ms`);
            this.circuitOpen = false;
            this.circuitOpenTime = null;
            this.consecutiveFailures = 0;
            return true;
        }

        return false;
    }

    /**
     * Initialize the queue manager
     * Loads API key to derive encryption key
     * Starts recovery interval for context restoration
     */
    async initialize() {
        try {
            const result = await chrome.storage.local.get(['api_config']);
            if (result.api_config && result.api_config.openaiKey) {
                this.apiKey = result.api_config.openaiKey;
                this.cryptoKey = await deriveKey(this.apiKey);
                console.log('✅ [KYT Queue] Initialized with derived encryption key');
            } else {
                console.info('ℹ️ [KYT Queue] No API key found - Local capture only (Sync disabled)');
            }

            // Start recovery interval to retry pending messages when context is restored
            this.startRecoveryInterval();
        } catch (error) {
            console.error('❌ [KYT Queue] Initialization failed:', error);
        }
    }

    /**
     * Start periodic check for context restoration and retry pending messages
     * Runs every 30 seconds to check if service worker is back
     */
    startRecoveryInterval() {
        if (this.recoveryIntervalId) {
            clearInterval(this.recoveryIntervalId);
        }

        this.recoveryIntervalId = setInterval(async () => {
            // Check if context was invalid but is now restored
            const wasInvalid = !this.contextValid;
            this.contextValid = this.isContextValid();

            if (wasInvalid && this.contextValid) {
                console.log('🔄 [KYT Queue] Context restored! Retrying pending messages...');
                this.contextInvalidatedCount = 0;
                await this.retryPendingQueue();
            } else if (this.contextValid) {
                this.contextInvalidatedCount = 0;
                // Context is valid, check if there are pending messages to sync
                const queueSize = await this.localQueue.getQueueSize();
                const unencryptedSize = await this.getUnencryptedQueueSize();

                if (queueSize > 0 || unencryptedSize > 0) {
                    console.log(`🔄 [KYT Queue] Found ${queueSize + unencryptedSize} pending messages, attempting sync...`);
                    await this.retryPendingQueue();
                }
            } else {
                // Context is still invalid — track consecutive failures
                this.contextInvalidatedCount++;
                // After 6 consecutive invalid checks (30s), stop the interval.
                // Extension reload re-injects content.js which creates a new QueueManager.
                if (this.contextInvalidatedCount >= 6) {
                    console.warn('🛑 [KYT Queue] Context invalid for 30s — stopping recovery interval. Refresh page to restore.');
                    clearInterval(this.recoveryIntervalId);
                    this.recoveryIntervalId = null;
                    this.showContextInvalidatedNotification();
                }
            }
        }, 5000); // Every 5 seconds (reduced from 30s for faster recovery)

        console.log('✅ [KYT Queue] Recovery interval started (5s)');
    }

    /**
     * Get size of unencrypted fallback queue
     * @returns {Promise<number>}
     */
    async getUnencryptedQueueSize() {
        try {
            const result = await chrome.storage.local.get([UNENCRYPTED_QUEUE_KEY]);
            return (result[UNENCRYPTED_QUEUE_KEY] || []).length;
        } catch {
            return 0;
        }
    }

    /**
     * Add captured message to queue and attempt immediate sync
     * @param {Object} messageData - The captured message content
     */
    async capture(messageData) {
        // Circuit breaker check - drop messages when circuit is open
        if (!this.isCircuitClosed()) {
            console.warn(`🔴 [KYT Queue] Circuit OPEN - dropping message (will reset in ${Math.ceil((CIRCUIT_BREAKER_RESET_MS - (Date.now() - this.circuitOpenTime)) / 1000)}s)`);
            return;
        }

        // Create queued message object
        // Flattened structure to match browser-sync.js expectations
        const msgId = `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const queuedMessage = {
            id: msgId, // Used by LocalQueueStorage
            messageId: msgId, // Used by browser-sync.js
            timestamp: Date.now(),
            platform: normalizePlatform(messageData.platform),
            content: messageData.content, // Flattened: content is now the string
            role: messageData.role,
            conversationId: messageData.conversationId,
            model: messageData.model,
            retryCount: 0
        };

        console.log(`📥 [KYT Queue] Capturing message ${queuedMessage.id}...`);

        // Check if context is valid before attempting sync
        this.contextValid = this.isContextValid();

        if (!this.contextValid) {
            // Context invalidated - persist directly without trying service worker
            console.warn('⚠️ [KYT Queue] Context invalid, persisting directly to local storage');
            await this.persistDirectly(queuedMessage);
            return;
        }

        // Add to memory queue
        this.memoryQueue.set(queuedMessage.id, queuedMessage);

        // Attempt immediate sync
        await this.processQueue();
    }

    /**
     * Persist message directly to local storage without attempting service worker sync
     * Used when context is known to be invalid
     * Falls back to window.localStorage when chrome.storage is unavailable
     * @param {Object} message - The message to persist
     */
    async persistDirectly(message) {
        // Fast-path: when extension context is invalid, chrome.storage object still
        // exists but operations throw. Check chrome.runtime.id as the true signal.
        if (!this.isContextValid()) {
            try {
                this.persistToWebStorage(message);
            } catch (e) {
                console.error('❌ [KYT Queue] All persistence methods failed:', e);
            }
            return;
        }

        try {
            if (this.cryptoKey) {
                // Encrypted storage
                await this.localQueue.enqueue(message, this.cryptoKey);
                console.log(`📥 [KYT Queue] Persisted ${message.id} to encrypted local storage`);
            } else {
                // Unencrypted fallback - better than losing the message
                await this.persistUnencrypted(message);
                console.log(`📥 [KYT Queue] Persisted ${message.id} to unencrypted fallback storage`);
            }
            // Storage succeeded - reset circuit breaker
            this.recordStorageSuccess();
        } catch (error) {
            // chrome.storage failed - likely context is fully invalidated
            this.recordStorageFailure();
            console.warn(`⚠️ [KYT Queue] chrome.storage failed for ${message.id}, falling back to localStorage`);
            try {
                this.persistToWebStorage(message);
                console.log(`💾 [KYT Queue] Persisted ${message.id} to emergency localStorage`);
            } catch (e) {
                console.error('❌ [KYT Queue] All persistence methods failed:', e);
            }
        }
    }

    /**
     * EMERGENCY fallback: Persist to window.localStorage
     * This works even when Chrome extension context is completely invalidated
     * Messages stored here will be recovered when context is restored
     * @param {Object} message - The message to store
     */
    persistToWebStorage(message) {
        try {
            // Read existing queue from localStorage
            const stored = window.localStorage.getItem(LOCALSTORAGE_EMERGENCY_KEY);
            const queue = stored ? JSON.parse(stored) : [];

            // Prevent duplicates
            if (queue.some(m => m.id === message.id)) {
                console.log(`ℹ️ [KYT Queue] Message ${message.id} already in localStorage queue`);
                return;
            }

            // Limit queue size to prevent localStorage bloat
            while (queue.length >= LOCALSTORAGE_MAX_SIZE) {
                const removed = queue.shift();
                console.warn(`⚠️ [KYT Queue] localStorage overflow, removed oldest: ${removed.id}`);
            }

            // Add message (unencrypted - localStorage can't use crypto APIs reliably here)
            queue.push({
                ...message,
                emergencyStorage: true,
                storedAt: Date.now()
            });

            window.localStorage.setItem(LOCALSTORAGE_EMERGENCY_KEY, JSON.stringify(queue));
        } catch (e) {
            // localStorage might also fail (private mode, quota exceeded)
            console.error('❌ [KYT Queue] localStorage fallback failed:', e);
            throw e;
        }
    }

    /**
     * Recover messages from emergency localStorage and migrate to chrome.storage
     * Called when context is restored
     * @returns {Promise<number>} Number of messages recovered
     */
    async recoverFromWebStorage() {
        try {
            const stored = window.localStorage.getItem(LOCALSTORAGE_EMERGENCY_KEY);
            if (!stored) return 0;

            const queue = JSON.parse(stored);
            if (queue.length === 0) return 0;

            console.log(`🔄 [KYT Queue] Found ${queue.length} messages in emergency localStorage`);

            let syncedCount = 0;
            const remaining = [];

            for (const message of queue) {
                // Try to sync each message
                const success = await this.syncMessage(message);
                if (success) {
                    syncedCount++;
                } else {
                    remaining.push(message);
                }
            }

            // Update localStorage with remaining (failed) messages
            if (remaining.length > 0) {
                window.localStorage.setItem(LOCALSTORAGE_EMERGENCY_KEY, JSON.stringify(remaining));
            } else {
                // All synced - clear localStorage
                window.localStorage.removeItem(LOCALSTORAGE_EMERGENCY_KEY);
            }

            if (syncedCount > 0) {
                console.log(`✅ [KYT Queue] Recovered ${syncedCount} messages from emergency localStorage`);
            }

            return syncedCount;
        } catch (e) {
            console.error('❌ [KYT Queue] Failed to recover from localStorage:', e);
            return 0;
        }
    }

    /**
     * Store message in unencrypted local storage (fallback for edge cases)
     * Falls back to window.localStorage if chrome.storage fails
     * @param {Object} message - The message to store
     */
    async persistUnencrypted(message) {
        // Guard: when context is invalid, chrome.storage operations throw
        if (!this.isContextValid()) {
            this.persistToWebStorage(message);
            return;
        }
        try {
            const result = await chrome.storage.local.get([UNENCRYPTED_QUEUE_KEY]);
            const queue = result[UNENCRYPTED_QUEUE_KEY] || [];

            // Limit queue size
            if (queue.length >= 100) {
                queue.shift(); // Remove oldest
            }

            queue.push(message);
            await chrome.storage.local.set({ [UNENCRYPTED_QUEUE_KEY]: queue });
        } catch (error) {
            // chrome.storage failed - fall back to localStorage
            console.warn('⚠️ [KYT Queue] chrome.storage.local failed, using localStorage fallback');
            this.persistToWebStorage(message);
        }
    }

    /**
     * Process all messages in memory queue
     */
    async processQueue() {
        if (this.isSyncing) return;
        this.isSyncing = true;

        try {
            // Re-check context validity
            this.contextValid = this.isContextValid();

            if (!this.contextValid) {
                // Context invalid - persist all memory queue items directly
                console.warn('⚠️ [KYT Queue] Context invalid during processQueue, persisting all to local storage');
                for (const [id, message] of this.memoryQueue.entries()) {
                    await this.persistDirectly(message);
                    this.memoryQueue.delete(id);
                }
                return;
            }

            // Process all items in memory queue
            for (const [id, message] of this.memoryQueue.entries()) {
                const success = await this.syncMessage(message);

                if (success) {
                    // Success: Remove from memory
                    this.memoryQueue.delete(id);
                } else {
                    // Failure: Persist to local storage and remove from memory
                    await this.persistToLocalStorage(message);
                    this.memoryQueue.delete(id);
                }
            }
        } finally {
            this.isSyncing = false;
        }
    }

    /**
     * Retry syncing all pending messages from local storage
     * Called when context is restored or periodically
     */
    async retryPendingQueue() {
        if (!this.isContextValid()) {
            console.log('🔄 [KYT Queue] Context still invalid, skipping retry');
            return;
        }

        try {
            let syncedCount = 0;
            const syncedIds = [];

            // Process encrypted queue
            if (this.cryptoKey) {
                const pendingMessages = await this.localQueue.dequeueAll(this.cryptoKey);

                for (const message of pendingMessages) {
                    const success = await this.syncMessage(message);
                    if (success) {
                        syncedIds.push(message.id);
                        syncedCount++;
                    }
                }

                // Remove successfully synced messages
                if (syncedIds.length > 0) {
                    await this.localQueue.remove(syncedIds);
                }
            }

            // Process unencrypted fallback queue
            const unencryptedResult = await chrome.storage.local.get([UNENCRYPTED_QUEUE_KEY]);
            const unencryptedQueue = unencryptedResult[UNENCRYPTED_QUEUE_KEY] || [];

            if (unencryptedQueue.length > 0) {
                const remainingUnencrypted = [];

                for (const message of unencryptedQueue) {
                    const success = await this.syncMessage(message);
                    if (success) {
                        syncedCount++;
                    } else {
                        remainingUnencrypted.push(message);
                    }
                }

                // Update unencrypted queue with remaining items
                await chrome.storage.local.set({ [UNENCRYPTED_QUEUE_KEY]: remainingUnencrypted });
            }

            if (syncedCount > 0) {
                console.log(`✅ [KYT Queue] Recovered ${syncedCount} pending messages`);
            }
        } catch (error) {
            console.error('❌ [KYT Queue] Retry pending queue failed:', error);
        }
    }

    /**
     * Attempt to sync a single message to Supabase via Service Worker
     * @param {Object} message - The queued message
     * @returns {Promise<boolean>} True on success
     */
    async syncMessage(message) {
        // Pre-check context validity
        if (!this.isContextValid()) {
            console.warn(`⚠️ [KYT Queue] Context invalid, cannot sync ${message.id}`);
            this.contextValid = false;
            this.showContextInvalidatedNotification();
            return false;
        }

        try {
            const response = await chrome.runtime.sendMessage({
                type: 'SAVE_MESSAGE',
                data: message
            });

            if (response && response.success) {
                console.log(`✅ [KYT Queue] Synced message ${message.id}`);
                return true;
            } else {
                console.warn(`⚠️ [KYT Queue] Sync failed for ${message.id}:`, response?.error);
                return false;
            }
        } catch (error) {
            // Detect context invalidation error
            const errorMsg = error.message || '';
            if (errorMsg.includes('Extension context invalidated') ||
                errorMsg.includes('Receiving end does not exist')) {
                console.warn(`⚠️ [KYT Queue] Context invalidated during sync for ${message.id}`);
                this.contextValid = false;
                this.showContextInvalidatedNotification();
            } else {
                console.warn(`⚠️ [KYT Queue] Service Worker unreachable for ${message.id}:`, errorMsg);
            }
            return false;
        }
    }

    /**
     * On sync failure, persist to encrypted chrome.storage.local
     * @param {Object} message - The queued message
     */
    async persistToLocalStorage(message) {
        try {
            // Ensure we have an encryption key
            if (!this.cryptoKey && this.apiKey) {
                this.cryptoKey = await deriveKey(this.apiKey);
            }

            if (!this.cryptoKey) {
                // Try to reload config one last time
                await this.initialize();
                if (!this.cryptoKey) {
                    console.error('❌ [KYT Queue] Cannot persist: No encryption key available');
                    return;
                }
            }

            await this.localQueue.enqueue(message, this.cryptoKey);

            // Attempt to wake service worker to process the queue later
            // We send a 'FLUSH_QUEUE' message which might wake it up
            chrome.runtime.sendMessage({ type: 'FLUSH_QUEUE' }).catch(() => {
                // Ignore error if SW is dead, alarm will pick it up
            });

        } catch (error) {
            console.error(`❌ [KYT Queue] Failed to persist message ${message.id}:`, error);
        }
    }
}

// Create singleton instance
export const queueManager = new MessageQueueManager();
