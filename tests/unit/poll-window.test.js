/**
 * Poller 90-day window — the conversation poller's first run must respect
 * the documented 90-day import window. Observed in prod (2026-07-06): a
 * fresh profile's first pollChatGPT imported full conversation histories
 * with messages from 2025 (187/288 rows older than 90 days) because the
 * checkpoint guard is skipped when lastUpdateTime is null and messages
 * are never date-filtered.
 */

import { describe, it, expect } from 'vitest';
import {
    POLL_WINDOW_MS,
    pollCutoffMs,
    filterMessagesToWindow,
} from '../../src/history-import/poll-window.js';

const NOW = 1_800_000_000_000; // fixed ms epoch
const DAY = 24 * 60 * 60 * 1000;

describe('pollCutoffMs', () => {
    it('uses the checkpoint when one exists (incremental mode)', () => {
        expect(pollCutoffMs(NOW - 5 * DAY, NOW)).toBe(NOW - 5 * DAY);
    });

    it('falls back to 90 days ago on first run (no checkpoint)', () => {
        expect(pollCutoffMs(null, NOW)).toBe(NOW - POLL_WINDOW_MS);
        expect(pollCutoffMs(undefined, NOW)).toBe(NOW - POLL_WINDOW_MS);
        expect(pollCutoffMs(0, NOW)).toBe(NOW - POLL_WINDOW_MS);
    });

    it('POLL_WINDOW_MS is 90 days', () => {
        expect(POLL_WINDOW_MS).toBe(90 * DAY);
    });
});

describe('filterMessagesToWindow', () => {
    const msg = (timestamp) => ({ content: 'x', role: 'user', timestamp });

    it('keeps messages inside the window, drops older ones', () => {
        const cutoff = NOW - POLL_WINDOW_MS;
        const messages = [
            msg(NOW - DAY),                    // recent — keep
            msg(cutoff),                       // exactly at cutoff — keep
            msg(cutoff - 1),                   // just outside — drop
            msg(NOW - 400 * DAY),              // last year — drop
        ];

        const kept = filterMessagesToWindow(messages, cutoff);
        expect(kept).toHaveLength(2);
        expect(kept.every(m => m.timestamp >= cutoff)).toBe(true);
    });

    it('drops messages with missing or non-numeric timestamps', () => {
        const cutoff = NOW - POLL_WINDOW_MS;
        const messages = [msg(null), msg(undefined), msg(NaN), msg('2026-01-01'), msg(NOW)];

        const kept = filterMessagesToWindow(messages, cutoff);
        expect(kept).toHaveLength(1);
        expect(kept[0].timestamp).toBe(NOW);
    });

    it('returns empty for empty input', () => {
        expect(filterMessagesToWindow([], NOW)).toEqual([]);
    });
});
