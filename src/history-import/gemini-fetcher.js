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

        // Step 1a: Ensure sidebar is EXPANDED (Gemini has a collapsible sidebar)
        await chrome.scripting.executeScript({
            target: { tabId },
            world: 'MAIN',
            func: () => {
                // Check if sidebar is collapsed by looking for the conversation list
                const convList = document.querySelector('conversations-list');
                const sideNav = document.querySelector('mat-sidenav');
                const isVisible = convList && convList.offsetParent !== null;
                const sideNavOpen = sideNav && (
                    sideNav.getAttribute('role') === 'navigation'
                    || sideNav.classList.contains('mat-drawer-opened')
                    || getComputedStyle(sideNav).visibility !== 'hidden'
                );

                // If sidebar seems collapsed, click the hamburger/menu button
                if (!isVisible || !sideNavOpen) {
                    console.log('[KYT] Sidebar appears collapsed, trying to expand...');
                    const menuBtn = document.querySelector('side-nav-menu-button')
                        || document.querySelector('button[aria-label*="menu" i]')
                        || document.querySelector('button[aria-label*="Main menu" i]')
                        || document.querySelector('.menu-button');
                    if (menuBtn) {
                        const clickTarget = menuBtn.querySelector('button') || menuBtn;
                        clickTarget.click();
                        console.log('[KYT] Clicked sidebar menu button');
                    } else {
                        console.log('[KYT] No menu button found to expand sidebar');
                    }
                } else {
                    console.log('[KYT] Sidebar already visible');
                }
            },
            args: [],
        });
        await new Promise(r => setTimeout(r, 2000));

        // Step 1b: Scroll the sidebar to load ALL conversation history.
        // Gemini lazy-loads sidebar entries — only recent conversations are
        // visible initially. We scroll the conversations-list container to
        // the bottom repeatedly until no new entries appear, loading the
        // full ~90 day history.
        const scrollResult = await chrome.scripting.executeScript({
            target: { tabId },
            world: 'MAIN',
            func: async () => {
                // Find the scrollable sidebar container
                const convList = document.querySelector('conversations-list')
                    || document.querySelector('side-navigation-content');
                if (!convList) {
                    console.log('[KYT sidebar scroll] No conversations-list found');
                    return { scrolled: false, finalCount: 0 };
                }

                // The scrollable element might be the conversations-list itself,
                // its parent, or an inner infinite-scroller
                const scroller = convList.querySelector('infinite-scroller')
                    || convList.querySelector('[style*="overflow"]')
                    || convList;

                // Also check mat-sidenav or the nav element
                const sideNav = document.querySelector('mat-sidenav')
                    || document.querySelector('side-navigation-v2')
                    || scroller;

                let lastCount = 0;
                let stableRounds = 0;
                const maxScrollAttempts = 60; // Cap at 60 scrolls (~60s max)

                for (let i = 0; i < maxScrollAttempts && stableRounds < 4; i++) {
                    // Count both entry types — href links are more reliable
                    const entryButtons = document.querySelectorAll('side-nav-entry-button');
                    const hrefLinks = document.querySelectorAll('a[href*="/app/"]');
                    const currentCount = Math.max(entryButtons.length, hrefLinks.length);

                    if (i % 5 === 0) {
                        console.log(`[KYT sidebar scroll] Attempt ${i}: ${currentCount} entries visible`);
                    }

                    if (currentCount === lastCount) {
                        stableRounds++;
                    } else {
                        stableRounds = 0;
                        lastCount = currentCount;
                    }

                    // Scroll to the bottom of the sidebar
                    // Try multiple scroll targets — Gemini's sidebar nesting varies
                    for (const target of [scroller, sideNav, convList]) {
                        if (target && target.scrollHeight > target.clientHeight) {
                            target.scrollTo({ top: target.scrollHeight, behavior: 'auto' });
                        }
                    }

                    // Also try scrolling the last entry into view (triggers lazy load)
                    const allEntries = hrefLinks.length > 0 ? hrefLinks : entryButtons;
                    if (allEntries.length > 0) {
                        allEntries[allEntries.length - 1].scrollIntoView({ behavior: 'auto', block: 'end' });
                    }

                    await new Promise(r => setTimeout(r, 800));
                }

                const finalButtons = document.querySelectorAll('side-nav-entry-button');
                const finalLinks = document.querySelectorAll('a[href*="/app/"]');
                console.log(`[KYT sidebar scroll] Done. Final: ${finalButtons.length} buttons, ${finalLinks.length} href links`);

                // Scroll back to top so sidebar is in a clean state
                for (const target of [scroller, sideNav, convList]) {
                    if (target) target.scrollTo({ top: 0, behavior: 'auto' });
                }

                return { scrolled: true, finalCount: finalEntries.length };
            },
            args: [],
        });

        const scrollInfo = scrollResult?.[0]?.result || {};
        console.log(`[GeminiFetcher] Sidebar scroll complete: ${scrollInfo.finalCount} entries loaded`);

        // Step 2: Discover sidebar conversation entries WITH time-group headings.
        // Gemini groups sidebar entries under headings like "Today", "Yesterday",
        // "Previous 7 Days", "Previous 30 Days", "May 2025", etc.
        // We capture these to assign approximate timestamps to imported messages.
        // Primary: a[href*="/app/"] links (most reliable — worked in previous runs).
        // Fallback: side-nav-entry-button elements.
        // We store the href so we can click by selector later (stable across scrolls).
        const convListResult = await chrome.scripting.executeScript({
            target: { tabId },
            world: 'MAIN',
            func: () => {
                // ── Helper: find the time-group heading for a conversation element ──
                // Walk up from the link to find the nearest preceding group heading.
                // Gemini sidebar structure varies, but headings are typically:
                //   - <h3> or <h4> elements with group labels
                //   - elements with class containing "group-header", "section-header"
                //   - text nodes with date-like content before conversation entries
                function findGroupHeading(el) {
                    // Strategy A: Walk previousElementSibling up from the link's parent
                    // looking for a heading or group-header element
                    let container = el.closest('[class*="group"]')
                        || el.closest('[class*="section"]')
                        || el.parentElement;

                    // Check for a heading within the same group container
                    if (container) {
                        const heading = container.querySelector('h3, h4, h5, [class*="header"], [class*="heading"], [class*="label"]');
                        if (heading) {
                            const text = heading.textContent?.trim();
                            if (text && text.length < 50) return text;
                        }
                    }

                    // Strategy B: Walk backwards through siblings of the conversation
                    // entry looking for a heading element
                    let sibling = (el.closest('side-nav-entry-button') || el.parentElement);
                    if (sibling) {
                        let prev = sibling.previousElementSibling;
                        let steps = 0;
                        while (prev && steps < 30) {
                            // Check if this sibling IS a heading
                            const tag = prev.tagName?.toLowerCase() || '';
                            if (/^h[1-6]$/.test(tag) || prev.classList?.toString().match(/header|heading|label|group-title/i)) {
                                const text = prev.textContent?.trim();
                                if (text && text.length < 50) return text;
                            }
                            // Check if it contains a heading
                            const inner = prev.querySelector('h3, h4, h5, [class*="header"], [class*="heading"], [class*="group-title"]');
                            if (inner) {
                                const text = inner.textContent?.trim();
                                if (text && text.length < 50) return text;
                            }
                            prev = prev.previousElementSibling;
                            steps++;
                        }
                    }

                    // Strategy C: Walk up to conversations-list and scan all children
                    // in DOM order, tracking the last heading seen before our element
                    const convList = document.querySelector('conversations-list');
                    if (convList) {
                        let lastHeading = null;
                        const walker = document.createTreeWalker(
                            convList,
                            NodeFilter.SHOW_ELEMENT,
                            null
                        );
                        let node = walker.nextNode();
                        while (node) {
                            // Is it a heading-like element?
                            const tag = node.tagName?.toLowerCase() || '';
                            const cls = node.classList?.toString() || '';
                            if (/^h[1-6]$/.test(tag) || /header|heading|label|group-title/i.test(cls)) {
                                const text = node.textContent?.trim();
                                if (text && text.length < 50 && !/^(New chat|Home|Settings|Gems)/i.test(text)) {
                                    lastHeading = text;
                                }
                            }
                            // Is it our element?
                            if (node === el || node.contains(el) || el.contains(node)) {
                                return lastHeading;
                            }
                            node = walker.nextNode();
                        }
                    }

                    return null;
                }

                const conversations = [];
                const seenHrefs = new Set();
                const headingsFound = new Set();

                // Strategy 1: href-based links (most reliable)
                const links = document.querySelectorAll('a[href*="/app/"]');
                for (const link of links) {
                    const href = link.getAttribute('href') || '';
                    // Only conversation links (contain c_ ID or are direct /app/ paths)
                    if (seenHrefs.has(href)) continue;
                    // Skip the home /app link itself
                    if (href === '/app' || href === '/app/') continue;
                    seenHrefs.add(href);
                    const title = link.textContent?.trim() || '';
                    if (title.length < 2) continue;
                    if (/^(New chat|Settings|Help|Gems|Home|Extensions)/i.test(title)) continue;
                    const groupHeading = findGroupHeading(link);
                    if (groupHeading) headingsFound.add(groupHeading);
                    conversations.push({ href, title: title.substring(0, 100), type: 'href', groupHeading });
                }

                if (conversations.length > 0) {
                    console.log(`[KYT] Found ${conversations.length} conversations via a[href*="/app/"]`);
                    console.log(`[KYT] First 3: ${conversations.slice(0, 3).map(c => `${c.title} [${c.groupHeading || '?'}]`).join(' | ')}`);
                    console.log(`[KYT] Time groups found: ${[...headingsFound].join(', ')}`);
                    return conversations;
                }

                // Strategy 2: side-nav-entry-button (fallback)
                const buttons = document.querySelectorAll('side-nav-entry-button');
                buttons.forEach((btn, idx) => {
                    const title = btn.innerText?.trim() || '';
                    if (title.length < 2) return;
                    if (/^(New chat|Settings|Help|Gems|Home|Extensions)/i.test(title)) return;
                    const groupHeading = findGroupHeading(btn);
                    if (groupHeading) headingsFound.add(groupHeading);
                    conversations.push({ idx, title: title.substring(0, 100), type: 'button', groupHeading });
                });

                if (conversations.length > 0) {
                    console.log(`[KYT] Found ${conversations.length} conversations via side-nav-entry-button`);
                    console.log(`[KYT] Time groups found: ${[...headingsFound].join(', ')}`);
                    return conversations;
                }

                // Strategy 3: generic sidebar items
                const sidebar = document.querySelector('conversations-list')
                    || document.querySelector('side-navigation-content')
                    || document.querySelector('nav');
                if (sidebar) {
                    const items = sidebar.querySelectorAll('a, button, [role="listitem"], [role="button"]');
                    items.forEach((item, idx) => {
                        const title = item.innerText?.trim() || '';
                        if (title.length < 2) return;
                        if (/^(New|Start|Menu|Settings|Home|Gems|Help)/i.test(title)) return;
                        const groupHeading = findGroupHeading(item);
                        if (groupHeading) headingsFound.add(groupHeading);
                        conversations.push({ idx, title: title.substring(0, 100), type: 'generic', groupHeading });
                    });
                }

                // Diagnostic
                const convListEl = document.querySelector('conversations-list');
                if (convListEl) {
                    const tags = {};
                    convListEl.querySelectorAll('*').forEach(el => {
                        const t = el.tagName.toLowerCase();
                        tags[t] = (tags[t] || 0) + 1;
                    });
                    console.log('[KYT] conversations-list child tags:', JSON.stringify(tags));
                }

                console.log(`[KYT] Found ${conversations.length} sidebar conversation entries`);
                console.log(`[KYT] Time groups found: ${[...headingsFound].join(', ')}`);
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

        // Step 3: Click each sidebar entry, extract messages with timestamps, move to next.
        // For each conversation we:
        //   a) Install an XHR interceptor to capture the batchexecute response (has timestamps)
        //   b) Click the sidebar entry (triggers XHR conversation-load)
        //   c) DOM-scrape for content (reliable)
        //   d) Parse timestamps from captured XHR response
        //   e) Marry timestamps to DOM-scraped messages by turn index
        // DEBUG: Cap at 5 conversations for timestamp testing — remove after validation
        const convLimit = Math.min(conversations.length, 5);
        console.log(`[GeminiFetcher] DEBUG: Processing ${convLimit} of ${conversations.length} conversations (test cap)`);
        for (let i = 0; i < convLimit; i++) {
            const conv = conversations[i];
            await this.rateLimiter.acquire();

            console.log(`[GeminiFetcher] Clicking conversation ${i + 1}/${conversations.length}: "${conv.title}"`);

            // Step 3b: Click the sidebar entry
            const clickResult = await chrome.scripting.executeScript({
                target: { tabId },
                world: 'MAIN',
                func: (convHref, convIdx, convType) => {
                    // href-based click — find the <a> by its href attribute
                    if (convType === 'href' && convHref) {
                        const link = document.querySelector(`a[href="${convHref}"]`);
                        if (link) {
                            link.click();
                            return true;
                        }
                        // href might have changed (scroll reorder), try partial match
                        const links = document.querySelectorAll('a[href*="/app/"]');
                        for (const l of links) {
                            if (l.getAttribute('href') === convHref) {
                                l.click();
                                return true;
                            }
                        }
                    }

                    // Index-based click (button or generic type)
                    let buttons;
                    if (convType === 'button') {
                        buttons = document.querySelectorAll('side-nav-entry-button');
                    } else {
                        const sidebar = document.querySelector('conversations-list')
                            || document.querySelector('side-navigation-content')
                            || document.querySelector('nav');
                        if (!sidebar) return false;
                        buttons = sidebar.querySelectorAll('a, button, [role="listitem"], [role="button"]');
                    }
                    if (convIdx >= buttons.length) return false;
                    const btn = buttons[convIdx];
                    const clickTarget = btn.querySelector('a, button') || btn;
                    clickTarget.click();
                    return true;
                },
                args: [conv.href || null, conv.idx || 0, conv.type],
            });

            if (!clickResult?.[0]?.result) {
                console.warn(`[GeminiFetcher] Could not click conversation ${i + 1}`);
                processedCount++;
                continue;
            }

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

            // Step 3c: Extract conversation ID from URL and fetch timestamps via direct API call.
            // This bypasses XHR interception issues — we make our OWN fetch using the tab's cookies.
            const turnTimestamps = await this.fetchConversationTimestamps(tabId);

            // Resolve fallback: sidebar group heading → approximate timestamp
            const approxTimestamp = GeminiFetcher.resolveGroupHeadingToTimestamp(conv.groupHeading);

            if (turnTimestamps.length > 0) {
                const validTs = turnTimestamps.filter(t => t != null);
                console.log(`[GeminiFetcher] Got ${validTs.length}/${turnTimestamps.length} exact timestamps for "${conv.title}"`);
                if (validTs.length > 0) {
                    console.log(`[GeminiFetcher] Time range: ${new Date(Math.min(...validTs)).toISOString()} → ${new Date(Math.max(...validTs)).toISOString()}`);
                }
            } else {
                console.log(`[GeminiFetcher] No API timestamps for "${conv.title}", using group heading: "${conv.groupHeading}" → ${new Date(approxTimestamp).toISOString()}`);
            }

            // Step 3d: Extract messages with timestamps
            const messages = await this.extractMessagesFromTab(tabId, conv.title || 'Untitled', `sidebar_${i}`, approxTimestamp, turnTimestamps);

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
     * Fetch exact per-turn timestamps for the currently open conversation.
     *
     * After a conversation is clicked and rendered, we:
     * 1. Extract the conversation ID from the current URL (e.g. /app/c_xxx → c_xxx)
     * 2. Make a direct batchexecute fetch using the tab's cookies
     * 3. Parse the response for timestamp-like epoch values in each turn
     *
     * This avoids XHR interception (which fails because Gemini caches method refs
     * at page load time, before our patches run).
     *
     * @param {number} tabId
     * @returns {Promise<number[]>} Array of epoch ms timestamps, one per turn
     */
    async fetchConversationTimestamps(tabId) {
        try {
            // Extract conversation ID from current URL
            const urlResult = await chrome.scripting.executeScript({
                target: { tabId },
                world: 'MAIN',
                func: () => window.location.pathname,
                args: [],
            });
            const pathname = urlResult?.[0]?.result || '';
            // Extract conversation ID from URL path.
            // Gemini uses two formats:
            //   /app/c_d256defe4aabd853  (c_ prefix + hex)
            //   /app/ec54957d0ff33365    (plain hex, 16+ chars)
            //   /app/0/c_xxx            (occasionally with numeric prefix)
            const convIdMatch = pathname.match(/\/(c_[0-9a-f]+)/) || pathname.match(/\/app\/(?:\d+\/)?([0-9a-f]{12,})/);
            if (!convIdMatch) {
                console.log(`[GeminiFetcher] No conversation ID in URL: ${pathname}`);
                return [];
            }
            const convId = convIdMatch[1];
            console.log(`[GeminiFetcher] Fetching timestamps for conversation: ${convId}`);

            // Try multiple known RPC IDs for conversation detail
            // These rotate with Google deploys, so we try several
            const knownDetailRPCs = [
                'hNvQHb',  // Known from history-load interception (2026-02-28)
                'GIm1Qd',  // Generic/fallback
                'boMsKe',  // Alternate seen in some deploys
            ];

            const rpcId = this.liveParams.conversationDetailRpcId || knownDetailRPCs[0];
            const rpcIds = this.liveParams.conversationDetailRpcId
                ? [this.liveParams.conversationDetailRpcId]
                : knownDetailRPCs;

            for (const tryRpcId of rpcIds) {
                // Build the batchexecute request
                // Try multiple payload formats — Gemini's expected format varies by RPC
                // Format 1: [convId]  (simple)
                // Format 2: [[convId, null, null, ...]]  (nested, seen in hNvQHb)
                const args = JSON.stringify([convId, null, null, [], null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, true]);
                const body = this.buildBatchExecuteBody(tryRpcId, args);
                const params = this.getBatchExecuteParams(tryRpcId);
                const url = `https://gemini.google.com/_/BardChatUi/data/batchexecute?${params}`;

                console.log(`[GeminiFetcher] Trying RPC ${tryRpcId} for conversation timestamps...`);

                // Execute fetch in the tab's context (has auth cookies)
                const fetchResult = await chrome.scripting.executeScript({
                    target: { tabId },
                    world: 'MAIN',
                    func: async (fetchUrl, fetchBody) => {
                        try {
                            const resp = await fetch(fetchUrl, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                                body: fetchBody,
                                credentials: 'include',
                            });
                            if (!resp.ok) {
                                console.log(`[KYT] batchexecute returned ${resp.status}`);
                                return { ok: false, status: resp.status, body: '' };
                            }
                            const text = await resp.text();
                            console.log(`[KYT] batchexecute response: ${text.length} chars`);
                            return { ok: true, status: resp.status, body: text };
                        } catch (e) {
                            console.error('[KYT] batchexecute fetch error:', e.message);
                            return { ok: false, status: 0, body: e.message };
                        }
                    },
                    args: [url, body],
                });

                const result = fetchResult?.[0]?.result;
                if (!result?.ok || !result.body || result.body.length < 100) {
                    console.log(`[GeminiFetcher] RPC ${tryRpcId} returned ${result?.status}, body ${result?.body?.length || 0} chars — trying next`);
                    continue;
                }

                console.log(`[GeminiFetcher] RPC ${tryRpcId}: got ${result.body.length} char response, first 200: ${result.body.substring(0, 200)}`);

                // Parse the batchexecute response for timestamps
                const timestamps = this.extractTimestampsFromResponse(result.body);
                if (timestamps.length > 0) {
                    const validTs = timestamps.filter(t => t != null);
                    if (validTs.length > 0) {
                        console.log(`[GeminiFetcher] RPC ${tryRpcId}: Got ${validTs.length}/${timestamps.length} exact timestamps`);
                        console.log(`[GeminiFetcher] Time range: ${new Date(Math.min(...validTs)).toISOString()} → ${new Date(Math.max(...validTs)).toISOString()}`);
                        // Cache the working RPC ID
                        this.liveParams.conversationDetailRpcId = tryRpcId;
                        return timestamps;
                    }
                }

                console.log(`[GeminiFetcher] RPC ${tryRpcId}: response parsed but no timestamps found`);
            }

            console.log(`[GeminiFetcher] No timestamps from any RPC ID`);
            return [];

        } catch (error) {
            console.error(`[GeminiFetcher] fetchConversationTimestamps error:`, error.message);
            return [];
        }
    }

    /**
     * Parse a batchexecute response body and extract per-turn timestamps.
     *
     * @param {string} responseText - Raw batchexecute response
     * @returns {number[]} Array of epoch ms timestamps (null entries for turns without timestamps)
     */
    extractTimestampsFromResponse(responseText) {
        const timestamps = [];

        try {
            const frames = this.parseBatchExecuteFrames(responseText);
            console.log(`[GeminiFetcher] extractTimestamps: ${frames.length} frames, response ${responseText.length} chars`);

            for (let fi = 0; fi < frames.length; fi++) {
                const frame = frames[fi];
                if (!Array.isArray(frame)) continue;

                // Handle both [[wrb.fr, ...]] and [wrb.fr, ...] structures
                const items = (Array.isArray(frame[0]) && frame[0][0] === 'wrb.fr') ? frame : [frame];

                for (const item of items) {
                    if (!Array.isArray(item) || item[0] !== 'wrb.fr') continue;
                    const rpcId = item[1]; // RPC ID in the response
                    const innerJson = item[2];
                    if (typeof innerJson !== 'string') continue;

                    let data;
                    try { data = JSON.parse(innerJson); } catch { continue; }
                    if (!Array.isArray(data)) continue;

                    console.log(`[GeminiFetcher] Frame ${fi} RPC=${rpcId}: inner data is array[${data.length}]`);

                    // Diagnostic: scan for ALL numbers that look like timestamps anywhere in the data
                    const allTimestamps = [];
                    const scanForTimestamps = (d, path, depth) => {
                        if (depth > 8) return;
                        if (typeof d === 'number' && d > 1700000000 && d < 2100000000000) {
                            const ms = d < 10000000000 ? d * 1000 : d;
                            allTimestamps.push({ value: ms, path, original: d });
                        }
                        if (Array.isArray(d)) {
                            for (let i = 0; i < Math.min(d.length, 20); i++) {
                                scanForTimestamps(d[i], `${path}[${i}]`, depth + 1);
                            }
                        }
                    };
                    scanForTimestamps(data, 'data', 0);

                    if (allTimestamps.length > 0) {
                        console.log(`[GeminiFetcher] Found ${allTimestamps.length} timestamp-like numbers in frame ${fi}:`);
                        for (const ts of allTimestamps.slice(0, 10)) {
                            console.log(`  ${ts.path} = ${ts.original} → ${new Date(ts.value).toISOString()}`);
                        }
                        if (allTimestamps.length > 10) {
                            console.log(`  ... and ${allTimestamps.length - 10} more`);
                        }
                    } else {
                        // Log the structure shape to understand what we got
                        const describeShape = (d, depth) => {
                            if (depth > 3) return '...';
                            if (d === null) return 'null';
                            if (typeof d !== 'object') return typeof d;
                            if (Array.isArray(d)) return `[${d.length}:${d.slice(0, 3).map(x => describeShape(x, depth + 1)).join(',')}]`;
                            return 'obj';
                        };
                        console.log(`[GeminiFetcher] Frame ${fi} shape: ${describeShape(data, 0)}`);
                    }

                    // Search for turns array — contains conversation turn data with timestamps
                    const turns = this.findTurnsArray(data, 0);
                    if (!turns) {
                        console.log(`[GeminiFetcher] Frame ${fi}: findTurnsArray returned null`);
                        continue;
                    }

                    console.log(`[GeminiFetcher] Frame ${fi}: found turns array with ${turns.length} turns`);
                    for (const turn of turns) {
                        const ts = this.extractTimestamp(turn);
                        timestamps.push(ts);
                    }

                    if (timestamps.length > 0) {
                        console.log(`[GeminiFetcher] Extracted ${timestamps.length} timestamps from response frame`);
                        return timestamps;
                    }
                }
            }
        } catch (error) {
            console.error(`[GeminiFetcher] extractTimestampsFromResponse error:`, error.message);
        }

        return timestamps;
    }

    /**
     * Recursively find the turns array in parsed batchexecute conversation data.
     * The turns array is identified by containing sub-arrays with timestamp-like values.
     *
     * @param {any} data
     * @param {number} depth
     * @returns {any[]|null}
     */
    findTurnsArray(data, depth) {
        if (depth > 5 || !Array.isArray(data)) return null;

        // Check if this looks like a turns array:
        // Array of arrays, each with length >= 3, and some contain timestamp-like numbers
        if (data.length > 0 && Array.isArray(data[0]) && data[0].length >= 3) {
            let hasTimestamp = false;
            for (const turn of data) {
                if (!Array.isArray(turn)) continue;
                if (this.extractTimestamp(turn) !== null) {
                    hasTimestamp = true;
                    break;
                }
            }
            if (hasTimestamp) return data;
        }

        // Recurse into sub-arrays
        for (const item of data) {
            const found = this.findTurnsArray(item, depth + 1);
            if (found) return found;
        }
        return null;
    }

    /**
     * Extract messages from the currently visible conversation in a Gemini tab.
     * Shared between sidebar-click flow and any future direct-navigation flow.
     *
     * @param {number} tabId
     * @param {string} title
     * @param {string} conversationId
     * @param {number} [approxTimestamp] - Approximate epoch ms from sidebar group heading
     * @param {number[]} [turnTimestamps] - Per-turn exact timestamps from XHR response
     * @returns {Promise<Message[]>}
     */
    async extractMessagesFromTab(tabId, title, conversationId, approxTimestamp, turnTimestamps) {
        try {
            const execResult = await chrome.scripting.executeScript({
                target: { tabId },
                world: 'MAIN',
                func: () => {
                    const messages = [];

                    // ── Helper: extract timestamp from ARIA/title/tooltip attributes ──
                    // Gemini hides timestamps in ARIA labels for accessibility.
                    // Formats: "Message sent at 10:45 AM", "2 days ago",
                    //          "May 22, 2025 at 3:15 PM", "Yesterday at 2:30 PM"
                    function extractAriaTimestamp(el) {
                        if (!el) return null;

                        // Search the element and its ancestors/children for aria-label/title
                        const candidates = [el];
                        if (el.parentElement) candidates.push(el.parentElement);
                        if (el.parentElement?.parentElement) candidates.push(el.parentElement.parentElement);
                        // Also check children with aria-label
                        el.querySelectorAll('[aria-label], [title], [data-timestamp], [data-time]').forEach(c => candidates.push(c));

                        for (const candidate of candidates) {
                            const ariaLabel = candidate.getAttribute?.('aria-label')
                                || candidate.getAttribute?.('title')
                                || candidate.getAttribute?.('data-timestamp')
                                || candidate.getAttribute?.('data-time')
                                || '';

                            if (!ariaLabel) continue;

                            // Direct epoch in data attribute
                            if (/^\d{10,13}$/.test(ariaLabel.trim())) {
                                const n = parseInt(ariaLabel.trim(), 10);
                                return n < 10000000000 ? n * 1000 : n;
                            }

                            // Full date-time: "May 22, 2025 at 3:15 PM" or "March 5, 2026, 10:45 AM"
                            const fullDateMatch = ariaLabel.match(
                                /(\w+ \d{1,2},?\s*\d{4})\s*(?:at\s*)?(\d{1,2}:\d{2}\s*[AP]M)/i
                            );
                            if (fullDateMatch) {
                                const d = new Date(`${fullDateMatch[1]} ${fullDateMatch[2]}`);
                                if (!isNaN(d.getTime())) return d.getTime();
                            }

                            // ISO 8601
                            const isoMatch = ariaLabel.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
                            if (isoMatch) {
                                const d = new Date(isoMatch[0]);
                                if (!isNaN(d.getTime())) return d.getTime();
                            }

                            // "sent at HH:MM AM/PM" (today)
                            const sentAtMatch = ariaLabel.match(/(?:sent|received|created)\s+at\s+(\d{1,2}:\d{2}\s*[AP]M)/i);
                            if (sentAtMatch) {
                                const today = new Date();
                                const d = new Date(`${today.toDateString()} ${sentAtMatch[1]}`);
                                if (!isNaN(d.getTime())) return d.getTime();
                            }

                            // "X days/hours/minutes ago"
                            const agoMatch = ariaLabel.match(/(\d+)\s*(minute|hour|day|week|month)s?\s*ago/i);
                            if (agoMatch) {
                                const n = parseInt(agoMatch[1], 10);
                                const unit = agoMatch[2].toLowerCase();
                                const ms = { minute: 60000, hour: 3600000, day: 86400000, week: 604800000, month: 2592000000 };
                                return Date.now() - n * (ms[unit] || 86400000);
                            }

                            // "Yesterday at HH:MM"
                            const yesterdayMatch = ariaLabel.match(/yesterday\s+at\s+(\d{1,2}:\d{2}\s*[AP]M)/i);
                            if (yesterdayMatch) {
                                const d = new Date();
                                d.setDate(d.getDate() - 1);
                                const t = new Date(`${d.toDateString()} ${yesterdayMatch[1]}`);
                                if (!isNaN(t.getTime())) return t.getTime();
                            }
                        }

                        return null;
                    }

                    // ═══ Strategy 1: Gemini custom web components ═══
                    const userQueries = document.querySelectorAll('user-query, USER-QUERY');
                    const modelResponses = document.querySelectorAll('model-response, MODEL-RESPONSE');

                    // Diagnostic: scan for ANY aria-label or title attributes in conversation area
                    const convArea = document.querySelector('infinite-scroller') || document.querySelector('main') || document.body;
                    const ariaEls = convArea.querySelectorAll('[aria-label], [title], [data-timestamp], [data-time]');
                    const ariaTimestampHits = [];
                    ariaEls.forEach(el => {
                        const label = el.getAttribute('aria-label') || el.getAttribute('title') || '';
                        if (label && /\d/.test(label) && (
                            /sent|received|ago|at \d|AM|PM|\d{4}/i.test(label)
                        )) {
                            ariaTimestampHits.push({ tag: el.tagName, label: label.substring(0, 100) });
                        }
                    });
                    if (ariaTimestampHits.length > 0) {
                        console.log(`[KYT extract] Found ${ariaTimestampHits.length} ARIA timestamp candidates:`);
                        ariaTimestampHits.slice(0, 5).forEach(h => console.log(`  <${h.tag}> aria-label="${h.label}"`));
                    } else {
                        console.log(`[KYT extract] No ARIA timestamp attributes found (scanned ${ariaEls.length} elements)`);
                        // Broader diagnostic: dump ALL aria-labels in conversation area
                        const allAria = [];
                        convArea.querySelectorAll('[aria-label]').forEach(el => {
                            const label = el.getAttribute('aria-label');
                            if (label && label.length > 3 && label.length < 200) {
                                allAria.push(`<${el.tagName.toLowerCase()}> "${label.substring(0, 80)}"`);
                            }
                        });
                        if (allAria.length > 0) {
                            console.log(`[KYT extract] All aria-labels in conv area (${allAria.length}):`);
                            allAria.slice(0, 10).forEach(a => console.log(`  ${a}`));
                            if (allAria.length > 10) console.log(`  ... and ${allAria.length - 10} more`);
                        }
                    }

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
                        // Extract user messages with ARIA timestamps
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
                                const ariaTs = extractAriaTimestamp(uq);
                                messages.push({ role: 'user', text: text.trim(), idx, ariaTs });
                            }
                        });

                        // Extract model responses with ARIA timestamps
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
                                const ariaTs = extractAriaTimestamp(mr);
                                messages.push({ role: 'assistant', text, idx, ariaTs });
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

            // Timestamp resolution priority:
            // 1. Per-message ARIA timestamps from DOM (best — exact per message)
            // 2. Exact per-turn timestamps from API batchexecute response
            // 3. Approximate timestamp from sidebar group heading (month-level)
            // 4. Date.now() fallback (worst — everything looks like today)
            const baseTime = approxTimestamp || Date.now();
            const hasExactTimestamps = Array.isArray(turnTimestamps) && turnTimestamps.some(t => t != null);
            const hasAriaTimestamps = scraped.some(m => m.ariaTs != null);

            if (hasAriaTimestamps) {
                const ariaCount = scraped.filter(m => m.ariaTs != null).length;
                console.log(`[GeminiFetcher] Using ARIA timestamps: ${ariaCount}/${scraped.length} messages have exact times`);
            }

            return scraped.map((msg, i) => {
                let timestamp;

                // Priority 1: ARIA timestamp from DOM
                if (msg.ariaTs) {
                    timestamp = msg.ariaTs;
                }
                // Priority 2: API turn timestamps
                else if (hasExactTimestamps) {
                    const turnIdx = Math.floor(i / 2);
                    const turnTs = turnIdx < turnTimestamps.length ? turnTimestamps[turnIdx] : null;
                    if (turnTs) {
                        timestamp = msg.role === 'assistant' ? turnTs + 1000 : turnTs;
                    } else {
                        const prevTs = turnTimestamps.slice(0, turnIdx).reverse().find(t => t != null);
                        const nextTs = turnTimestamps.slice(turnIdx + 1).find(t => t != null);
                        if (prevTs && nextTs) {
                            timestamp = prevTs + (nextTs - prevTs) * (turnIdx / turnTimestamps.length);
                        } else {
                            timestamp = prevTs || nextTs || baseTime;
                        }
                        timestamp += (msg.role === 'assistant' ? 1000 : 0);
                    }
                }
                // Priority 3/4: Group heading or Date.now()
                else {
                    timestamp = baseTime + i * 60000;
                }

                return {
                    id: `${conversationId}_dom_${i}`,
                    conversationId,
                    conversationTitle: title || 'Untitled',
                    content: msg.text,
                    role: msg.role,
                    timestamp,
                    platform: 'gemini',
                };
            });

        } catch (error) {
            console.error(`[GeminiFetcher] Extract failed for ${conversationId}:`, error.message);
            return [];
        }
    }

    /**
     * Convert a Gemini sidebar group heading to an approximate epoch timestamp.
     *
     * Gemini groups sidebar conversations under headings like:
     *   "Today", "Yesterday", "Previous 7 days", "Previous 30 days",
     *   "January 2026", "December 2025", "May 2025", etc.
     *
     * Returns a midpoint timestamp for the period. For month headings,
     * returns the 15th of that month at noon UTC.
     *
     * @param {string|null|undefined} heading
     * @returns {number} epoch milliseconds (falls back to Date.now())
     */
    static resolveGroupHeadingToTimestamp(heading) {
        if (!heading) return Date.now();

        const h = heading.trim().toLowerCase();
        const now = new Date();

        // "today"
        if (h === 'today') {
            return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12, 0, 0).getTime();
        }

        // "yesterday"
        if (h === 'yesterday') {
            const d = new Date(now);
            d.setDate(d.getDate() - 1);
            return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12, 0, 0).getTime();
        }

        // "previous 7 days" / "last 7 days" / "past 7 days" / "past week"
        if (/(?:previous|last|past)\s*7\s*days|past\s*week/i.test(h)) {
            const d = new Date(now);
            d.setDate(d.getDate() - 4); // midpoint of 2-7 days ago
            return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12, 0, 0).getTime();
        }

        // "previous 30 days" / "last 30 days" / "past 30 days" / "past month"
        if (/(?:previous|last|past)\s*30\s*days|past\s*month/i.test(h)) {
            const d = new Date(now);
            d.setDate(d.getDate() - 18); // midpoint of 7-30 days ago
            return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12, 0, 0).getTime();
        }

        // Month-year pattern: "May 2025", "January 2026", "Dec 2025", etc.
        const monthNames = {
            january: 0, jan: 0, february: 1, feb: 1, march: 2, mar: 2,
            april: 3, apr: 3, may: 4, june: 5, jun: 5, july: 6, jul: 6,
            august: 7, aug: 7, september: 8, sep: 8, sept: 8,
            october: 9, oct: 9, november: 10, nov: 10, december: 11, dec: 11,
        };
        const monthYearMatch = h.match(/^(\w+)\s+(\d{4})$/);
        if (monthYearMatch) {
            const monthName = monthYearMatch[1].toLowerCase();
            const year = parseInt(monthYearMatch[2], 10);
            if (monthName in monthNames) {
                return new Date(year, monthNames[monthName], 15, 12, 0, 0).getTime();
            }
        }

        // Fallback: couldn't parse heading
        console.log(`[GeminiFetcher] Unknown sidebar group heading: "${heading}"`);
        return Date.now();
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
