/**
 * @typedef {import('./types.js').ImportProgress} ImportProgress
 * @typedef {import('./types.js').Platform} Platform
 */

export class ProgressTracker {
    /**
     * @param {string} supabaseUrl
     * @param {string} supabaseKey
     * @param {string} userId 
     * @param {Platform} platform 
     */
    constructor(supabaseUrl, supabaseKey, userId, platform) {
        this.supabaseUrl = supabaseUrl;
        this.supabaseKey = supabaseKey;
        this.progress = {
            importId: crypto.randomUUID(),
            userId,
            platform,
            status: 'pending',
            conversationsTotal: 0,
            conversationsProcessed: 0,
            messagesImported: 0,
            messagesSkipped: 0,
            lastConversationId: null,
            estimatedCostUsd: 0,
            startedAt: null,
            errorMessage: null
        };
        this.syncInterval = null;
    }

    async initialize() {
        // Check for existing in-progress import (resume scenario)
        try {
            const response = await fetch(
                `${this.supabaseUrl}/rest/v1/user_history_imports?user_id=eq.${this.progress.userId}&platform=eq.${this.progress.platform}&status=eq.in_progress&limit=1`,
                {
                    headers: {
                        'apikey': this.supabaseKey,
                        'Authorization': `Bearer ${this.supabaseKey}`,
                        'Content-Type': 'application/json'
                    }
                }
            );

            if (response.ok) {
                const data = await response.json();
                if (data && data.length > 0) {
                    const existing = data[0];
                    // Resume from previous import
                    this.progress = {
                        importId: existing.id,
                        userId: existing.user_id,
                        platform: existing.platform,
                        status: existing.status,
                        conversationsTotal: existing.conversations_total,
                        conversationsProcessed: existing.conversations_processed,
                        messagesImported: existing.messages_imported,
                        messagesSkipped: existing.messages_skipped,
                        lastConversationId: existing.last_conversation_id,
                        estimatedCostUsd: existing.estimated_cost_usd,
                        startedAt: existing.started_at,
                        errorMessage: existing.error_message
                    };
                } else {
                    // Create new import record
                    await this.syncToServer();
                }
            }
        } catch (e) {
            console.error('Failed to check existing import:', e);
            // Fallback to new import if check fails
            await this.syncToServer();
        }

        // Start periodic sync (every 5 seconds)
        this.syncInterval = setInterval(() => this.syncToServer(), 5000);
    }

    /**
     * @param {Partial<ImportProgress>} updates 
     */
    async update(updates) {
        Object.assign(this.progress, updates);

        // Also save to local storage for crash recovery
        await chrome.storage.local.set({
            import_progress: this.progress
        });
    }

    async syncToServer() {
        try {
            // Route through Edge Function to bypass RLS (uses service role key)
            const response = await fetch(
                `${this.supabaseUrl}/functions/v1/update_import_progress`,
                {
                    method: 'POST',
                    headers: {
                        'apikey': this.supabaseKey,
                        'Authorization': `Bearer ${this.supabaseKey}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        id: this.progress.importId,
                        user_id: this.progress.userId,
                        platform: this.progress.platform,
                        status: this.progress.status,
                        conversations_total: this.progress.conversationsTotal,
                        conversations_processed: this.progress.conversationsProcessed,
                        messages_imported: this.progress.messagesImported,
                        messages_skipped: this.progress.messagesSkipped,
                        last_conversation_id: this.progress.lastConversationId,
                        estimated_cost_usd: this.progress.estimatedCostUsd,
                        started_at: this.progress.startedAt,
                        error_message: this.progress.errorMessage
                    })
                }
            );

            if (!response.ok) {
                const error = await response.text();
                console.error('Failed to sync progress:', error);
            }
        } catch (e) {
            console.error('Failed to sync progress to server:', e);
        }
    }

    async complete() {
        await this.update({ status: 'completed' });
        await this.syncToServer();
        this.cleanup();
    }

    /**
     * @param {string} error 
     */
    async fail(error) {
        await this.update({ status: 'failed', errorMessage: error });
        await this.syncToServer();
        this.cleanup();
    }

    cleanup() {
        if (this.syncInterval) {
            clearInterval(this.syncInterval);
            this.syncInterval = null;
        }
        chrome.storage.local.remove('import_progress');
    }

    getProgress() {
        return { ...this.progress };
    }

    getResumePoint() {
        return this.progress.lastConversationId;
    }
}
