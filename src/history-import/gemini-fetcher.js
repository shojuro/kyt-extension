import { RateLimiter } from './rate-limiter.js';
import { fetchFromTab } from './tab-fetch.js';

/**
 * @typedef {import('./types.js').Message} Message
 */

/**
 * Gemini history fetcher.
 *
 * Gemini uses Google's internal batchexecute RPC format, not a clean REST API.
 * Conversation list and detail are fetched via the same batchexecute endpoint
 * with different RPC IDs.
 *
 * Known RPCs:
 * - Conversation list: fetched from the Gemini web app sidebar data
 * - Conversation detail: loaded via batchexecute when a conversation is opened
 *
 * Fallback: Google Takeout ZIP export (handled by zip-parser.js)
 */
export class GeminiFetcher {
    /**
     * @param {RateLimiter} rateLimiter
     */
    constructor(rateLimiter) {
        this.rateLimiter = rateLimiter;
        this.baseUrl = 'https://gemini.google.com';
        /** @type {{ bl: string|null, at: string|null, conversationListRpcId: string|null, conversationDetailRpcId: string|null }} */
        this.liveParams = { bl: null, at: null, conversationListRpcId: null, conversationDetailRpcId: null };
    }

    /**
     * Fetch all conversations from Gemini.
     *
     * Strategy: Use the /_/BardChatUi/data/batchexecute endpoint to list
     * conversations, then fetch each conversation's messages.
     *
     * @param {number} maxAgeDays
     * @param {string} [resumeFromId]
     * @param {function(string, number): void} [onProgress]
     * @param {function(Message[]): Promise<void>} [onBatch]
     * @param {function(number): void} [onTotal]
     * @returns {Promise<Message[]>}
     */
    /**
     * Capture live batchexecute parameters (bl, RPC IDs) from the Gemini tab.
     *
     * The inject.js script sniffs these from real Gemini traffic and exposes
     * them via window.__kytGeminiCapturedParams. We query this via tab-fetch
     * to get current values instead of hardcoding stale ones.
     *
     * If no params have been captured yet (user hasn't interacted with Gemini),
     * we trigger a page reload to force the sidebar to load and capture params.
     */
    async captureLiveParams() {
        try {
            const tabs = await chrome.tabs.query({ url: ['https://gemini.google.com/*'] });
            if (!tabs || tabs.length === 0) {
                console.log('[GeminiFetcher] No Gemini tab found for param capture');
                return;
            }

            const execResult = await chrome.scripting.executeScript({
                target: { tabId: tabs[0].id },
                world: 'MAIN',
                func: () => {
                    const p = window.__kytGeminiCapturedParams;
                    if (!p) return null;
                    return {
                        bl: p.bl,
                        at: p.at,
                        conversationListRpcId: p.conversationListRpcId,
                        conversationDetailRpcId: p.conversationDetailRpcId,
                        rpcCount: p.rpcIds ? p.rpcIds.size : 0,
                        blAge: p.blCapturedAt ? Date.now() - p.blCapturedAt : null,
                        atAge: p.atCapturedAt ? Date.now() - p.atCapturedAt : null,
                    };
                },
                args: [],
            });

            const params = execResult?.[0]?.result;
            if (params?.bl && params?.at) {
                console.log('[GeminiFetcher] Captured live params:', JSON.stringify(params));
                this.liveParams.bl = params.bl;
                this.liveParams.at = params.at;
                this.liveParams.conversationListRpcId = params.conversationListRpcId;
                this.liveParams.conversationDetailRpcId = params.conversationDetailRpcId;
            } else if (params?.bl && !params?.at) {
                console.log('[GeminiFetcher] Have bl but missing at token — triggering sidebar load...');
                this.liveParams.bl = params.bl;
                this.liveParams.conversationListRpcId = params.conversationListRpcId;
                this.liveParams.conversationDetailRpcId = params.conversationDetailRpcId;
                await this.triggerSidebarLoad(tabs[0].id);
            } else {
                console.log('[GeminiFetcher] No captured params yet — triggering sidebar load...');
                await this.triggerSidebarLoad(tabs[0].id);
            }
        } catch (error) {
            console.warn('[GeminiFetcher] Failed to capture live params:', error.message);
        }
    }

