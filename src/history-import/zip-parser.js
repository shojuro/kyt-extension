import JSZip from '../lib/jszip-wrapper.js';

/**
 * @typedef {import('./types.js').Platform} Platform
 * @typedef {import('./types.js').Message} Message
 */

/**
 * Parse ZIP export
 * @param {File} file 
 * @param {Platform} platform 
 * @returns {Promise<Message[]>}
 */
export async function parseZipExport(file, platform) {
    const zip = await JSZip.loadAsync(file);

    if (platform === 'chatgpt') {
        return parseChatGPTZip(zip);
    } else {
        return parseClaudeZip(zip);
    }
}

/**
 * Parse ChatGPT ZIP
 * @param {JSZip} zip 
 * @returns {Promise<Message[]>}
 */
async function parseChatGPTZip(zip) {
    const file = zip.file('conversations.json');
    if (!file) {
        throw new Error('conversations.json not found in ZIP');
    }

    const content = await file.async('string');
    const conversations = JSON.parse(content);
    const messages = [];

    for (const conv of conversations) {
        const mapping = conv.mapping;
        if (!mapping) continue;

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

            const textContent = contentParts
                .filter((p) => typeof p === 'string' && p.trim().length > 0)
                .join('\n')
                .trim();

            if (!textContent) continue;

            messages.push({
                id: msg.id || nodeId,
                conversationId: conv.id || conv.conversation_id,
                conversationTitle: conv.title || 'Untitled',
                content: textContent,
                role: role,
                timestamp: (msg.create_time || conv.create_time) * 1000,
                platform: 'chatgpt',
                model: msg.metadata?.model_slug
            });
        }
    }

    return messages.sort((a, b) => a.timestamp - b.timestamp);
}

/**
 * Parse Claude ZIP
 * @param {JSZip} zip 
 * @returns {Promise<Message[]>}
 */
async function parseClaudeZip(zip) {
    const messages = [];

    // Try root conversations.json first
    const rootFile = zip.file('conversations.json');
    if (rootFile) {
        const content = await rootFile.async('string');
        const conversations = JSON.parse(content);

        for (const conv of conversations) {
            if (!conv.chat_messages) continue;

            for (const msg of conv.chat_messages) {
                const text = msg.text?.trim();
                if (!text) continue;

                const role = msg.sender === 'human' ? 'user' : 'assistant';

                messages.push({
                    id: msg.uuid,
                    conversationId: conv.uuid,
                    conversationTitle: conv.name || 'Untitled',
                    content: text,
                    role: role,
                    timestamp: new Date(msg.created_at).getTime(),
                    platform: 'claude'
                });
            }
        }
        return messages.sort((a, b) => a.timestamp - b.timestamp);
    }

    // Fallback: individual files in conversations/ folder
    const conversationsFolder = zip.folder('conversations');
    if (conversationsFolder) {
        const filePromises = [];

        conversationsFolder.forEach((path, file) => {
            if (path.endsWith('.json') && !path.includes('/')) {
                filePromises.push(file.async('string'));
            }
        });

        const fileContents = await Promise.all(filePromises);

        for (const content of fileContents) {
            try {
                const conv = JSON.parse(content);
                if (!conv.chat_messages) continue;

                for (const msg of conv.chat_messages) {
                    const text = msg.text?.trim();
                    if (!text) continue;

                    const role = msg.sender === 'human' ? 'user' : 'assistant';

                    messages.push({
                        id: msg.uuid,
                        conversationId: conv.uuid,
                        conversationTitle: conv.name || 'Untitled',
                        content: text,
                        role: role,
                        timestamp: new Date(msg.created_at).getTime(),
                        platform: 'claude'
                    });
                }
            } catch (e) {
                console.warn('Failed to parse conversation file:', e);
            }
        }

        return messages.sort((a, b) => a.timestamp - b.timestamp);
    }

    throw new Error('No valid conversations found in Claude export');
}
