import { ChatGPTFetcher } from './chatgpt-fetcher.js';
import { ClaudeFetcher } from './claude-fetcher.js';
import { parseZipExport } from './zip-parser.js';
import { RateLimiter } from './rate-limiter.js';
import { ProgressTracker } from './progress-tracker.js';
import { deduplicateMessages } from './deduplication.js';
import { validateExportFile, sanitizeContent } from './validation.js';

/**
 * @typedef {import('./types.js').Platform} Platform
 * @typedef {import('./types.js').ImportProgress} ImportProgress
 * @typedef {import('./types.js').ImportResult} ImportResult
 * @typedef {import('./types.js').Message} Message
 */

/**
 * @typedef {Object} ImportStatusResult
 * @property {boolean} hasCompletedImport
 * @property {boolean} hasInProgressImport
 * @property {string} [completedAt]
 * @property {number} [messagesImported]
 * @property {ImportProgress} [progress]
 */

export class HistoryImporter {
    /**
     * @param {string} supabaseUrl
     * @param {string} supabaseKey
     * @param {string} userId
     */
    constructor(supabaseUrl, supabaseKey, userId) {
        this.supabaseUrl = supabaseUrl;
        this.supabaseKey = supabaseKey;
        this.userId = userId;
        this.progressTracker = null;
        this.abortController = null;
    }

    /**
     * Check import status
     * @param {Platform} platform 
     * @returns {Promise<ImportStatusResult>}
     */
    async checkImportStatus(platform) {
        // Check for completed imports
        try {
            const completedResponse = await fetch(
                `${this.supabaseUrl}/rest/v1/user_history_imports?user_id=eq.${this.userId}&platform=eq.${platform}&status=eq.completed&order=completed_at.desc&limit=1`,
                {
                    headers: {
                        'apikey': this.supabaseKey,
                        'Authorization': `Bearer ${this.supabaseKey}`,
                        'Content-Type': 'application/json'
                    }
                }
            );

            if (completedResponse.ok) {
                const completed = await completedResponse.json();
                if (completed && completed.length > 0) {
                    return {
                        hasCompletedImport: true,
                        hasInProgressImport: false,
                        completedAt: completed[0].completed_at,
                        messagesImported: completed[0].messages_imported
                    };
                }
            }

            // Check for in-progress imports (resume)
            const inProgressResponse = await fetch(
                `${this.supabaseUrl}/rest/v1/user_history_imports?user_id=eq.${this.userId}&platform=eq.${platform}&status=eq.in_progress&limit=1`,
                {
                    headers: {
                        'apikey': this.supabaseKey,
                        'Authorization': `Bearer ${this.supabaseKey}`,
                        'Content-Type': 'application/json'
                    }
                }
            );

            if (inProgressResponse.ok) {
                const inProgress = await inProgressResponse.json();
                if (inProgress && inProgress.length > 0) {
                    const item = inProgress[0];
                    return {
                        hasCompletedImport: false,
                        hasInProgressImport: true,
                        progress: {
                            importId: item.id,
                            userId: item.user_id,
                            platform: item.platform,
                            status: item.status,
                            conversationsTotal: item.conversations_total,
                            conversationsProcessed: item.conversations_processed,
                            messagesImported: item.messages_imported,
                            messagesSkipped: item.messages_skipped,
                            lastConversationId: item.last_conversation_id,
                            estimatedCostUsd: item.estimated_cost_usd,
                            startedAt: item.started_at,
                            errorMessage: item.error_message
                        }
                    };
                }
            }
        } catch (e) {
            console.error('Failed to check import status:', e);
        }

        return { hasCompletedImport: false, hasInProgressImport: false };
    }

