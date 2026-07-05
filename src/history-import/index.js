import { ChatGPTFetcher } from './chatgpt-fetcher.js';
import { ClaudeFetcher } from './claude-fetcher.js';
import { GeminiFetcher } from './gemini-fetcher.js';
import { parseZipExport } from './zip-parser.js';
import { RateLimiter, parseRetryAfterMs } from './rate-limiter.js';
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

/** Matches save_chat_turn_batch MAX_BATCH_SIZE — one edge fn call per chunk. */
export const IMPORT_SAVE_CHUNK_SIZE = 50;

export class HistoryImporter {
    /**
     * @param {string} supabaseUrl
     * @param {string} supabaseKey Anon key (sent as `apikey` header)
     * @param {string} userId
     * @param {Object} [options]
     * @param {string} [options.accessToken] User JWT. save_chat_turn_batch rejects
     *   anon-key Bearers with 401 (service-role gate), so imports need this.
     * @param {function(): Promise<string|null>} [options.refreshAccessToken]
     *   Called once on 401 to obtain a fresh JWT before retrying.
     * @param {number} [options.retryBaseDelayMs] Base delay for transient-error
     *   backoff (default 1000; tests pass 1).
     */
    constructor(supabaseUrl, supabaseKey, userId, options = {}) {
        this.supabaseUrl = supabaseUrl;
        this.supabaseKey = supabaseKey;
        this.userId = userId;
        this.accessToken = options.accessToken || null;
        this.refreshAccessToken = options.refreshAccessToken || null;
        this.retryBaseDelayMs = options.retryBaseDelayMs ?? 1000;
        this.progressTracker = null;
        this.abortController = null;
        console.log('[HistoryImporter] Initialized with URL:', this.supabaseUrl, 'User:', this.userId, 'Auth:', this.accessToken ? 'jwt' : 'anon');
    }

    /**
     * Headers for Supabase REST + edge function calls.
     * JWT as Bearer when available (required by the service-role gate and by
     * RLS on user_history_imports); anon key stays as `apikey`.
     */
    authHeaders() {
        return {
            'apikey': this.supabaseKey,
            'Authorization': `Bearer ${this.accessToken || this.supabaseKey}`,
            'Content-Type': 'application/json'
        };
    }