    /**
     * Trigger a Gemini page navigation to force sidebar data to load,
     * which will cause inject.js to capture the bl and RPC params.
     * Waits briefly for the params to be captured.
     */
    async triggerSidebarLoad(tabId) {
        try {
            // Navigate to Gemini home (triggers sidebar conversation list load)
            await chrome.scripting.executeScript({
                target: { tabId },
                world: 'MAIN',
                func: () => {
                    // If we're already on gemini.google.com, reload to trigger sidebar fetch
                    if (window.location.hostname === 'gemini.google.com') {
                        window.location.href = 'https://gemini.google.com/app';
                    }
                },
                args: [],
            });

            // Wait for sidebar batchexecute calls to fire and be captured
            await new Promise(r => setTimeout(r, 4000));

            // Re-read captured params
            const execResult = await chrome.scripting.executeScript({
                target: { tabId },
                world: 'MAIN',
                func: () => {
                    const p = window.__kytGeminiCapturedParams;
                    if (!p) return null;
                    return {
                        bl: p.bl,
                        at: p.at,
                        conversationListRpcId: p.conversationListRpcId,
                        conversationDetailRpcId: p.conversationDetailRpcId,
                    };
                },
                args: [],
            });

            const params = execResult?.[0]?.result;
            if (params?.bl) {
                console.log('[GeminiFetcher] Captured params after sidebar load:', JSON.stringify(params));
                this.liveParams.bl = params.bl;
                this.liveParams.at = params.at;
                this.liveParams.conversationListRpcId = params.conversationListRpcId;
                this.liveParams.conversationDetailRpcId = params.conversationDetailRpcId;
            } else {
                console.warn('[GeminiFetcher] Still no params after sidebar load');
            }
        } catch (error) {
            console.warn('[GeminiFetcher] triggerSidebarLoad failed:', error.message);
        }
    }

    async fetchAllConversations(maxAgeDays, resumeFromId, onProgress, onBatch, onTotal) {
        // Step 0: Capture live batchexecute params from Gemini tab
        await this.captureLiveParams();

        // Step 1: Get conversation list from Gemini's sidebar API
        const conversations = await this.fetchConversationList();

        if (!conversations || conversations.length === 0) {
            throw new Error('Could not fetch Gemini conversations. Please log in to gemini.google.com and try again.');
        }

        const cutoffDate = Date.now() - (maxAgeDays * 24 * 60 * 60 * 1000);
        const allMessages = [];
        let processedCount = 0;

        if (onTotal) {
            onTotal(conversations.length);
        }

        // Find resume point
        let startIndex = 0;
        if (resumeFromId) {
            const index = conversations.findIndex(c => c.id === resumeFromId);
            if (index !== -1) {
                startIndex = index + 1;
                processedCount = startIndex;
            }
        }

        for (let i = startIndex; i < conversations.length; i++) {
            const conv = conversations[i];

            // Check age
            if (conv.updatedAt && conv.updatedAt < cutoffDate) {
                console.log(`[GeminiFetcher] Skipping old conversation: ${new Date(conv.updatedAt).toISOString()}`);
                continue;
            }

            // Fetch conversation detail
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

        console.log(`[GeminiFetcher] Finished. Processed ${processedCount} conversations, returning ${allMessages.length} messages.`);
        return allMessages;
    }

    /**
     * Fetch the conversation list from Gemini.
     *
     * Gemini's sidebar data is loaded via a batchexecute call with the
     * conversation list RPC. We use tab-fetch to piggyback on the user's
     * session cookies.
     *
     * @returns {Promise<Array<{id: string, title: string, updatedAt: number}>>}
     */
    async fetchConversationList() {
        await this.rateLimiter.acquire();

        try {
            console.log('[GeminiFetcher] Fetching conversation list via tab...');

            // Gemini loads conversation list from the main page HTML or via
            // a batchexecute RPC. The simplest approach: fetch the conversations
            // page and parse the embedded data, or use the activity endpoint.
            //
            // The Gemini web app exposes conversations via:
            // POST /_/BardChatUi/data/batchexecute with the conversation list RPC
            const listRpcId = this.liveParams.conversationListRpcId || 'GIm1Qd';
            console.log(`[GeminiFetcher] Using conversation list RPC: ${listRpcId}, bl: ${this.liveParams.bl || '(hardcoded fallback)'}`);
            const reqBody = this.buildBatchExecuteBody(listRpcId, '[]');

            const response = await fetchFromTab('gemini.google.com',
                `${this.baseUrl}/_/BardChatUi/data/batchexecute?${this.getBatchExecuteParams(listRpcId)}`,
                {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded',
                    },
                    body: reqBody,
                    timeoutMs: 30000,
                }
            );

            if (!response.ok) {
                console.error(`[GeminiFetcher] Conversation list failed: ${response.status}`);
                if (response.status === 401 || response.status === 403) {
                    throw new Error('Not logged in to Gemini. Please log in to gemini.google.com and try again.');
                }
                return [];
            }

            const text = typeof response.body === 'string' ? response.body : response.text();
            const conversations = this.parseConversationList(text);
            if (conversations.length > 0) return conversations;

            // If batchexecute returned no conversations, try DOM scrape fallback
            console.log('[GeminiFetcher] batchexecute returned 0 conversations, trying DOM scrape...');
            return this.scrapeConversationListFromDOM();
        } catch (error) {
            console.error('[GeminiFetcher] batchexecute failed, trying DOM scrape fallback:', error.message);
            return this.scrapeConversationListFromDOM();
        }
    }

