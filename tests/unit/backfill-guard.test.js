/**
 * Backfill auth guard — edge-fn backfill alarms (contextual, entities,
 * gravity, emotions, token counts) require a JWT session. When the user is
 * signed out (fresh unpacked load, expired refresh token) the alarms must
 * skip quietly with a long retry instead of erroring every 10 minutes with
 * "Not authenticated and no API keys configured".
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setupChromeMocks } from '../setup.js';

setupChromeMocks();

const mockGetRoutingMode = vi.fn();
vi.mock('../../src/auth-config.js', () => ({
    getRoutingMode: (...args) => mockGetRoutingMode(...args),
}));

const { backfillAuthReady, BACKFILL_AUTH_RETRY_MINUTES } =
    await import('../../src/backfill-guard.js');

describe('backfillAuthReady', () => {
    beforeEach(() => {
        mockGetRoutingMode.mockReset();
        chrome.alarms.create.mockClear();
    });

    it('returns true in edge (JWT) mode without touching alarms', async () => {
        mockGetRoutingMode.mockResolvedValue('edge');

        expect(await backfillAuthReady('backfillContextual')).toBe(true);
        expect(chrome.alarms.create).not.toHaveBeenCalled();
    });

    it('skips and re-arms with a long delay when unconfigured (signed out)', async () => {
        mockGetRoutingMode.mockResolvedValue('unconfigured');

        expect(await backfillAuthReady('backfillContextual')).toBe(false);
        expect(chrome.alarms.create).toHaveBeenCalledWith(
            'backfillContextual',
            { delayInMinutes: BACKFILL_AUTH_RETRY_MINUTES }
        );
        expect(BACKFILL_AUTH_RETRY_MINUTES).toBeGreaterThanOrEqual(30);
    });

    it('skips in legacy mode too — gated edge fns reject anon keys', async () => {
        mockGetRoutingMode.mockResolvedValue('legacy');

        expect(await backfillAuthReady('backfillEntities')).toBe(false);
        expect(chrome.alarms.create).toHaveBeenCalledWith(
            'backfillEntities',
            { delayInMinutes: BACKFILL_AUTH_RETRY_MINUTES }
        );
    });

    it('fails closed (skip, re-arm) when the routing check itself throws', async () => {
        mockGetRoutingMode.mockRejectedValue(new Error('storage unavailable'));

        expect(await backfillAuthReady('backfillGravity')).toBe(false);
        expect(chrome.alarms.create).toHaveBeenCalledWith(
            'backfillGravity',
            { delayInMinutes: BACKFILL_AUTH_RETRY_MINUTES }
        );
    });

    it('allowLegacy lets legacy-key mode run (client-side embeddings backfill)', async () => {
        mockGetRoutingMode.mockResolvedValue('legacy');

        expect(await backfillAuthReady('backfillEmbeddings', { allowLegacy: true })).toBe(true);
        expect(chrome.alarms.create).not.toHaveBeenCalled();
    });

    it('allowLegacy still skips when fully unconfigured', async () => {
        mockGetRoutingMode.mockResolvedValue('unconfigured');

        expect(await backfillAuthReady('backfillEmbeddings', { allowLegacy: true })).toBe(false);
        expect(chrome.alarms.create).toHaveBeenCalledWith(
            'backfillEmbeddings',
            { delayInMinutes: BACKFILL_AUTH_RETRY_MINUTES }
        );
    });
});