    /**
     * Check import status
     * @param {Platform} platform 
     * @returns {Promise<ImportStatusResult>}
     */
    async checkImportStatus(platform) {
        // Check for completed imports
        try {
            const url = `${this.supabaseUrl}/rest/v1/user_history_imports?user_id=eq.${this.userId}&platform=eq.${platform}&status=eq.completed&order=completed_at.desc&limit=1`;
            console.log('[HistoryImporter] Checking status URL:', url);

            const completedResponse = await fetch(
                url,
                { headers: this.authHeaders() }
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
                { headers: this.authHeaders() }
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
        this.progressTracker = new ProgressTracker(
            this.supabaseUrl, this.supabaseKey, this.userId, platform,
            () => this.authHeaders()
        );
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
            let fetcher;
            if (platform === 'chatgpt') {
                fetcher = new ChatGPTFetcher(RateLimiter.forChatGPT());
            } else if (platform === 'gemini') {
                fetcher = new GeminiFetcher(RateLimiter.forGemini());
            } else {
                fetcher = new ClaudeFetcher(RateLimiter.forClaude());
            }

            const cutoffDate = Date.now() - (90 * 24 * 60 * 60 * 1000);
            let totalImported = 0;
            let totalSkipped = 0;
            let totalCost = 0;
            let totalDuplicates = 0;

            // Streaming handler
            const handleBatch = async (batchMessages) => {
                if (this.abortController.signal.aborted) {
                    throw new Error('Import cancelled');
                }

                // Filter by date
                const recentMessages = batchMessages.filter(m => m.timestamp >= cutoffDate);

                if (recentMessages.length === 0) {
                    return;
                }

                // Deduplicate
                const { newMessages, duplicateCount } = await deduplicateMessages(
                    recentMessages,
                    this.userId
                );

                totalDuplicates += duplicateCount;
                totalSkipped += (batchMessages.length - recentMessages.length + duplicateCount);

                if (newMessages.length > 0) {
                    await this.saveMessagesInChunks(newMessages);

                    const cost = newMessages.length * 0.0002;
                    totalCost += cost;
                    totalImported += newMessages.length;

                    // Update progress immediately
                    await this.progressTracker.update({
                        messagesImported: this.progressTracker.getProgress().messagesImported + newMessages.length,
                        messagesSkipped: this.progressTracker.getProgress().messagesSkipped + duplicateCount,
                        estimatedCostUsd: this.progressTracker.getProgress().estimatedCostUsd + cost
                    });
                    onProgress(this.progressTracker.getProgress());
                }
            };

            try {
                // Pass handleBatch to fetcher
                await fetcher.fetchAllConversations(90, resumePoint, (conversationId, count) => {
                    this.progressTracker.update({
                        lastConversationId: conversationId,
                        conversationsProcessed: count
                    });
                    onProgress(this.progressTracker.getProgress());
                }, handleBatch, (total) => {
                    // Update total count immediately when known
                    this.progressTracker.update({
                        conversationsTotal: total
                    });
                    onProgress(this.progressTracker.getProgress());
                });

            } catch (apiError) {
                // API failed, try ZIP fallback
                console.error('API failed, requesting ZIP fallback:', apiError);

                const file = await onFallbackRequired();
                if (!file) {
                    // If fallback is not handled or cancelled, throw the ORIGINAL error
                    // so the user knows why the API failed.
                    throw new Error(`Import failed: ${apiError.message}`);
                }

                const validation = await validateExportFile(file, platform);
                if (!validation.valid) {
                    throw new Error(validation.error);
                }

                // For ZIP, we still process all at once for now (simpler)
                const zipMessages = await parseZipExport(file, platform);
                await handleBatch(zipMessages);
            }

            await this.progressTracker.complete();
            onProgress(this.progressTracker.getProgress());

            return {
                success: true,
                messagesImported: this.progressTracker.getProgress().messagesImported,
                messagesSkipped: this.progressTracker.getProgress().messagesSkipped,
                duplicatesFound: totalDuplicates,
                dateRange: null,
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
     * Import conversation batch via Edge Function
     * Server-side processing: chunking, HyDE, embeddings
     *
     * @param {Message[]} messages Raw messages to import
     * @param {string} platform Platform (chatgpt, claude)
     * @param {string} [resumeToken] Resume token from partial import
     * @returns {Promise<{success: boolean, status: string, processed: number, inserted: number, resumeToken?: string}>}
     */
    async importConversationBatch(messages, platform, resumeToken = null) {
        const url = `${this.supabaseUrl}/functions/v1/import_conversation_batch`;
        console.log(`[HistoryImporter] Importing ${messages.length} messages via Edge Function`);

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 120000); // 120s timeout

        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: this.authHeaders(),
                body: JSON.stringify({
                    messages: messages.map(m => ({
                        id: m.id,
                        content: m.content,
                        role: m.role,
                        timestamp: m.timestamp,
                        conversation_id: m.conversationId,
                        platform: platform
                    })),
                    user_id: this.userId,
                    platform: platform,
                    resume_token: resumeToken
                }),
                signal: controller.signal
            });
            clearTimeout(timeoutId);

            if (!response.ok) {
                const error = await response.text();
                throw new Error(`Import failed: ${error}`);
            }

            return await response.json();
        } catch (error) {
            clearTimeout(timeoutId);
            if (error.name === 'AbortError') {
                throw new Error('Import batch timed out after 120s');
            }
            throw error;
        }
    }

    /**
     * Import with automatic resume on partial completion
     * Handles Edge Function 150s timeout by auto-resuming from checkpoint
     *
     * @param {Message[]} messages Messages to import
     * @param {string} platform Platform (chatgpt, claude)
     * @param {function({stage: string, attempt: number, remaining?: number}): void} [onProgress] Progress callback
     * @returns {Promise<{success: boolean, inserted: number, skipped: number, attempts: number}>}
     */
    async importWithAutoResume(messages, platform, onProgress = null) {
        const MAX_ATTEMPTS = 10; // 10 * 120s = 20min max for huge imports
        let resumeToken = null;
        let attempts = 0;
        let totalInserted = 0;
        let totalSkipped = 0;

        console.log(`[HistoryImporter] Starting auto-resume import for ${messages.length} messages`);

        while (attempts < MAX_ATTEMPTS) {
            try {
                if (onProgress) {
                    onProgress({
                        stage: attempts === 0 ? 'starting' : 'resuming',
                        attempt: attempts + 1,
                        remaining: null
                    });
                }

                const result = await this.importConversationBatch(messages, platform, resumeToken);

                totalInserted += result.inserted || result.chunks_created || 0;
                totalSkipped += result.skipped || 0;

                if (result.status === 'complete') {
                    console.log(`[HistoryImporter] Import complete after ${attempts + 1} attempt(s)`);
                    return {
                        success: true,
                        inserted: totalInserted,
                        skipped: totalSkipped,
                        attempts: attempts + 1
                    };
                }

                if (result.status === 'partial' && result.resumeToken) {
                    console.log(`[HistoryImporter] Partial completion, resuming... (remaining: ${result.remaining})`);
                    resumeToken = result.resumeToken;
                    attempts++;

                    if (onProgress) {
                        onProgress({
                            stage: 'resuming',
                            attempt: attempts + 1,
                            remaining: result.remaining
                        });
                    }

                    // Brief pause between calls to avoid hammering the server
                    await new Promise(r => setTimeout(r, 1000));
                    continue;
                }

                // Unexpected status - fail
                throw new Error(`Import returned unexpected status: ${result.status}`);
            } catch (error) {
                console.error(`[HistoryImporter] Import attempt ${attempts + 1} failed:`, error);

                // If it's a network error or 504, retry with same token
                if (error.message?.includes('504') || error.message?.includes('timeout')) {
                    attempts++;
                    if (attempts < MAX_ATTEMPTS) {
                        console.log(`[HistoryImporter] Retrying after timeout...`);
                        await new Promise(r => setTimeout(r, 2000));
                        continue;
                    }
                }

                throw error;
            }
        }

        throw new Error(`Import exceeded maximum retries (${MAX_ATTEMPTS})`);
    }

