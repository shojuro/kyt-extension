/**
 * History Import — 429 backoff + chunking tests
 *
 * Free tier allows 20 save_chat_turn_batch calls/min. The import must honor
 * Retry-After on 429 (separate budget from transient-error retries) and save
 * in chunks of 50 (the edge function's MAX_BATCH_SIZE) instead of 10.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HistoryImporter, IMPORT_SAVE_CHUNK_SIZE } from '../../src/history-import/index.js';
import { parseRetryAfterMs } from '../../src/history-import/rate-limiter.js';

const SUPABASE_URL = 'https://example.supabase.co';
const ANON_KEY = 'anon-key-value';
const USER_ID = 'user-1234';
const JWT = 'user-jwt-token';

function okResponse(body = {}) {
    return {
        ok: true,
        status: 200,
        json: () => Promise.resolve(body),
        text: () => Promise.resolve(JSON.stringify(body)),
    };
}

function rateLimitResponse(retryAfter) {
    return {
        ok: false,
        status: 429,
        headers: { get: (name) => (name.toLowerCase() === 'retry-after' ? retryAfter : null) },
        json: () => Promise.resolve({ error: 'Rate limit exceeded' }),
        text: () => Promise.resolve('Rate limit exceeded'),
    };
}

function makeMessages(count) {
    return Array.from({ length: count }, (_, i) => ({
        id: `msg-${i}`,
        content: `message ${i}`,
        role: 'user',
        timestamp: Date.now(),
        conversationId: 'conv-1',
        platform: 'chatgpt',
    }));
}

describe('parseRetryAfterMs', () => {
    it('parses integer seconds to milliseconds', () => {
        expect(parseRetryAfterMs('2')).toBe(2000);
        expect(parseRetryAfterMs('0')).toBe(0);
    });

    it('falls back to default for missing or garbage values', () => {
        expect(parseRetryAfterMs(null, { defaultMs: 30000 })).toBe(30000);
        expect(parseRetryAfterMs('soon', { defaultMs: 30000 })).toBe(30000);
        expect(parseRetryAfterMs('-5', { defaultMs: 30000 })).toBe(30000);
    });

    it('caps waits at maxMs', () => {
        expect(parseRetryAfterMs('600', { maxMs: 120000 })).toBe(120000);
    });
});

describe('processBatch 429 handling', () => {
    beforeEach(() => {
        global.fetch = vi.fn();
    });

    it('waits per Retry-After and retries until success', async () => {
        global.fetch
            .mockResolvedValueOnce(rateLimitResponse('0'))
            .mockResolvedValueOnce(rateLimitResponse('0'))
            .mockResolvedValueOnce(okResponse());
        const importer = new HistoryImporter(SUPABASE_URL, ANON_KEY, USER_ID, {
            accessToken: JWT,
            retryBaseDelayMs: 1,
        });

        await importer.processBatch(makeMessages(3));

        expect(global.fetch).toHaveBeenCalledTimes(3);
    });

    it('survives more 429s than the transient-error retry cap', async () => {
        // 4 consecutive 429s would exhaust the old 3-retry cap; the
        // rate-limit budget must be separate.
        global.fetch
            .mockResolvedValueOnce(rateLimitResponse('0'))
            .mockResolvedValueOnce(rateLimitResponse('0'))
            .mockResolvedValueOnce(rateLimitResponse('0'))
            .mockResolvedValueOnce(rateLimitResponse('0'))
            .mockResolvedValueOnce(okResponse());
        const importer = new HistoryImporter(SUPABASE_URL, ANON_KEY, USER_ID, {
            accessToken: JWT,
            retryBaseDelayMs: 1,
        });

        await importer.processBatch(makeMessages(3));

        expect(global.fetch).toHaveBeenCalledTimes(5);
    });

    it('gives up after the rate-limit retry budget is exhausted', async () => {
        global.fetch.mockResolvedValue(rateLimitResponse('0'));
        const importer = new HistoryImporter(SUPABASE_URL, ANON_KEY, USER_ID, {
            accessToken: JWT,
            retryBaseDelayMs: 1,
        });

        await expect(importer.processBatch(makeMessages(3))).rejects.toThrow(/rate limit/i);
        // 1 initial + 5 rate-limit retries
        expect(global.fetch).toHaveBeenCalledTimes(6);
    });
});

describe('saveMessagesInChunks', () => {
    it('splits messages into chunks of IMPORT_SAVE_CHUNK_SIZE (50)', async () => {
        const importer = new HistoryImporter(SUPABASE_URL, ANON_KEY, USER_ID, {
            accessToken: JWT,
        });
        importer.processBatch = vi.fn().mockResolvedValue(undefined);

        await importer.saveMessagesInChunks(makeMessages(120));

        expect(IMPORT_SAVE_CHUNK_SIZE).toBe(50);
        expect(importer.processBatch).toHaveBeenCalledTimes(3);
        expect(importer.processBatch.mock.calls[0][0]).toHaveLength(50);
        expect(importer.processBatch.mock.calls[1][0]).toHaveLength(50);
        expect(importer.processBatch.mock.calls[2][0]).toHaveLength(20);
    });

    it('handles an empty message list without calling processBatch', async () => {
        const importer = new HistoryImporter(SUPABASE_URL, ANON_KEY, USER_ID, {});
        importer.processBatch = vi.fn();

        await importer.saveMessagesInChunks([]);

        expect(importer.processBatch).not.toHaveBeenCalled();
    });
});
