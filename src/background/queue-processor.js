/**
 * KYT Queue Processor
 * 
 * Runs in the Background Service Worker.
 * Processes the persistent retry queue from chrome.storage.local.
 * Syncs messages to Supabase and handles retries.
 */

import { LocalQueueStorage } from '../storage/local-queue.js';
import { deriveKey } from '../utils/crypto.js';
import { syncToSupabase, syncMessages } from '../browser-sync.js';

export class QueueProcessor {
    constructor() {
        this.localQueue = new LocalQueueStorage();
        this.isProcessing = false;
        this.cryptoKey = null;
        this.apiKey = null;
        this.maxRetries = 3;
    }

    /**
     * Initialize processor with encryption key
     * Called on auth/extension startup
     */
    async initialize() {
        try {
            const result = await chrome.storage.local.get(['api_config']);
            if (result.api_config && result.api_config.openaiKey) {
                this.apiKey = result.api_config.openaiKey;
                this.cryptoKey = await deriveKey(this.apiKey);
                console.log('✅ [KYT Processor] Initialized with derived encryption key');
            } else {
                console.warn('⚠️ [KYT Processor] No API key found, cannot process encrypted queue');
            }
        } catch (error) {
            console.error('❌ [KYT Processor] Initialization failed:', error);
        }
    }

    /**
     * Process all pending items in chrome.storage.local
     * Called on:
     * - Service worker wake
     * - Message from content script
     * - Periodic alarm
     */
    async processQueue() {
        if (this.isProcessing) return { processed: 0, failed: 0, remaining: 0 };
        this.isProcessing = true;

        // Ensure initialized
        if (!this.cryptoKey) {
            await this.initialize();
            if (!this.cryptoKey) {
                this.isProcessing = false;
                return { error: 'No encryption key available' };
            }
        }

        let processed = 0;
        let failed = 0;

        try {
            // Dequeue all items
            const messages = await this.localQueue.dequeueAll(this.cryptoKey);

            if (messages.length === 0) {
                return { processed: 0, failed: 0, remaining: 0 };
            }

            console.log(`🔄 [KYT Processor] Processing ${messages.length} queued messages...`);

            const successfulIds = [];

            for (const message of messages) {
                // Check retry count
                if (message.retryCount >= this.maxRetries) {
                    console.error(`❌ [KYT Processor] Message ${message.id} failed after ${this.maxRetries} retries, dropping.`);
                    // We don't add to successfulIds, but we also don't re-enqueue it.
                    // It effectively gets dropped from the queue (since dequeueAll removes everything from storage, 
                    // and we only write back failed items).
                    // Wait, dequeueAll reads but doesn't clear. We need to explicitly remove successful ones.
                    // Actually, my LocalQueueStorage implementation of dequeueAll DOES NOT clear.
                    // It just reads. So we need to remove successful ones.
                    // For failed ones, we update them.

                    // Let's clarify the logic:
                    // 1. Read all
                    // 2. Try sync
                    // 3. If success -> Remove from storage
                    // 4. If fail -> Update retry count in storage (re-encrypt)

                    // Optimization: Batch removals?
                    // For now, let's process one by one to be safe.

                    // Actually, dropping it means we should remove it too.
                    successfulIds.push(message.id);
                    failed++;
                    continue;
                }

                // Check backoff
                const delay = this.getRetryDelay(message.retryCount);
                if (message.lastAttempt && (Date.now() - message.lastAttempt < delay)) {
                    // Skip this item for now (too soon)
                    continue;
                }

                // Attempt sync
                const success = await this.syncSingle(message);

                if (success) {
                    successfulIds.push(message.id);
                    processed++;
                } else {
                    // Handle failure (update retry count)
                    await this.handleSyncFailure(message);
                    failed++;
                }
            }

            // Remove successful items from queue
            if (successfulIds.length > 0) {
                await this.localQueue.remove(successfulIds);
                console.log(`✅ [KYT Processor] Removed ${successfulIds.length} synced items from queue`);
            }

            const remaining = await this.localQueue.getQueueSize();
            return { processed, failed, remaining };

        } catch (error) {
            console.error('❌ [KYT Processor] Error processing queue:', error);
            return { error: error.message };
        } finally {
            this.isProcessing = false;
        }
    }

    /**
     * Sync single message to Supabase
     * Uses the existing browser-sync module but adapts the input format
     */
    async syncSingle(queuedMessage) {
        try {
            // Adapt queued message to format expected by syncToSupabase
            // syncToSupabase expects array of messages in storage format
            // But it reads from storage itself.
            // We need a way to inject this message or use a lower-level function.

            // Wait, syncToSupabase reads from 'captured_messages' in storage.
            // That's the old "fire-and-forget" path.
            // We need to bypass that and sync this specific message object.

            // Looking at browser-sync.js, syncToSupabase calls getMessagesToSync() which reads storage.
            // It doesn't accept arguments.
            // This is a problem. I need to modify browser-sync.js or duplicate the logic.

            // Better approach:
            // Temporarily write this message to 'captured_messages' and call syncToSupabase?
            // No, that confuses the two queues.

            // I should refactor browser-sync.js to accept a list of messages.
            // Or, I can duplicate the sync logic here since I have the message content.
            // It's safer to refactor browser-sync.js to be reusable.

            // For now, let's assume I can modify browser-sync.js to export a function `syncMessages(messages)`.
            // I will do that as part of the integration step.

            // Let's assume `syncDirectly` exists for now, and I'll implement it in browser-sync.js
            // import { syncDirectly } from '../browser-sync.js';

            // For this file creation, I'll use a placeholder and then update browser-sync.js

            // Actually, I can just import the logic I need.
            // But `syncToSupabase` does a lot (embeddings, chunking, etc).

            // Let's try to use `syncDirectly` which I will add to browser-sync.js
            const result = await syncDirectly([queuedMessage]);

            if (!result.success) {
                throw new Error(result.error || 'Unknown sync error');
            }

            return true;

        } catch (error) {
            console.error(`❌ [KYT Processor] Sync failed for ${queuedMessage.id}:`, error);
            throw error; // Propagate error to background.js
        }
    }

    /**
     * Handle sync failure with exponential backoff
     */
    async handleSyncFailure(message) {
        // Increment retry count
        message.retryCount = (message.retryCount || 0) + 1;
        message.lastAttempt = Date.now();

        // Re-enqueue (overwrite existing)
        // My LocalQueueStorage.enqueue appends.
        // I need to update.
        // Since enqueue appends, and I haven't removed the old one yet...
        // Wait, dequeueAll didn't remove.
        // So if I enqueue, I'll have duplicates?
        // LocalQueueStorage doesn't check for duplicates on enqueue (it blindly pushes).

        // I need `update` method in LocalQueueStorage?
        // Or just remove and re-enqueue.

        await this.localQueue.remove([message.id]);
        await this.localQueue.enqueue(message, this.cryptoKey);

        console.log(`⚠️ [KYT Processor] Re-queued ${message.id} (Retry ${message.retryCount})`);
    }

    /**
     * Calculate retry delay
     */
    getRetryDelay(retryCount) {
        const baseDelay = 1000;
        const maxDelay = 30000;
        const exponentialDelay = baseDelay * Math.pow(2, retryCount);
        const jitter = Math.random() * 1000;
        return Math.min(exponentialDelay + jitter, maxDelay);
    }
}

// Helper to be implemented in browser-sync.js
async function syncDirectly(messages) {
    return syncMessages(messages);
}

export const queueProcessor = new QueueProcessor();
