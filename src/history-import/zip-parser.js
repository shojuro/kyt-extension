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

    // Try: Google Takeout "My Activity" HTML format (most common as of 2026)
    const activityHtmlPaths = [
        'Takeout/My Activity/Gemini Apps/MyActivity.html',
        'My Activity/Gemini Apps/MyActivity.html',
    ];
    for (const path of activityHtmlPaths) {
        const htmlFile = zip.file(path);
        if (htmlFile) {
            const html = await htmlFile.async('string');
            parseGeminiActivityHtml(html, messages);
            if (messages.length > 0) {
                return messages.sort((a, b) => a.timestamp - b.timestamp);
            }
        }
    }

    // Fallback: JSON folder structure
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

/**
 * Parse Google Takeout "My Activity" HTML format for Gemini Apps.
 *
 * Each activity entry is an `outer-cell` div containing:
 * - "Prompted\xA0" prefix (non-breaking space) followed by user's message
 * - Timestamp like "Mar 9, 2026, 1:53:07 PM GMT+08:00"
 * - Assistant response as inline HTML (paragraphs, lists, etc.)
 *
 * Other entry types ("Created", "Used", "Selected") are skipped — they are
 * metadata events, not conversational turns.
 *
 * @param {string} html - Full HTML content of MyActivity.html
 * @param {Message[]} messages - Array to push parsed messages into
 */
function parseGeminiActivityHtml(html, messages) {
    // Split on outer-cell divs. First element is the HTML preamble.
    const entries = html.split('<div class="outer-cell');

    // Regex for the content structure within each entry.
    // "Prompted" is followed by \xA0 (non-breaking space), then the user's prompt,
    // then <br>, then the timestamp, then <br>, then the response HTML.
    // Timestamp format: "Mar 9, 2026, 1:53:07 PM GMT+08:00"
    const timestampRe = /(\w{3}\s\d{1,2},\s\d{4},\s\d{1,2}:\d{2}:\d{2}\s[AP]M\s[\w+:\/\d]+)/;

    // Track conversation grouping: consecutive entries close in time = same conversation
    // Google Takeout doesn't provide conversation IDs, so we group by time proximity.
    let currentConvId = null;
    let lastTimestamp = 0;
    let convCounter = 0;
    const CONV_GAP_MS = 30 * 60 * 1000; // 30 minutes between entries = new conversation

    for (let i = 1; i < entries.length; i++) {
        const entry = entries[i];

        // Only process "Prompted" entries (actual conversations)
        // \xA0 = non-breaking space used by Google Takeout
        const promptIdx = entry.indexOf('Prompted\xA0');
        if (promptIdx === -1) continue;

        // Extract everything after "Prompted\xA0" up to the closing content-cell div
        const contentStart = promptIdx + 'Prompted\xA0'.length;
        // Find the end of the content-cell div
        const contentCellEnd = entry.indexOf('</div>', contentStart);
        if (contentCellEnd === -1) continue;

        const contentBlock = entry.slice(contentStart, contentCellEnd);

        // Split on <br> to separate: user prompt, [audio link], timestamp, response
        const parts = contentBlock.split(/<br\s*\/?>/);
        if (parts.length < 2) continue;

        // Find the timestamp among the parts
        let timestampStr = null;
        let timestampPartIdx = -1;
        for (let j = 0; j < parts.length; j++) {
            const stripped = parts[j].replace(/<[^>]*>/g, '').trim();
            const tsMatch = stripped.match(timestampRe);
            if (tsMatch) {
                timestampStr = tsMatch[1];
                timestampPartIdx = j;
                break;
            }
        }

        if (!timestampStr) continue;

        // Parse timestamp
        // Format: "Mar 9, 2026, 1:53:07 PM GMT+08:00"
        // Date.parse handles this format directly
        const timestamp = new Date(timestampStr).getTime();
        if (isNaN(timestamp)) continue;

        // User prompt = everything before the timestamp part
        const userParts = parts.slice(0, timestampPartIdx);
        let userText = userParts
            .map(p => p.replace(/<[^>]*>/g, '').trim()) // Strip HTML tags
            .filter(p => p && !p.startsWith('Audio included'))
            .join('\n')
            .trim();

        // Decode HTML entities
        userText = decodeHtmlEntities(userText);
        if (!userText) continue;

        // Skip K.Y.T. injection prompts — these are system context, not real user messages
        if (userText.startsWith('=====') && userText.includes('K.Y.T.')) continue;

        // Assistant response = everything after the timestamp part
        const responseParts = parts.slice(timestampPartIdx + 1);
        let responseText = responseParts
            .join('\n')
            .replace(/<[^>]*>/g, ' ')  // Replace HTML tags with spaces
            .replace(/\s+/g, ' ')      // Collapse whitespace
            .trim();
        responseText = decodeHtmlEntities(responseText);

        // Group into conversations by time proximity
        if (!currentConvId || Math.abs(timestamp - lastTimestamp) > CONV_GAP_MS) {
            convCounter++;
            currentConvId = `gemini_takeout_${convCounter}`;
        }
        lastTimestamp = timestamp;

        // Extract a title from the user's first message in each conversation
        const convTitle = userText.slice(0, 80) + (userText.length > 80 ? '...' : '');

        // Add user message
        messages.push({
            id: `gemini_activity_${i}_user`,
            conversationId: currentConvId,
            conversationTitle: convTitle,
            content: userText,
            role: 'user',
            timestamp,
            platform: 'gemini',
        });

        // Add assistant response if present
        if (responseText) {
            messages.push({
                id: `gemini_activity_${i}_assistant`,
                conversationId: currentConvId,
                conversationTitle: convTitle,
                content: responseText,
                role: 'assistant',
                timestamp: timestamp + 1000, // 1s after user message
                platform: 'gemini',
            });
        }
    }
}

/**
 * Decode common HTML entities.
 * @param {string} str
 * @returns {string}
 */
function decodeHtmlEntities(str) {
    return str
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&nbsp;/g, ' ')
        .replace(/&emsp;/g, ' ')
        .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}
