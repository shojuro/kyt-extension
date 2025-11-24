/**
 * KYT Local Queue Storage
 * 
 * Manages the persistent retry queue in chrome.storage.local.
 * All data is encrypted at rest using the derived session key.
 */

import { encrypt, decrypt } from '../utils/crypto.js';

const STORAGE_KEY = 'kyt_pending_sync_queue';
const MAX_QUEUE_SIZE = 100; // Prevent unbounded growth

export class LocalQueueStorage {
    /**
     * Add encrypted message to local storage queue
     * @param {Object} message - The message object to queue
     * @param {CryptoKey} cryptoKey - The encryption key
     */
    async enqueue(message, cryptoKey) {
        if (!cryptoKey) {
            throw new Error('Cannot enqueue: encryption key missing');
        }

        // Get current queue
        const queue = await this.getRawQueue();

        // Check for overflow
        if (queue.length >= MAX_QUEUE_SIZE) {
            // Remove oldest items (FIFO)
            // Sort by timestamp just in case, though append-only should be sorted
            queue.sort((a, b) => a.timestamp - b.timestamp);
            const removedCount = queue.length - MAX_QUEUE_SIZE + 1; // Remove enough to fit new one
            queue.splice(0, removedCount);
            console.warn(`⚠️ [KYT] Queue overflow, removed ${removedCount} oldest items`);
        }

        // Encrypt message content
        // We encrypt the whole message object to protect metadata too
        const jsonString = JSON.stringify(message);
        const { ciphertext, iv } = await encrypt(jsonString, cryptoKey);

        // Add to queue
        queue.push({
            id: message.id,
            timestamp: message.timestamp,
            ciphertext,
            iv
        });

        // Save back to storage
        await chrome.storage.local.set({ [STORAGE_KEY]: queue });
        console.log(`📥 [KYT] Queued message ${message.id} locally (encrypted)`);
    }

    /**
     * Retrieve and decrypt all pending messages
     * @param {CryptoKey} cryptoKey - The encryption key
     * @returns {Promise<Object[]>} Array of decrypted messages
     */
    async dequeueAll(cryptoKey) {
        if (!cryptoKey) {
            throw new Error('Cannot dequeue: encryption key missing');
        }

        const rawQueue = await this.getRawQueue();
        const decryptedMessages = [];
        const failedIds = [];

        for (const item of rawQueue) {
            try {
                const jsonString = await decrypt(item.ciphertext, item.iv, cryptoKey);
                const message = JSON.parse(jsonString);
                decryptedMessages.push(message);
            } catch (error) {
                console.error(`❌ [KYT] Failed to decrypt queue item ${item.id}:`, error);
                failedIds.push(item.id);
            }
        }

        // If we had decryption failures, remove those items to prevent blocking
        if (failedIds.length > 0) {
            await this.remove(failedIds);
        }

        return decryptedMessages;
    }

    /**
     * Remove successfully synced items by ID
     * @param {string[]} ids - Array of message IDs to remove
     */
    async remove(ids) {
        if (!ids || ids.length === 0) return;

        const idSet = new Set(ids);
        const rawQueue = await this.getRawQueue();

        const newQueue = rawQueue.filter(item => !idSet.has(item.id));

        if (newQueue.length !== rawQueue.length) {
            await chrome.storage.local.set({ [STORAGE_KEY]: newQueue });
            console.log(`🗑️ [KYT] Removed ${rawQueue.length - newQueue.length} items from local queue`);
        }
    }

    /**
     * Get queue size for monitoring
     * @returns {Promise<number>} Current queue size
     */
    async getQueueSize() {
        const queue = await this.getRawQueue();
        return queue.length;
    }

    /**
     * Clear entire queue (for user-initiated reset or logout)
     */
    async clear() {
        await chrome.storage.local.remove([STORAGE_KEY]);
        console.log('🧹 [KYT] Local queue cleared');
    }

    /**
     * Helper: Get raw encrypted queue from storage
     * @returns {Promise<Array>} Raw queue array
     */
    async getRawQueue() {
        const result = await chrome.storage.local.get([STORAGE_KEY]);
        return result[STORAGE_KEY] || [];
    }
}
