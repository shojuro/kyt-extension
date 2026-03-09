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

        const tabs = await chrome.tabs.query({ url: ['https://gemini.google.com/*'] });
        if (!tabs || tabs.length === 0) {
            throw new Error('No Gemini tab found. Please open gemini.google.com and try again.');
        }
        const tabId = tabs[0].id;

        // Step 1: Navigate to Gemini home to ensure sidebar is visible
        await chrome.scripting.executeScript({
            target: { tabId },
            world: 'MAIN',
            func: () => {
                if (!window.location.pathname.startsWith('/app')) {
                    window.location.href = 'https://gemini.google.com/app';
                }
            },
            args: [],
        });
        await new Promise(r => setTimeout(r, 3000));

        // Step 2: Discover sidebar conversation entries (click-based, not URL-based)
        // Gemini SPA doesn't load conversations via direct URL navigation —
        // we must click sidebar entries to trigger internal Angular routing.
        // Conversation entries live inside <conversations-list>, NOT <side-nav-entry-button>
        // (those are top-level nav items like "My stuff", "Gems", etc.)
        const convListResult = await chrome.scripting.executeScript({
            target: { tabId },
            world: 'MAIN',
            func: () => {
                const conversations = [];
                const seen = new Set();

                // Section headers to skip
                const SKIP_RE = /^(Chats|Pinned( chats?)?|Today|Yesterday|Previous \d+ days|Last week|Last month|This week|This month|Older|New chat|My stuff|Settings|Help|Gems|Storybook|Home|Extensions|Recents?)$/i;

                // Primary: entries inside <conversations-list>
                const convList = document.querySelector('conversations-list');
                if (convList) {
                    // Diagnostic: log the DOM structure inside conversations-list
                    const childTags = {};
                    convList.querySelectorAll('*').forEach(el => {
                        const tag = el.tagName.toLowerCase();
                        childTags[tag] = (childTags[tag] || 0) + 1;
                    });
                    console.log('[KYT] conversations-list child tags:', JSON.stringify(childTags));

                    // Try multiple selectors — Gemini may use different element types
                    const selectors = [
                        'a[href*="/app/"]',                    // Direct conversation links
                        'a',                                    // Any links
                        'button',                               // Buttons
                        '[role="listitem"]',                    // List items
                        '[role="button"]',                      // Button-role divs
                        '[tabindex="0"]',                       // Focusable items
                    ];

                    for (const sel of selectors) {
                        const items = convList.querySelectorAll(sel);
                        items.forEach((item, idx) => {
                            // Get just the first line of text (title, not subtitle)
                            let title = item.innerText?.trim() || '';
                            // Remove "Pinned chat" subtitle
                            title = title.replace(/\n.*Pinned chat.*/gi, '').trim();
                            // Remove other subtitles
                            title = title.split('\n')[0].trim();

                            if (title.length < 3) return;
                            if (SKIP_RE.test(title)) return;
                            if (seen.has(title)) return;
                            seen.add(title);
                            conversations.push({ selector: sel, idx, title: title.substring(0, 100) });
                        });
                        if (conversations.length > 0) {
                            console.log(`[KYT] Found ${conversations.length} conversations using selector: ${sel}`);
                            break;
                        }
                    }
                }

                // Fallback: direct children of side-navigation-content
                if (conversations.length === 0) {
                    const sideNav = document.querySelector('side-navigation-content');
                    if (sideNav) {
                        const items = sideNav.querySelectorAll('a, button, [role="listitem"]');
                        items.forEach((item, idx) => {
                            let title = item.innerText?.trim().split('\n')[0] || '';
                            if (title.length < 3 || SKIP_RE.test(title) || seen.has(title)) return;
                            seen.add(title);
                            conversations.push({ selector: 'sidenav', idx, title: title.substring(0, 100) });
                        });
                    }
                }

                console.log(`[KYT] Found ${conversations.length} sidebar conversation entries`);
                if (conversations.length > 0) {
                    console.log('[KYT] First 3:', conversations.slice(0, 3).map(c => c.title).join(' | '));
                }
                return conversations;
            },
            args: [],
        });

        const conversations = convListResult?.[0]?.result || [];
        console.log(`[GeminiFetcher] Found ${conversations.length} sidebar conversations`);

        if (conversations.length === 0) {
            // Fall back to batchexecute if no sidebar entries found
            console.log('[GeminiFetcher] No sidebar entries, trying batchexecute...');
            const batchConvs = await this.fetchConversationList();
            if (!batchConvs || batchConvs.length === 0) {
                throw new Error('Could not fetch Gemini conversations. Please log in to gemini.google.com and try again.');
            }
            // Can't click-navigate with batchexecute IDs, return empty
            console.warn('[GeminiFetcher] batchexecute found conversations but cannot click-navigate');
            throw new Error('Gemini sidebar conversations not found. Please ensure the sidebar is visible and try again.');
        }

        if (onTotal) {
            onTotal(conversations.length);
        }

        const allMessages = [];
        let processedCount = 0;

        // Step 3: Click each sidebar entry, extract messages, move to next
        for (let i = 0; i < conversations.length; i++) {
            const conv = conversations[i];
            await this.rateLimiter.acquire();

            console.log(`[GeminiFetcher] Clicking conversation ${i + 1}/${conversations.length}: "${conv.title}"`);

            // Click the sidebar entry using the stored selector
            const clickResult = await chrome.scripting.executeScript({
                target: { tabId },
                world: 'MAIN',
                func: (convIdx, selector) => {
                    let container;
                    if (selector === 'sidenav') {
                        container = document.querySelector('side-navigation-content');
                        if (!container) return { ok: false, reason: 'no side-navigation-content' };
                        const items = container.querySelectorAll('a, button, [role="listitem"]');
                        if (convIdx >= items.length) return { ok: false, reason: `idx ${convIdx} >= ${items.length}` };
                        items[convIdx].click();
                        return { ok: true };
                    }

                    container = document.querySelector('conversations-list');
                    if (!container) return { ok: false, reason: 'no conversations-list' };
                    const items = container.querySelectorAll(selector);
                    if (convIdx >= items.length) return { ok: false, reason: `idx ${convIdx} >= ${items.length} for ${selector}` };
                    const btn = items[convIdx];
                    // Try the element itself, or find a clickable child
                    const clickTarget = btn.querySelector('a, button') || btn;
                    clickTarget.click();
                    return { ok: true, tag: clickTarget.tagName, text: clickTarget.innerText?.substring(0, 50) };
                },
                args: [conv.idx, conv.selector],
            });

            const clickInfo = clickResult?.[0]?.result;
            if (!clickInfo?.ok) {
                console.warn(`[GeminiFetcher] Could not click conversation ${i + 1}: ${clickInfo?.reason || 'unknown'}`);
                processedCount++;
                continue;
            }
            console.log(`[GeminiFetcher] Clicked: <${clickInfo.tag}> "${clickInfo.text}"`)

            // Wait for conversation to render after click
            await new Promise(r => setTimeout(r, 3000));

            // Poll for conversation elements (up to 8s additional)
            await chrome.scripting.executeScript({
                target: { tabId },
                world: 'MAIN',
                func: async () => {
                    for (let i = 0; i < 8; i++) {
                        const els = document.querySelectorAll('user-query, model-response');
                        if (els.length > 0) return;
                        await new Promise(r => setTimeout(r, 1000));
                    }
                },
                args: [],
            });

            // Scroll to load all messages
            await chrome.scripting.executeScript({
                target: { tabId },
                world: 'MAIN',
                func: async () => {
                    const scroller = document.querySelector('infinite-scroller')
                        || document.querySelector('main');
                    if (!scroller) return;
                    let lastCount = 0;
                    let stableRounds = 0;
                    for (let i = 0; i < 15 && stableRounds < 3; i++) {
                        scroller.scrollTo({ top: 0, behavior: 'auto' });
                        await new Promise(r => setTimeout(r, 600));
                        const count = document.querySelectorAll('user-query, model-response').length;
                        if (count === lastCount) stableRounds++;
                        else { stableRounds = 0; lastCount = count; }
                    }
                },
                args: [],
            });

            await new Promise(r => setTimeout(r, 500));

            // Extract messages
            const messages = await this.extractMessagesFromTab(tabId, conv.title || 'Untitled', `sidebar_${i}`);

            if (messages.length > 0) {
                console.log(`[GeminiFetcher] Extracted ${messages.length} messages from "${conv.title}"`);
                if (onBatch) {
                    await onBatch(messages);
                } else {
                    allMessages.push(...messages);
                }
            } else {
                console.warn(`[GeminiFetcher] 0 messages from "${conv.title}"`);
            }

            processedCount++;
            if (onProgress) {
                onProgress(`sidebar_${i}`, processedCount);
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

        const listRpcId = this.liveParams.conversationListRpcId || 'GIm1Qd';
        console.log(`[GeminiFetcher] Trying batchexecute conversation list, RPC: ${listRpcId}, bl: ${this.liveParams.bl || '(hardcoded)'}`);

        try {
            const reqBody = this.buildBatchExecuteBody(listRpcId, '[]');
            const response = await fetchFromTab('gemini.google.com',
                `${this.baseUrl}/_/BardChatUi/data/batchexecute?${this.getBatchExecuteParams(listRpcId)}`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: reqBody,
                    timeoutMs: 30000,
                }
            );

            if (response.ok) {
                const text = typeof response.body === 'string' ? response.body : await response.text();
                console.log(`[GeminiFetcher] batchexecute response OK, body length: ${text.length}`);
                const conversations = this.parseConversationList(text);
                if (conversations.length > 0) return conversations;
                console.log('[GeminiFetcher] batchexecute returned 200 but parsed 0 conversations');
            } else {
                console.warn(`[GeminiFetcher] batchexecute list returned ${response.status}`);
            }
        } catch (error) {
            console.warn('[GeminiFetcher] batchexecute list failed:', error.message);
        }

        // batchexecute failed or returned 0 — fall back to DOM scrape
        console.log('[GeminiFetcher] Falling back to DOM scrape for conversation list...');
        return this.scrapeConversationListFromDOM();
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

            const tabId = tabs[0].id;

            // Ensure we're on the main page (sidebar is visible there)
            await chrome.scripting.executeScript({
                target: { tabId },
                world: 'MAIN',
                func: () => {
                    // Navigate to main app page if not there (sidebar shows conversation list)
                    if (!window.location.pathname.startsWith('/app')) {
                        window.location.href = 'https://gemini.google.com/app';
                    }
                },
                args: [],
            });
            await new Promise(r => setTimeout(r, 3000));

            // Scrape conversation links from the sidebar
            const execResult = await chrome.scripting.executeScript({
                target: { tabId },
                world: 'MAIN',
                func: () => {
                    const conversations = [];
                    const seen = new Set();

                    const add = (id, title) => {
                        if (!id || seen.has(id)) return;
                        seen.add(id);
                        conversations.push({ id, title: title || 'Untitled', updatedAt: null });
                    };

                    // Strategy 1: Links with /app/c_ conversation IDs in href
                    const links = document.querySelectorAll('a[href*="/app/"]');
                    for (const link of links) {
                        const href = link.getAttribute('href') || '';
                        const match = href.match(/\/(c_[0-9a-f]+)/);
                        if (match) add(match[1], link.textContent?.trim());
                    }

                    // Strategy 2: Any element with c_ in any attribute
                    if (conversations.length === 0) {
                        const allEls = document.querySelectorAll('*');
                        for (const el of allEls) {
                            for (const attr of el.attributes || []) {
                                const match = attr.value.match(/(c_[0-9a-f]{8,})/);
                                if (match) {
                                    // Walk up to find a title from text content
                                    const title = el.closest('[role="listitem"], li, a, button')?.textContent?.trim()
                                        || el.textContent?.trim() || '';
                                    add(match[1], title.substring(0, 100));
                                }
                            }
                        }
                    }

                    // Strategy 3: Scan raw page HTML for c_ IDs (catches JS data, Angular bindings, etc.)
                    if (conversations.length === 0) {
                        // Check sidebar area first, then full body
                        const sidebar = document.querySelector('nav[role="navigation"]')
                            || document.querySelector('aside')
                            || document.querySelector('nav');
                        const searchTarget = sidebar || document.body;
                        const html = searchTarget.innerHTML;
                        const regex = /c_([0-9a-f]{8,})/g;
                        let m;
                        while ((m = regex.exec(html)) !== null) {
                            add('c_' + m[1], '');
                        }
                    }

                    // Strategy 4: AF_initDataCallback / WIZ data embedded in scripts
                    if (conversations.length === 0) {
                        const scripts = document.querySelectorAll('script');
                        for (const s of scripts) {
                            const text = s.textContent || '';
                            if (text.length < 100) continue;
                            const regex = /(c_[0-9a-f]{8,})/g;
                            let m;
                            while ((m = regex.exec(text)) !== null) {
                                add(m[1], '');
                            }
                        }
                    }

                    console.log(`[KYT DOM scrape] Found ${conversations.length} conversations via ${
                        conversations.length > 0 ? 'strategies 1-4' : 'none'
                    }`);

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
     * Extract messages from the currently visible conversation in a Gemini tab.
     * Shared between sidebar-click flow and any future direct-navigation flow.
     *
     * @param {number} tabId
     * @param {string} title
     * @param {string} conversationId
     * @returns {Promise<Message[]>}
     */
    async extractMessagesFromTab(tabId, title, conversationId) {
        try {
            const execResult = await chrome.scripting.executeScript({
                target: { tabId },
                world: 'MAIN',
                func: () => {
                    const messages = [];

                    // ═══ Strategy 1: Gemini custom web components ═══
                    const userQueries = document.querySelectorAll('user-query, USER-QUERY');
                    const modelResponses = document.querySelectorAll('model-response, MODEL-RESPONSE');

                    // Diagnostic logging
                    console.log(`[KYT extract] user-query: ${userQueries.length}, model-response: ${modelResponses.length}`);

                    if (userQueries.length === 0 && modelResponses.length === 0) {
                        const allTags = new Set();
                        document.body.querySelectorAll('*').forEach(el => allTags.add(el.tagName.toLowerCase()));
                        const customTags = [...allTags].filter(t => t.includes('-'));
                        console.log('[KYT extract] Custom elements:', customTags.join(', '));
                        console.log('[KYT extract] Body text length:', document.body.innerText?.length);
                        console.log('[KYT extract] Body first 300 chars:', document.body.innerText?.substring(0, 300));
                    }

                    if (userQueries.length > 0 || modelResponses.length > 0) {
                        // Extract user messages
                        userQueries.forEach((uq, idx) => {
                            const textEls = uq.querySelectorAll('.query-text-line, .query-text, p');
                            const seen = new Set();
                            let text = '';
                            textEls.forEach(el => {
                                const t = el.textContent?.trim();
                                if (t && !seen.has(t) && !t.includes('Opens in a new window')) {
                                    seen.add(t);
                                    text += t + ' ';
                                }
                            });
                            if (!text.trim()) text = uq.innerText?.trim() || '';
                            if (text.trim()) {
                                messages.push({ role: 'user', text: text.trim(), idx });
                            }
                        });

                        // Extract model responses
                        modelResponses.forEach((mr, idx) => {
                            const msgContent = mr.querySelector('message-content, MESSAGE-CONTENT');
                            const markdown = msgContent?.querySelector('.markdown')
                                || msgContent?.querySelector('.response-content')
                                || msgContent;

                            let text = '';
                            if (markdown) {
                                const blocks = markdown.querySelectorAll('p, li, pre, h1, h2, h3, h4');
                                const seen = new Set();
                                blocks.forEach(b => {
                                    const t = b.textContent?.trim();
                                    if (t && t.length > 2 && !seen.has(t)) {
                                        seen.add(t);
                                        text += (b.tagName === 'LI' ? '• ' : '') + t + '\n';
                                    }
                                });
                            }
                            if (!text.trim()) text = mr.innerText?.trim() || '';
                            text = text
                                .replace(/Read documents\s*/gi, '')
                                .replace(/Response finalized\s*/gi, '')
                                .replace(/\n{3,}/g, '\n\n')
                                .trim();
                            if (text && text.length > 5) {
                                messages.push({ role: 'assistant', text, idx });
                            }
                        });

                        // Interleave by index
                        const interleaved = [];
                        const userByIdx = messages.filter(m => m.role === 'user');
                        const modelByIdx = messages.filter(m => m.role === 'assistant');
                        const maxLen = Math.max(userByIdx.length, modelByIdx.length);
                        for (let i = 0; i < maxLen; i++) {
                            if (i < userByIdx.length) interleaved.push(userByIdx[i]);
                            if (i < modelByIdx.length) interleaved.push(modelByIdx[i]);
                        }
                        return interleaved;
                    }

                    // ═══ Strategy 2: Generic fallback ═══
                    const queries = document.querySelectorAll('.query-text-line, .query-text');
                    const resps = document.querySelectorAll('message-content .markdown');
                    if (queries.length > 0 || resps.length > 0) {
                        console.log(`[KYT extract] Fallback: ${queries.length} queries, ${resps.length} responses`);
                        const maxLen = Math.max(queries.length, resps.length);
                        for (let i = 0; i < maxLen; i++) {
                            if (i < queries.length) {
                                const t = queries[i].textContent?.trim();
                                if (t) messages.push({ role: 'user', text: t });
                            }
                            if (i < resps.length) {
                                const t = resps[i].innerText?.trim();
                                if (t) messages.push({ role: 'assistant', text: t });
                            }
                        }
                    }
                    return messages;
                },
                args: [],
            });

            const scraped = execResult?.[0]?.result || [];
            if (scraped.length === 0) {
                console.warn(`[GeminiFetcher] Extracted 0 messages from "${title}" (${conversationId})`);
                return [];
            }

            console.log(`[GeminiFetcher] Extracted ${scraped.length} messages from "${title}"`);

            return scraped.map((msg, i) => ({
                id: `${conversationId}_dom_${i}`,
                conversationId,
                conversationTitle: title || 'Untitled',
                content: msg.text,
                role: msg.role,
                timestamp: Date.now() - (scraped.length - i) * 60000,
                platform: 'gemini',
            }));

        } catch (error) {
            console.error(`[GeminiFetcher] Extract failed for ${conversationId}:`, error.message);
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
            console.log(`[GeminiFetcher] parseConversationList: response length=${responseText.length}, first 300 chars:`, responseText.substring(0, 300));

            const frames = this.parseBatchExecuteFrames(responseText);
            console.log(`[GeminiFetcher] Parsed ${frames.length} frames from batchexecute response`);

            for (let fi = 0; fi < frames.length; fi++) {
                const frame = frames[fi];
                if (!Array.isArray(frame) || frame.length < 2) continue;

                // Look for wrb.fr frames with our RPC data
                if (frame[0] !== 'wrb.fr') continue;

                const innerJson = frame[2];
                console.log(`[GeminiFetcher] Frame ${fi}: wrb.fr, innerJson type=${typeof innerJson}, length=${typeof innerJson === 'string' ? innerJson.length : 'N/A'}`);

                if (typeof innerJson !== 'string') continue;

                let data;
                try {
                    data = JSON.parse(innerJson);
                } catch {
                    console.log(`[GeminiFetcher] Frame ${fi}: failed to parse inner JSON`);
                    continue;
                }

                console.log(`[GeminiFetcher] Frame ${fi}: parsed data type=${Array.isArray(data) ? 'array' : typeof data}, length=${Array.isArray(data) ? data.length : 'N/A'}`);

                if (!Array.isArray(data)) continue;

                this.extractConversationsFromData(data, conversations);
            }

            // Fallback: regex scan the raw response for c_ conversation IDs
            if (conversations.length === 0) {
                console.log('[GeminiFetcher] Frame-based extraction found 0, trying regex fallback on raw response...');
                const regex = /(c_[0-9a-f]{8,})/g;
                const seen = new Set();
                let match;
                while ((match = regex.exec(responseText)) !== null) {
                    const id = match[1];
                    if (!seen.has(id)) {
                        seen.add(id);
                        conversations.push({ id, title: '', updatedAt: null });
                    }
                }
                if (conversations.length > 0) {
                    console.log(`[GeminiFetcher] Regex fallback found ${conversations.length} conversation IDs`);
                }
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
