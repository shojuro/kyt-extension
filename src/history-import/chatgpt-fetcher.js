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
     * @param {string} [resumeFromId] 
     * @param {function(string, number): void} [onProgress] 
     * @param {function(Message[]): Promise<void>} [onBatch]
     * @param {function(number): void} [onTotal]
     * @returns {Promise<Message[]>}
     */
    async fetchAllConversations(maxAgeDays, resumeFromId, onProgress, onBatch, onTotal) {
        const allMessages = [];
        const cutoffDate = Date.now() - (maxAgeDays * 24 * 60 * 60 * 1000);

        let offset = 0;
        const limit = 20; // ChatGPT API limit
        let hasMore = true;
        let processedCount = 0;
        let resuming = !!resumeFromId;
        let totalReported = false;

        while (hasMore) {
            await this.rateLimiter.acquire();

            try {
                const response = await fetch(
                    `${this.baseUrl}/conversations?offset=${offset}&limit=${limit}&order=updated`,
                    { credentials: 'include' }
                );

                if (!response.ok) {
                    const resolution = await handleError(response);
                    if (resolution.shouldRetry) continue;
                    break;
                }

                const data = await response.json();
                const conversations = data.items || [];

                if (!totalReported && data.total && onTotal) {
                    onTotal(data.total);
                    totalReported = true;
                }

                if (conversations.length === 0) {
                    hasMore = false;
                    break;
                }

                for (const conv of conversations) {
                    // Handle resume logic
                    if (resuming) {
                        if (conv.id === resumeFromId) {
                            resuming = false;
                        }
                        processedCount++;
                        continue;
                    }

                    // Check age
                    // ChatGPT uses unix timestamp (seconds) or ISO string.
                    // Let's rely on flexible parsing or assume seconds if number.
                    let updateTime = conv.update_time;
                    if (typeof updateTime === 'number' && updateTime < 10000000000) {
                        updateTime *= 1000;
                    }
                    const updatedAt = new Date(updateTime).getTime();

                    if (updatedAt < cutoffDate) {
                        // If sorted by updated, we might be able to stop early?
                        // ChatGPT returns sorted by updated desc.
                        // So if we hit an old one, we can stop?
                        // Yes, if order=updated.
                        hasMore = false;
                        break;
                    }

                    // Fetch details
                    const messages = await this.fetchConversationDetail(conv.id, conv.title);

                    if (messages.length > 0) {
                        if (onBatch) {
                            await onBatch(messages);
                        } else {
                            allMessages.push(...messages);
                        }
                    }

                    processedCount++;
                    if (onProgress) {
                        onProgress(conv.id, processedCount);
                    }
                }

                offset += limit;
                // Safety break
                if (offset > 10000) hasMore = false;

            } catch (error) {
                console.error('Error fetching conversations list:', error);
                throw error;
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
