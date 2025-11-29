import { RateLimiter } from './rate-limiter.js';
import { handleError } from './error-handlers.js';

/**
 * @typedef {import('./types.js').Message} Message
 */

/**
 * @typedef {Object} ClaudeConversation
 * @property {string} uuid
 * @property {string} name
 * @property {string} [summary]
 * @property {string} created_at
 * @property {string} updated_at
 * @property {ClaudeChatMessage[]} [chat_messages]
 */

/**
 * @typedef {Object} ClaudeChatMessage
 * @property {string} uuid
 * @property {string} text
 * @property {'human' | 'assistant'} sender
 * @property {string} created_at
 * @property {string} updated_at
 * @property {any[]} [attachments]
 * @property {any[]} [files]
 */

export class ClaudeFetcher {
    /**
     * @param {RateLimiter} rateLimiter 
     */
    constructor(rateLimiter) {
        this.rateLimiter = rateLimiter;
        this.baseUrl = 'https://claude.ai/api';
    }

    /**
    /**
     * Get organization ID
     * @returns {Promise<string|null>}
     */
    async getOrganizationId() {
        await this.rateLimiter.acquire();
        try {
            const response = await fetch(
                `${this.baseUrl}/organizations`,
                { credentials: 'include' }
            );

            if (!response.ok) return null;

            const orgs = await response.json();
            if (orgs && orgs.length > 0) {
                return orgs[0].uuid;
            }
            return null;
        } catch (error) {
            console.error('Failed to fetch Claude organizations:', error);
            return null;
        }
    }

    /**
     * Fetch all conversations
     * @param {number} maxAgeDays 
     * @param {string} [resumeFromId] 
     * @param {function(string, number): void} [onProgress] 
     * @param {function(Message[]): Promise<void>} [onBatch]
     * @param {function(number): void} [onTotal]
     * @returns {Promise<Message[]>}
     */
    async fetchAllConversations(maxAgeDays, resumeFromId, onProgress, onBatch, onTotal) {
        const orgId = await this.getOrganizationId();
        if (!orgId) throw new Error('Could not find Claude organization');

        const allMessages = [];
        const cutoffDate = Date.now() - (maxAgeDays * 24 * 60 * 60 * 1000);
        let processedCount = 0;

        try {
            const response = await fetch(
                `${this.baseUrl}/organizations/${orgId}/chat_conversations`,
                { credentials: 'include' }
            );

            if (!response.ok) {
                await handleError(response); // Will throw if critical
                return [];
            }

            const conversations = await response.json();
            console.log(`[ClaudeFetcher] Found ${conversations.length} conversations`);

            if (onTotal) {
                onTotal(conversations.length);
            }

            // Find resume point
            let startIndex = 0;
            if (resumeFromId) {
                const index = conversations.findIndex(c => c.uuid === resumeFromId);
                if (index !== -1) {
                    startIndex = index + 1;
                    processedCount = startIndex;
                }
            }

            for (let i = startIndex; i < conversations.length; i++) {
                const conv = conversations[i];

                // Check age
                const updatedAt = new Date(conv.updated_at).getTime();
                if (updatedAt < cutoffDate) {
                    console.log(`[ClaudeFetcher] Skipping old conversation: ${conv.updated_at}`);
                    continue;
                }

                // Fetch details
                const messages = await this.fetchConversationDetail(orgId, conv.uuid, conv.name);

                if (messages.length > 0) {
                    if (onBatch) {
                        await onBatch(messages);
                    } else {
                        allMessages.push(...messages);
                    }
                }

                processedCount++;
                if (onProgress) {
                    onProgress(conv.uuid, processedCount);
                }
            }

        } catch (error) {
            console.error('Error fetching conversations:', error);
            throw error;
        }

        return allMessages;
    }

    /**
     * Fetch conversation detail
     * @param {string} orgId 
     * @param {string} convId 
     * @param {string} title 
     * @returns {Promise<Message[]>}
     */
    async fetchConversationDetail(orgId, convId, title) {
        await this.rateLimiter.acquire();

        try {
            const response = await fetch(
                `${this.baseUrl}/organizations/${orgId}/chat_conversations/${convId}`,
                { credentials: 'include' }
            );

            if (!response.ok) {
                const resolution = await handleError(response, { conversationId: convId });
                if (resolution.shouldRetry) return this.fetchConversationDetail(orgId, convId, title);
                return [];
            }

            const data = await response.json();
            return this.parseConversation(data, title);

        } catch (error) {
            console.error(`Failed to fetch conversation ${convId}:`, error);
            return [];
        }
    }

    /**
     * Parse conversation
     * @param {ClaudeConversation} data 
     * @param {string} title 
     * @returns {Message[]}
     */
    parseConversation(data, title) {
        const messages = [];

        if (!data.chat_messages || data.chat_messages.length === 0) return [];

        for (const msg of data.chat_messages) {
            const content = msg.text?.trim();
            if (!content) continue;

            const role = msg.sender === 'human' ? 'user' : 'assistant';

            messages.push({
                id: msg.uuid,
                conversationId: data.uuid,
                conversationTitle: title || data.name || 'Untitled',
                content: content,
                role: role,
                timestamp: new Date(msg.created_at).getTime(),
                platform: 'claude'
            });
        }

        // Sort by timestamp
        return messages.sort((a, b) => a.timestamp - b.timestamp);
    }
}
