/**
 * @typedef {import('./types.js').Message} Message
 */

/**
 * @typedef {Object} DeduplicationResult
 * @property {Message[]} newMessages
 * @property {number} duplicateCount
 */

/**
 * Deduplicate messages
 * @param {Message[]} messages 
 * @param {string} userId 
 * @returns {Promise<DeduplicationResult>}
 */
export async function deduplicateMessages(messages, userId) {
    // In a real implementation, we would query the database for existing hashes.
    // For this MVP, we'll assume we want to avoid duplicates within the current import batch
    // and rely on the `chat_turns` table constraints or a separate check if needed.

    const uniqueMessages = [];
    const seenHashes = new Set();
    let duplicateCount = 0;

    for (const msg of messages) {
        const hash = createMessageHash(msg);

        if (seenHashes.has(hash)) {
            duplicateCount++;
        } else {
            uniqueMessages.push(msg);
            seenHashes.add(hash);
        }
    }

    return { newMessages: uniqueMessages, duplicateCount };
}

/**
 * Create message hash
 * @param {Message} msg 
 * @returns {string}
 */
function createMessageHash(msg) {
    // Hash based on platform + timestamp + content prefix
    // Using content prefix (100 chars) handles slight formatting differences
    const data = `${msg.platform}:${msg.timestamp}:${msg.content.slice(0, 100)}`;
    return simpleHash(data);
}

/**
 * Simple hash function
 * @param {string} str 
 * @returns {string}
 */
function simpleHash(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash;
    }
    return hash.toString(36);
}
