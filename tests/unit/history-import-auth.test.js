/**
 * History Import — JWT auth threading tests
 *
 * The 2026-06-11 service-role gate made save_chat_turn_batch reject anon-key
 * Bearers with 401. These tests pin the fix: HistoryImporter and
 * ProgressTracker must send the user JWT as Authorization (anon key stays as
 * apikey), and must refresh + retry once on 401.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HistoryImporter } from '../../src/history-import/index.js';
import { ProgressTracker } from '../../src/history-import/progress-tracker.js';

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

function errResponse(status, body = 'error', headers = {}) {
    return {
        ok: false,
        status,
        headers: { get: (name) => headers[name] ?? null },
        json: () => Promise.resolve({ error: body }),
        text: () => Promise.resolve(body),
    };
}

function makeMessage(overrides = {}) {
    return {
        id: 'msg-1',
        content: 'hello world',
        role: 'user',
        timestamp: Date.now(),
        conversationId: 'conv-1',
        platform: 'chatgpt',
        ...overrides,
    };
}

describe('HistoryImporter JWT auth', () => {
    beforeEach(() => {
        global.fetch = vi.fn();
    });

    it('processBatch sends JWT as Authorization and anon key as apikey', async () => {
        global.fetch.mockResolvedValue(okResponse());
        const importer = new HistoryImporter(SUPABASE_URL, ANON_KEY, USER_ID, {
            accessToken: JWT,
        });

        await importer.processBatch([makeMessage()]);

        expect(global.fetch).toHaveBeenCalledTimes(1);
        const [, opts] = global.fetch.mock.calls[0];
        expect(opts.headers['Authorization']).toBe(`Bearer ${JWT}`);
        expect(opts.headers['apikey']).toBe(ANON_KEY);
    });

    it('processBatch falls back to anon key Bearer when no accessToken (legacy)', async () => {
        global.fetch.mockResolvedValue(okResponse());
        const importer = new HistoryImporter(SUPABASE_URL, ANON_KEY, USER_ID, {});

        await importer.processBatch([makeMessage()]);

        const [, opts] = global.fetch.mock.calls[0];
        expect(opts.headers['Authorization']).toBe(`Bearer ${ANON_KEY}`);
    });

    it('processBatch refreshes token and retries once on 401', async () => {
        global.fetch
            .mockResolvedValueOnce(errResponse(401, 'Authentication required'))
            .mockResolvedValueOnce(okResponse());
        const refreshAccessToken = vi.fn().mockResolvedValue('fresh-jwt');
        const importer = new HistoryImporter(SUPABASE_URL, ANON_KEY, USER_ID, {
            accessToken: 'stale-jwt',
            refreshAccessToken,
            retryBaseDelayMs: 1,
        });

        await importer.processBatch([makeMessage()]);

        expect(refreshAccessToken).toHaveBeenCalledTimes(1);
        expect(global.fetch).toHaveBeenCalledTimes(2);
        const [, retryOpts] = global.fetch.mock.calls[1];
        expect(retryOpts.headers['Authorization']).toBe('Bearer fresh-jwt');
    });

    it('processBatch throws immediately on 401 when no refresh is possible', async () => {
        global.fetch.mockResolvedValue(errResponse(401, 'Authentication required'));
        const importer = new HistoryImporter(SUPABASE_URL, ANON_KEY, USER_ID, {
            accessToken: 'stale-jwt',
            retryBaseDelayMs: 1,
        });

        await expect(importer.processBatch([makeMessage()])).rejects.toThrow();
        // Auth failures don't heal via blind retries — exactly one attempt.
        expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it('processBatch still retries transient 5xx errors then throws', async () => {
        global.fetch.mockResolvedValue(errResponse(500, 'boom'));
        const importer = new HistoryImporter(SUPABASE_URL, ANON_KEY, USER_ID, {
            accessToken: JWT,
            retryBaseDelayMs: 1,
        });

        await expect(importer.processBatch([makeMessage()])).rejects.toThrow();
        // 1 initial + 3 retries
        expect(global.fetch).toHaveBeenCalledTimes(4);
    });

    it('checkImportStatus sends JWT as Authorization', async () => {
        global.fetch.mockResolvedValue(okResponse([]));
        const importer = new HistoryImporter(SUPABASE_URL, ANON_KEY, USER_ID, {
            accessToken: JWT,
        });

        await importer.checkImportStatus('chatgpt');

        expect(global.fetch.mock.calls.length).toBeGreaterThanOrEqual(1);
        for (const [, opts] of global.fetch.mock.calls) {
            expect(opts.headers['Authorization']).toBe(`Bearer ${JWT}`);
            expect(opts.headers['apikey']).toBe(ANON_KEY);
        }
    });
});

describe('ProgressTracker JWT auth', () => {
    beforeEach(() => {
        global.fetch = vi.fn();
    });

    it('syncToServer uses the auth headers provider when given', async () => {
        global.fetch.mockResolvedValue(okResponse());
        const getAuthHeaders = () => ({
            'apikey': ANON_KEY,
            'Authorization': `Bearer ${JWT}`,
            'Content-Type': 'application/json',
        });
        const tracker = new ProgressTracker(
            SUPABASE_URL, ANON_KEY, USER_ID, 'chatgpt', getAuthHeaders
        );

        await tracker.syncToServer();

        const [, opts] = global.fetch.mock.calls[0];
        expect(opts.headers['Authorization']).toBe(`Bearer ${JWT}`);
    });

    it('syncToServer keeps legacy anon headers when no provider given', async () => {
        global.fetch.mockResolvedValue(okResponse());
        const tracker = new ProgressTracker(SUPABASE_URL, ANON_KEY, USER_ID, 'chatgpt');

        await tracker.syncToServer();

        const [, opts] = global.fetch.mock.calls[0];
        expect(opts.headers['Authorization']).toBe(`Bearer ${ANON_KEY}`);
    });
});
