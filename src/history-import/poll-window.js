/**
 * 90-day window helpers for the conversation poller.
 *
 * The poller's documented contract is "on first run, imports 90 days of
 * history". Two enforcement points:
 *   1. Conversation level — stop paging when a conversation's update time
 *      is older than the checkpoint (incremental) or 90 days (first run).
 *   2. Message level — a recently-updated conversation can contain messages
 *      years older than its update time; those must not be imported.
 *
 * Observed in production (2026-07-06): a fresh profile's first pollChatGPT
 * run imported 2025-dated messages because neither point was enforced.
 */

export const POLL_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Conversation-level cutoff: checkpoint when it exists, else 90 days back.
 * @param {number|null|undefined} lastUpdateTime Poller checkpoint (ms)
 * @param {number} [nowMs]
 * @returns {number}
 */
export function pollCutoffMs(lastUpdateTime, nowMs = Date.now()) {
    return lastUpdateTime || (nowMs - POLL_WINDOW_MS);
}

/**
 * Message-level filter: keep only messages with a finite timestamp inside
 * the window. Non-numeric/missing timestamps are dropped — same semantics
 * as the manual importer's cutoff filter (NaN never passes).
 *
 * @param {Array<{timestamp?: number}>} messages
 * @param {number} cutoffMs
 * @returns {Array}
 */
export function filterMessagesToWindow(messages, cutoffMs) {
    return messages.filter(
        m => typeof m.timestamp === 'number' && Number.isFinite(m.timestamp) && m.timestamp >= cutoffMs
    );
}
