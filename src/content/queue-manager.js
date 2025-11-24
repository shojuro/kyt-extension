/**
 * KYT Message Queue Manager
 * 
 * Runs in the Content Script.
 * Manages the lifecycle of captured messages:
 * 1. In-memory queue
 * 2. Immediate sync attempt via Service Worker
 * 3. Fallback to encrypted local storage on failure
 */

import { LocalQueueStorage } from '../storage/local-queue.js';
import { deriveKey } from '../utils/crypto.js';

export class MessageQueueManager {
    constructor() {
        this.memoryQueue = new Map();
        this.localQueue = new LocalQueueStorage();
        this.isSyncing = false;
        this.cryptoKey = null;
        this.apiKey = null;
    }

    /**
     * Initialize the queue manager
     * Loads API key to derive encryption key
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
        } catch (error) {
            console.error('❌ [KYT Queue] Initialization failed:', error);
        }
    }

    /**
     * Add captured message to queue and attempt immediate sync
     * @param {Object} messageData - The captured message content
     */
    async capture(messageData) {
        // Create queued message object
        // Flattened structure to match browser-sync.js expectations
        const msgId = `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const queuedMessage = {
            id: msgId, // Used by LocalQueueStorage
            messageId: msgId, // Used by browser-sync.js
            timestamp: Date.now(),
            platform: messageData.platform || 'unknown',
            content: messageData.content, // Flattened: content is now the string
            role: messageData.role,
            conversationId: messageData.conversationId,
            model: messageData.model,
            retryCount: 0
        };

        console.log(`📥 [KYT Queue] Capturing message ${queuedMessage.id}...`);

        // Add to memory queue
        this.memoryQueue.set(queuedMessage.id, queuedMessage);

        // Attempt immediate sync
        await this.processQueue();
    }

    /**
     * Process all messages in memory queue
     */
    async processQueue() {
        if (this.isSyncing) return;
        this.isSyncing = true;

        try {
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
     * Attempt to sync a single message to Supabase via Service Worker
     * @param {Object} message - The queued message
     * @returns {Promise<boolean>} True on success
     */
    async syncMessage(message) {
        try {
            // Check if Service Worker is alive
            // We use a simple ping or just try the message directly
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
            console.warn(`⚠️ [KYT Queue] Service Worker unreachable for ${message.id}:`, error.message);
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
