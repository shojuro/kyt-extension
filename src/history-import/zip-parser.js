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
    } else if (platform === 'gemini') {
        return parseGeminiZip(zip);
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

/**
 * Parse Google Takeout Gemini ZIP.
 *
 * Google Takeout exports Gemini conversations as individual JSON files
 * in a "Gemini Apps/Conversations/" folder. Each file is one conversation
 * with an array of turns.
 *
 * Alternate format: "Gemini Apps/My Gemini Data/conversations.json"
 *
 * @param {JSZip} zip
 * @returns {Promise<Message[]>}
 */
async function parseGeminiZip(zip) {
    const messages = [];

    // Try: Takeout/Gemini Apps/ folder structure
    // Google Takeout nests under "Takeout/Gemini Apps/" or just "Gemini Apps/"
    let conversationsFolder = null;
    const possiblePaths = [
        'Takeout/Gemini Apps/Conversations',
        'Gemini Apps/Conversations',
        'Takeout/Google Gemini/Conversations',
        'Google Gemini/Conversations',
    ];

    for (const path of possiblePaths) {
        const folder = zip.folder(path);
        if (folder) {
            // Check if folder has any files
            let hasFiles = false;
            folder.forEach(() => { hasFiles = true; });
            if (hasFiles) {
                conversationsFolder = folder;
                break;
            }
        }
    }

    if (conversationsFolder) {
        const filePromises = [];
        const filePaths = [];

        conversationsFolder.forEach((path, file) => {
            if (path.endsWith('.json') && !path.includes('/')) {
                filePromises.push(file.async('string'));
                filePaths.push(path);
            }
        });

        const fileContents = await Promise.all(filePromises);

        for (let i = 0; i < fileContents.length; i++) {
            try {
                const data = JSON.parse(fileContents[i]);
                const convTitle = filePaths[i].replace('.json', '') || 'Untitled';
                const convId = `gemini_takeout_${i}`;

                parseGeminiConversationData(data, convId, convTitle, messages);
            } catch (e) {
                console.warn(`Failed to parse Gemini conversation file ${filePaths[i]}:`, e);
            }
        }

        if (messages.length > 0) {
            return messages.sort((a, b) => a.timestamp - b.timestamp);
        }
    }

    // Try: single conversations.json file
    const singleFilePaths = [
        'Takeout/Gemini Apps/conversations.json',
        'Gemini Apps/conversations.json',
        'Takeout/Gemini Apps/My Gemini Data/conversations.json',
    ];

    for (const path of singleFilePaths) {
        const file = zip.file(path);
        if (file) {
            const content = await file.async('string');
            const conversations = JSON.parse(content);

            if (Array.isArray(conversations)) {
                for (let i = 0; i < conversations.length; i++) {
                    const conv = conversations[i];
                    const convId = conv.id || conv.conversation_id || `gemini_${i}`;
                    const convTitle = conv.title || conv.name || 'Untitled';

                    parseGeminiConversationData(conv, convId, convTitle, messages);
                }
            }

            if (messages.length > 0) {
                return messages.sort((a, b) => a.timestamp - b.timestamp);
            }
        }
    }

    // Fallback: scan all JSON files in the ZIP for anything that looks like Gemini data
    const allJsonFiles = [];
    zip.forEach((path, file) => {
        if (path.endsWith('.json') && !path.startsWith('__MACOSX')) {
            allJsonFiles.push({ path, file });
        }
    });

    for (const { path, file } of allJsonFiles) {
        try {
            const content = await file.async('string');
            const data = JSON.parse(content);

            if (Array.isArray(data) && data.length > 0 && data[0].parts) {
                // Looks like Gemini format (array of turns with parts)
                const convId = `gemini_${path}`;
                parseGeminiConversationData(data, convId, path.replace('.json', ''), messages);
            }
        } catch {
            // Not valid JSON
        }
    }

    if (messages.length === 0) {
        throw new Error('No valid conversations found in Gemini export. Expected Google Takeout ZIP with "Gemini Apps" folder.');
    }

    return messages.sort((a, b) => a.timestamp - b.timestamp);
}

/**
 * Parse a single Gemini conversation's data into messages.
 *
 * Google Takeout Gemini format varies but commonly has:
 * - turns/entries with "parts" arrays containing text
 * - "role" field ("user" or "model")
 * - "createTime" or "timestamp" fields
 *
 * @param {any} data - Conversation data (object or array of turns)
 * @param {string} convId
 * @param {string} convTitle
 * @param {Message[]} messages
 */
function parseGeminiConversationData(data, convId, convTitle, messages) {
    // Format 1: data has a "turns" or "messages" array
    const turns = data.turns || data.messages || data.entries || (Array.isArray(data) ? data : null);

    if (!turns || !Array.isArray(turns)) return;

    for (let i = 0; i < turns.length; i++) {
        const turn = turns[i];
        if (!turn) continue;

        // Extract text from parts
        let text = '';
        if (turn.parts && Array.isArray(turn.parts)) {
            text = turn.parts
                .filter(p => p.text || (typeof p === 'string'))
                .map(p => p.text || p)
                .join('\n')
                .trim();
        } else if (turn.text) {
            text = turn.text.trim();
        } else if (turn.content) {
            text = typeof turn.content === 'string' ? turn.content.trim() : '';
        }

        if (!text) continue;

        // Determine role
        let role = 'user';
        if (turn.role === 'model' || turn.role === 'assistant' || turn.role === '1') {
            role = 'assistant';
        } else if (turn.role === 'user' || turn.role === '0') {
            role = 'user';
        } else if (i % 2 === 1) {
            // Fallback: odd turns are typically assistant
            role = 'assistant';
        }

        // Extract timestamp
        let timestamp = null;
        if (turn.createTime) {
            timestamp = new Date(turn.createTime).getTime();
        } else if (turn.timestamp) {
            timestamp = typeof turn.timestamp === 'number'
                ? (turn.timestamp < 10000000000 ? turn.timestamp * 1000 : turn.timestamp)
                : new Date(turn.timestamp).getTime();
        } else if (data.createTime) {
            timestamp = new Date(data.createTime).getTime() + i * 1000;
        }

        if (!timestamp || isNaN(timestamp)) {
            timestamp = Date.now() - (turns.length - i) * 60000;
        }

        messages.push({
            id: turn.id || `${convId}_${i}`,
            conversationId: convId,
            conversationTitle: convTitle,
            content: text,
            role,
            timestamp,
            platform: 'gemini',
        });
    }
}