    /**
     * Fallback: Scrape conversation list from the Gemini page's sidebar DOM.
     * This works regardless of batchexecute format changes since the sidebar
     * is always rendered with conversation links.
     *
     * @returns {Promise<Array<{id: string, title: string, updatedAt: number}>>}
     */
    async scrapeConversationListFromDOM() {
        try {
            const tabs = await chrome.tabs.query({ url: ['https://gemini.google.com/*'] });
            if (!tabs || tabs.length === 0) {
                throw new Error('No Gemini tab found');
            }

            const execResult = await chrome.scripting.executeScript({
                target: { tabId: tabs[0].id },
                world: 'MAIN',
                func: () => {
                    const conversations = [];
                    // Gemini sidebar conversation links contain /app/<conversation_id>
                    const links = document.querySelectorAll('a[href*="/app/"]');
                    for (const link of links) {
                        const href = link.getAttribute('href') || '';
                        const match = href.match(/\/app\/(c_[0-9a-f]+)/);
                        if (match) {
                            const id = match[1];
                            const title = link.textContent?.trim() || 'Untitled';
                            if (!conversations.some(c => c.id === id)) {
                                conversations.push({ id, title, updatedAt: null });
                            }
                        }
                    }
                    return conversations;
                },
                args: [],
            });

            const conversations = execResult?.[0]?.result || [];
            console.log(`[GeminiFetcher] DOM scrape found ${conversations.length} conversations`);
            return conversations;
        } catch (error) {
            console.error('[GeminiFetcher] DOM scrape failed:', error.message);
            throw new Error('Could not fetch Gemini conversations via API or DOM. Please use Google Takeout export instead.');
        }
    }

