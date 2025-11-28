import { RateLimiter } from './rate-limiter.js';
import { handleError } from './error-handlers.js';

/**
 * @typedef {import('./types.js').Message} Message
 */

/**
 * @typedef {Object} ChatGPTConversation
 * @property {string} id
 * @property {string} title
 * @property {number} create_time
 * @property {number} update_time
 * @property {Object} mapping
 */

export class ChatGPTFetcher {
    /**
     * @param {RateLimiter} rateLimiter 
     */
    constructor(rateLimiter) {
        this.rateLimiter = rateLimiter;
        this.baseUrl = 'https://chatgpt.com/backend-api';
    }

    /**
     * Fetch all conversations
     * @param {number} maxAgeDays 
     * @param {string|null} resumeFromId 
     * @param {function(string, number): void} onProgress 
     * @returns {Promise<Message[]>}
     */
    async fetchAllConversations(maxAgeDays, resumeFromId, onProgress) {
        const allMessages = [];
        let offset = 0;
        const limit = 28;
        const cutoffDate = Date.now() - (maxAgeDays * 24 * 60 * 60 * 1000);
        let processedCount = 0;
        let resumeFound = resumeFromId === null;

        while (true) {
            await this.rateLimiter.acquire();

            try {
                const response = await fetch(
                    `${this.baseUrl}/conversations?offset=${offset}&limit=${limit}&order=updated`,
                    { credentials: 'include' }
                );

                if (!response.ok) {
                    const resolution = await handleError(response, { attempt: 0 });
                    if (resolution.shouldRetry) continue;
                    if (resolution.fallbackToZip) throw new Error('API failed, fallback required');
                    throw new Error(`API Error: ${response.status}`);
                }

                const data = await response.json();
                const items = data.items || [];

                if (items.length === 0) break;

                for (const conv of items) {
                    const updateTime = conv.update_time * 1000;

                    // Skip if older than cutoff
                    if (updateTime < cutoffDate) {
                        return allMessages; // Done
                    }

                    // Resume logic
                    if (!resumeFound) {
                        if (conv.id === resumeFromId) {
                            resumeFound = true;
                        }
                        continue; // Skip until we find the resume point
                    }

                    // Fetch full conversation details
                    const messages = await this.fetchConversationDetail(conv.id, conv.title);
                    allMessages.push(...messages);

                    processedCount++;
                    onProgress(conv.id, processedCount);
                }

                // Check if the last item in batch is too old
                const oldestInBatch = items[items.length - 1];
                if (oldestInBatch.update_time * 1000 < cutoffDate) break;

                offset += limit;

            } catch (error) {
                const resolution = await handleError(error, { attempt: 0 });
                if (resolution.fallbackToZip) throw error; // Propagate to trigger fallback
                // Otherwise log and continue/break depending on severity
                console.error('Error fetching conversations list:', error);
                break;
            }
        }

        return allMessages;
    }

    /**
     * Fetch conversation detail
     * @param {string} conversationId 
     * @param {string} title 
     * @returns {Promise<Message[]>}
     */
    async fetchConversationDetail(conversationId, title) {
        await this.rateLimiter.acquire();

        try {
            const response = await fetch(
                `${this.baseUrl}/conversation/${conversationId}`,
                { credentials: 'include' }
            );

            if (!response.ok) {
                const resolution = await handleError(response, { conversationId });
                if (resolution.shouldRetry) return this.fetchConversationDetail(conversationId, title); // Simple retry
                return []; // Skip this conversation on error
            }

            const data = await response.json();
            return this.parseConversation(data, title);

        } catch (error) {
            console.error(`Failed to fetch conversation ${conversationId}:`, error);
            return [];
        }
    }

    /**
     * Parse conversation
     * @param {ChatGPTConversation} data 
     * @param {string} title 
     * @returns {Message[]}
     */
    parseConversation(data, title) {
        const messages = [];
        const mapping = data.mapping;

        if (!mapping) return [];

        for (const nodeId in mapping) {
            const node = mapping[nodeId];
            const msg = node.message;

            if (!msg) continue;

            const role = msg.author?.role;
            if (role !== 'user' && role !== 'assistant') continue;

            // Skip hidden/system messages
            if (msg.metadata?.is_visually_hidden_from_conversation) continue;
            if (msg.metadata?.is_user_system_message) continue;

            const contentParts = msg.content?.parts;
            if (!contentParts || !Array.isArray(contentParts)) continue;

            const content = contentParts
                .filter((p) => typeof p === 'string' && p.trim().length > 0)
                .join('\n')
                .trim();

            if (!content) continue;

            messages.push({
                id: msg.id || nodeId,
                conversationId: data.id || data.conversation_id, // Handle both formats
                conversationTitle: title || data.title || 'Untitled',
                content: content,
                role: role,
                timestamp: (msg.create_time || data.create_time) * 1000,
                platform: 'chatgpt',
                model: msg.metadata?.model_slug
            });
        }

        // Sort by timestamp
        return messages.sort((a, b) => a.timestamp - b.timestamp);
    }
}
