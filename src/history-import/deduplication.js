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
    // LAYER 1: Client-side batch deduplication
    // This removes duplicates WITHIN the current batch only.
    //
    // LAYER 2: Database-level deduplication (in save_chat_turn_batch Edge Function)
    // The `chat_turns` table has a unique index on (user_id, conversation_id, platform, start_timestamp)
    // via `chat_turns_dedup_idx`. The Edge Function uses ON CONFLICT DO NOTHING to skip
    // any duplicates that already exist in the database from previous imports.
    //
    // This two-layer approach means:
    // - Batch dedup catches obvious duplicates quickly (reduces API calls)
    // - Database constraint catches cross-batch and cross-import duplicates

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