    /**
     * Save messages via save_chat_turn_batch in chunks of IMPORT_SAVE_CHUNK_SIZE.
     * @param {Message[]} messages
     */
    async saveMessagesInChunks(messages) {
        for (let i = 0; i < messages.length; i += IMPORT_SAVE_CHUNK_SIZE) {
            await this.processBatch(messages.slice(i, i + IMPORT_SAVE_CHUNK_SIZE));
        }
    }

    /**
     * Save one batch via the save_chat_turn_batch Edge Function.
     *
     * Retry model (each failure class has its own budget):
     * - 401: refresh the JWT once and retry immediately; auth doesn't heal
     *   via blind retries, so without a refresh it throws right away.
     * - 429: wait per Retry-After (default 30s, cap 120s), up to 5 times —
     *   free tier allows 20 saves/min, so long imports WILL hit this.
     * - Network/5xx: exponential backoff, 3 retries.
     *
     * @param {Message[]} messages
     */
    async processBatch(messages) {
        const url = `${this.supabaseUrl}/functions/v1/save_chat_turn_batch`;
        const MAX_TRANSIENT_RETRIES = 3;
        const MAX_RATE_LIMIT_RETRIES = 5;
        let transientAttempts = 0;
        let rateLimitAttempts = 0;
        let didRefresh = false;

        const body = JSON.stringify({
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
            })),
            // Skip AI processing during import for speed - embeddings/classification
            // will be backfilled later via deferred processing queue
            skip_ai_processing: true
        });

        for (;;) {
            console.log(`[HistoryImporter] Saving batch of ${messages.length} messages to ${url}`);
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 30000); // 30s timeout

            let response = null;
            let networkError = null;
            try {
                response = await fetch(url, {
                    method: 'POST',
                    headers: this.authHeaders(),
                    body,
                    signal: controller.signal
                });
            } catch (error) {
                networkError = error;
            } finally {
                clearTimeout(timeoutId);
            }

            if (response?.ok) return;

            if (response?.status === 401) {
                if (!didRefresh && this.refreshAccessToken) {
                    didRefresh = true;
                    const freshToken = await this.refreshAccessToken();
                    if (freshToken) {
                        this.accessToken = freshToken;
                        console.log('[HistoryImporter] 401 — refreshed token, retrying batch');
                        continue;
                    }
                }
                throw new Error('Batch save failed: authentication required (401). Sign in to K.Y.T. and restart the import.');
            }

            if (response?.status === 429) {
                if (rateLimitAttempts >= MAX_RATE_LIMIT_RETRIES) {
                    throw new Error(`Batch save failed: rate limit persisted after ${MAX_RATE_LIMIT_RETRIES} retries (429)`);
                }
                rateLimitAttempts++;
                const waitMs = parseRetryAfterMs(response.headers?.get?.('Retry-After'));
                console.warn(`[HistoryImporter] Rate limited (429) — waiting ${waitMs}ms (retry ${rateLimitAttempts}/${MAX_RATE_LIMIT_RETRIES})`);
                if (waitMs > 0) {
                    await new Promise(resolve => setTimeout(resolve, waitMs));
                }
                continue;
            }

            const detail = networkError
                ? networkError.message
                : `${response.status} ${await response.text().catch(() => '')}`;
            console.error('[HistoryImporter] Batch save error:', detail);

            if (transientAttempts >= MAX_TRANSIENT_RETRIES) {
                throw new Error(`Batch save failed: ${detail}`);
            }
            const delay = this.retryBaseDelayMs * Math.pow(2, transientAttempts);
            transientAttempts++;
            console.log(`[HistoryImporter] Retrying batch in ${delay}ms...`);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
}