    /**
     * Start import
     * @param {Platform} platform 
     * @param {function(ImportProgress): void} onProgress 
     * @param {function(): Promise<File|null>} onFallbackRequired 
     * @returns {Promise<ImportResult>}
     */
    async startImport(platform, onProgress, onFallbackRequired) {
        this.abortController = new AbortController();
        this.progressTracker = new ProgressTracker(this.supabaseUrl, this.supabaseKey, this.userId, platform);
        await this.progressTracker.initialize();

        const resumePoint = this.progressTracker.getResumePoint();

        try {
            // Update status
            await this.progressTracker.update({
                status: 'in_progress',
                startedAt: new Date().toISOString()
            });
            onProgress(this.progressTracker.getProgress());

            // Try API first
            let messages;
            const fetcher = platform === 'chatgpt'
                ? new ChatGPTFetcher(RateLimiter.forChatGPT())
                : new ClaudeFetcher(RateLimiter.forClaude());

            try {
                messages = await fetcher.fetchAllConversations(90, resumePoint, (conversationId, count) => {
                    this.progressTracker.update({
                        lastConversationId: conversationId,
                        conversationsProcessed: count
                    });
                    onProgress(this.progressTracker.getProgress());
                });
            } catch (apiError) {
                // API failed, try ZIP fallback
                console.log('API failed, requesting ZIP fallback:', apiError);

                const file = await onFallbackRequired();
                if (!file) {
                    throw new Error('Import cancelled by user');
                }

                const validation = await validateExportFile(file, platform);
                if (!validation.valid) {
                    throw new Error(validation.error);
                }

                messages = await parseZipExport(file, platform);
            }

            // Filter by date and deduplicate
            const cutoffDate = Date.now() - (90 * 24 * 60 * 60 * 1000);
            const recentMessages = messages.filter(m => m.timestamp >= cutoffDate);

            const { newMessages, duplicateCount } = await deduplicateMessages(
                recentMessages,
                this.userId
            );

            await this.progressTracker.update({
                messagesSkipped: messages.length - recentMessages.length + duplicateCount
            });

            // Stream to Supabase in batches
            const BATCH_SIZE = 25;
            for (let i = 0; i < newMessages.length; i += BATCH_SIZE) {
                if (this.abortController.signal.aborted) {
                    throw new Error('Import cancelled');
                }

                const batch = newMessages.slice(i, i + BATCH_SIZE);
                await this.processBatch(batch);

                const cost = batch.length * 0.0002;  // $0.0002 per message
                await this.progressTracker.update({
                    messagesImported: this.progressTracker.getProgress().messagesImported + batch.length,
                    estimatedCostUsd: this.progressTracker.getProgress().estimatedCostUsd + cost
                });
                onProgress(this.progressTracker.getProgress());
            }

            await this.progressTracker.complete();
            onProgress(this.progressTracker.getProgress());

            return {
                success: true,
                messagesImported: this.progressTracker.getProgress().messagesImported,
                messagesSkipped: this.progressTracker.getProgress().messagesSkipped,
                duplicatesFound: duplicateCount,
                dateRange: newMessages.length > 0 ? {
                    oldest: new Date(Math.min(...newMessages.map(m => m.timestamp))),
                    newest: new Date(Math.max(...newMessages.map(m => m.timestamp)))
                } : null,
                estimatedCost: this.progressTracker.getProgress().estimatedCostUsd
            };

        } catch (error) {
            await this.progressTracker.fail(error.message);
            onProgress(this.progressTracker.getProgress());

            return {
                success: false,
                messagesImported: this.progressTracker.getProgress().messagesImported,
                messagesSkipped: 0,
                duplicatesFound: 0,
                dateRange: null,
                errors: [error.message]
            };
        }
    }

    async cancelImport() {
        if (this.abortController) {
            this.abortController.abort();
        }
    }

    /**
     * @param {Message[]} messages 
     */
    async processBatch(messages) {
        // Invoke Edge Function via REST
        const response = await fetch(`${this.supabaseUrl}/functions/v1/save_chat_turn_batch`, {
            method: 'POST',
            headers: {
                'apikey': this.supabaseKey,
                'Authorization': `Bearer ${this.supabaseKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                turns: messages.map(m => ({
                    user_id: this.userId,
                    conversation_id: m.conversationId,
                    platform: m.platform,
                    content: sanitizeContent(m.content),
                    role: m.role,
                    timestamp: new Date(m.timestamp).toISOString(),
                    source: 'import',
                    metadata: {
                        originalId: m.id,
                        conversationTitle: m.conversationTitle,
                        model: m.model
                    }
                }))
            })
        });

        if (!response.ok) {
            const error = await response.text();
            throw new Error(`Batch save failed: ${error}`);
        }
    }
}