    /**
     * Fetch a single conversation's messages.
     *
     * @param {string} conversationId
     * @param {string} title
     * @returns {Promise<Message[]>}
     */
    async fetchConversationDetail(conversationId, title) {
        await this.rateLimiter.acquire();

        try {
            // Fetch conversation detail via batchexecute with the conversation load RPC
            const detailRpcId = this.liveParams.conversationDetailRpcId || 'hNvQHb';
            const innerArgs = JSON.stringify([conversationId]);
            const reqBody = this.buildBatchExecuteBody(detailRpcId, innerArgs);

            const response = await fetchFromTab('gemini.google.com',
                `${this.baseUrl}/_/BardChatUi/data/batchexecute?${this.getBatchExecuteParams(detailRpcId)}`,
                {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded',
                    },
                    body: reqBody,
                    timeoutMs: 30000,
                }
            );

            if (!response.ok) {
                console.error(`[GeminiFetcher] Conversation ${conversationId} failed: ${response.status}`);
                if (response.status === 429) {
                    console.log('[GeminiFetcher] Rate limited, waiting 5s...');
                    await new Promise(r => setTimeout(r, 5000));
                    return this.fetchConversationDetail(conversationId, title);
                }
                return [];
            }

            const text = typeof response.body === 'string' ? response.body : response.text();
            return this.parseConversationDetail(text, conversationId, title);

        } catch (error) {
            console.error(`[GeminiFetcher] Failed to fetch conversation ${conversationId}:`, error);
            return [];
        }
    }

    /**
     * Build a batchexecute request body.
     *
     * Google's batchexecute format:
     * f.req = [[["rpcId", "json_args", null, "generic"]]]
     *
     * @param {string} rpcId - The RPC identifier
     * @param {string} args - JSON-encoded arguments
     * @returns {string} URL-encoded form body
     */
    buildBatchExecuteBody(rpcId, args) {
        const envelope = JSON.stringify([[
            [rpcId, args, null, 'generic']
        ]]);
        let body = `f.req=${encodeURIComponent(envelope)}&`;
        // Include XSRF token if captured — required by Google's batchexecute endpoint
        if (this.liveParams.at) {
            body += `at=${encodeURIComponent(this.liveParams.at)}&`;
        }
        return body;
    }

    /**
     * Get standard batchexecute URL parameters.
     * Uses live-captured bl value when available, falls back to hardcoded.
     * @param {string} [rpcId] - Primary RPC ID for this request
     * @returns {string}
     */
    getBatchExecuteParams(rpcId) {
        const bl = this.liveParams.bl || 'boq_assistant-bard-web-server_20260301.00_p0';
        const rpcids = rpcId || 'GIm1Qd';
        return `rpcids=${encodeURIComponent(rpcids)}&source-path=%2F&bl=${encodeURIComponent(bl)}&hl=en&_reqid=0&rt=c`;
    }

    /**
     * Parse the conversation list from a batchexecute response.
     *
     * The response format is Google's streaming format:
     * <number>\n<JSON>\n repeated
     *
     * The conversation list is inside the wrb.fr envelope.
     *
     * @param {string} responseText
     * @returns {Array<{id: string, title: string, updatedAt: number}>}
     */
    parseConversationList(responseText) {
        const conversations = [];

        try {
            const frames = this.parseBatchExecuteFrames(responseText);

            for (const frame of frames) {
                if (!Array.isArray(frame) || frame.length < 2) continue;

                // Look for wrb.fr frames with our RPC data
                if (frame[0] !== 'wrb.fr') continue;

                const innerJson = frame[2];
                if (typeof innerJson !== 'string') continue;

                let data;
                try {
                    data = JSON.parse(innerJson);
                } catch {
                    continue;
                }

                // The conversation list structure varies, but typically:
                // data[0] = array of conversation groups or conversations
                if (!Array.isArray(data)) continue;

                this.extractConversationsFromData(data, conversations);
            }
        } catch (error) {
            console.error('[GeminiFetcher] Failed to parse conversation list:', error);
        }

        console.log(`[GeminiFetcher] Parsed ${conversations.length} conversations from list`);
        return conversations;
    }

    /**
     * Recursively extract conversation entries from parsed batchexecute data.
     * Gemini's response structure nests conversations in arrays.
     *
     * @param {any} data
     * @param {Array<{id: string, title: string, updatedAt: number}>} conversations
     */
    extractConversationsFromData(data, conversations) {
        if (!Array.isArray(data)) return;

        for (const item of data) {
            if (!Array.isArray(item)) continue;

            // A conversation entry typically has:
            // [conversationId, title, ..., timestamp, ...]
            // where conversationId starts with 'c_'
            if (typeof item[0] === 'string' && item[0].startsWith('c_')) {
                const id = item[0];
                const title = (typeof item[1] === 'string' ? item[1] : '') || 'Untitled';
                // Timestamps may be in seconds or milliseconds
                let updatedAt = null;
                // Look for a numeric timestamp in the entry
                for (const val of item) {
                    if (typeof val === 'number' && val > 1700000000) {
                        updatedAt = val < 10000000000 ? val * 1000 : val;
                        break;
                    }
                }

                // Avoid duplicates
                if (!conversations.some(c => c.id === id)) {
                    conversations.push({ id, title, updatedAt });
                }
            }

            // Recurse into sub-arrays
            if (Array.isArray(item[0])) {
                this.extractConversationsFromData(item, conversations);
            }
        }
    }

    /**
     * Parse conversation detail from a batchexecute response.
     *
     * @param {string} responseText
     * @param {string} conversationId
     * @param {string} title
     * @returns {Message[]}
     */
    parseConversationDetail(responseText, conversationId, title) {
        const messages = [];

        try {
            const frames = this.parseBatchExecuteFrames(responseText);

            for (const frame of frames) {
                if (!Array.isArray(frame) || frame[0] !== 'wrb.fr') continue;

                const innerJson = frame[2];
                if (typeof innerJson !== 'string') continue;

                let data;
                try {
                    data = JSON.parse(innerJson);
                } catch {
                    continue;
                }

                if (!Array.isArray(data)) continue;

                // Extract turns from conversation data
                // The conversation detail format has turns nested in the response.
                // Each turn: [userContent, assistantContent, turnId, timestamp, ...]
                this.extractMessagesFromData(data, conversationId, title, messages);
            }
        } catch (error) {
            console.error(`[GeminiFetcher] Failed to parse conversation ${conversationId}:`, error);
        }

        return messages.sort((a, b) => a.timestamp - b.timestamp);
    }

    /**
     * Extract messages from parsed conversation data.
     * Gemini's format nests user/assistant text in turn arrays.
     *
     * @param {any} data
     * @param {string} conversationId
     * @param {string} title
     * @param {Message[]} messages
     */
    extractMessagesFromData(data, conversationId, title, messages) {
        if (!Array.isArray(data)) return;

        // Gemini conversation format (from hNvQHb response):
        // Turns are at data[0][2] (array of turn entries)
        // Each turn: turn[2][0][0] = user text, turn[3][0][0][1][0] = assistant text
        const turns = data[0]?.[2];
        if (!Array.isArray(turns)) {
            // Try alternate structures by recursing
            for (const item of data) {
                if (Array.isArray(item)) {
                    this.extractMessagesFromTurns(item, conversationId, title, messages);
                }
            }
            return;
        }

        this.extractMessagesFromTurns(turns, conversationId, title, messages);
    }

    /**
     * Extract user and assistant messages from turn arrays.
     *
     * @param {any[]} turns
     * @param {string} conversationId
     * @param {string} title
     * @param {Message[]} messages
     */
    extractMessagesFromTurns(turns, conversationId, title, messages) {
        if (!Array.isArray(turns)) return;

        for (let i = 0; i < turns.length; i++) {
            const turn = turns[i];
            if (!Array.isArray(turn)) continue;

            // Extract user message
            const userText = this.extractTextFromTurnPart(turn[2]);
            if (userText) {
                messages.push({
                    id: `${conversationId}_u_${i}`,
                    conversationId,
                    conversationTitle: title || 'Untitled',
                    content: userText,
                    role: 'user',
                    timestamp: this.extractTimestamp(turn) || Date.now() - (turns.length - i) * 60000,
                    platform: 'gemini',
                });
            }

            // Extract assistant message
            const assistantText = this.extractTextFromTurnPart(turn[3]);
            if (assistantText) {
                messages.push({
                    id: `${conversationId}_a_${i}`,
                    conversationId,
                    conversationTitle: title || 'Untitled',
                    content: assistantText,
                    role: 'assistant',
                    timestamp: (this.extractTimestamp(turn) || Date.now() - (turns.length - i) * 60000) + 1,
                    platform: 'gemini',
                });
            }
        }
    }

    /**
     * Extract text content from a turn part (user or assistant).
     * Handles multiple nesting levels that Gemini uses.
     *
     * @param {any} part
     * @returns {string|null}
     */
    extractTextFromTurnPart(part) {
        if (!part) return null;

        // Direct string
        if (typeof part === 'string' && part.trim().length > 0) {
            return part.trim();
        }

        // Nested array: part[0][0] for user text, part[0][0][1][0] for assistant text
        try {
            // Try user format: part[0][0]
            if (Array.isArray(part) && Array.isArray(part[0])) {
                const text = part[0][0];
                if (typeof text === 'string' && text.trim().length > 0) {
                    return text.trim();
                }

                // Try assistant format: part[0][0][1][0]
                const altText = part[0]?.[0]?.[1]?.[0];
                if (typeof altText === 'string' && altText.trim().length > 0) {
                    return altText.trim();
                }
            }
        } catch {
            // Ignore parse errors
        }

        // Fallback: search for any string content
        return this.findFirstString(part);
    }

    /**
     * Find the first substantial string in a nested structure.
     * @param {any} data
     * @param {number} depth
     * @returns {string|null}
     */
    findFirstString(data, depth = 0) {
        if (depth > 5) return null;
        if (typeof data === 'string' && data.trim().length > 20) return data.trim();
        if (Array.isArray(data)) {
            for (const item of data) {
                const found = this.findFirstString(item, depth + 1);
                if (found) return found;
            }
        }
        return null;
    }

    /**
     * Extract a timestamp from a turn array.
     * @param {any[]} turn
     * @returns {number|null}
     */
    extractTimestamp(turn) {
        if (!Array.isArray(turn)) return null;

        // Search for timestamp-like numbers in the turn
        for (const item of turn) {
            if (typeof item === 'number' && item > 1700000000) {
                return item < 10000000000 ? item * 1000 : item;
            }
            if (Array.isArray(item)) {
                for (const sub of item) {
                    if (typeof sub === 'number' && sub > 1700000000) {
                        return sub < 10000000000 ? sub * 1000 : sub;
                    }
                }
            }
        }
        return null;
    }

    /**
     * Parse Google's streaming batchexecute response format.
     *
     * Format: repeated blocks of <number>\n<JSON>\n
     * where <number> is the byte length of the JSON + newline.
     *
     * @param {string} text
     * @returns {any[]} Parsed frames
     */
    parseBatchExecuteFrames(text) {
        const frames = [];
        let pos = 0;

        while (pos < text.length) {
            // Skip whitespace
            while (pos < text.length && (text[pos] === '\n' || text[pos] === '\r' || text[pos] === ' ')) {
                pos++;
            }
            if (pos >= text.length) break;

            // Read the length number
            let numStr = '';
            while (pos < text.length && text[pos] >= '0' && text[pos] <= '9') {
                numStr += text[pos];
                pos++;
            }

            if (!numStr) {
                pos++;
                continue;
            }

            // Skip the newline after length
            if (text[pos] === '\n') pos++;

            const len = parseInt(numStr, 10);
            if (isNaN(len) || len <= 0) continue;

            // Read len characters (approximation — byte vs char, but good enough for parsing)
            const jsonStr = text.substring(pos, pos + len).trim();
            pos += len;

            try {
                const parsed = JSON.parse(jsonStr);
                if (Array.isArray(parsed)) {
                    for (const item of parsed) {
                        frames.push(item);
                    }
                }
            } catch {
                // Not valid JSON — skip
            }
        }

        return frames;
    }
}
