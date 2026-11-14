/**
 * Reranker providers (supabase/functions/_shared/rerank-provider.ts).
 * Regression for 2026-11-14: every rerank call failed with
 * "Model not supported by provider scaleway" and search silently used
 * un-reranked order.
 */
import { describe, it, expect } from 'vitest';
import {
    RERANK_PROVIDERS,
    RERANK_DOC_CHARS,
    parsePairScores,
    parseRerankResults,
    rerankWithFallback,
    rerankProviders,
    RERANK_TIMEOUT_MS,
} from '../../supabase/functions/_shared/rerank-provider.ts';

describe('parsePairScores', () => {
    it('reads one {label, score} per pair, flat or nested', () => {
        expect(parsePairScores([{ label: 'LABEL_0', score: 0.9 }, { label: 'LABEL_0', score: 0.1 }], 2))
            .toEqual([{ index: 0, score: 0.9 }, { index: 1, score: 0.1 }]);
        expect(parsePairScores([[{ label: 'LABEL_0', score: 0.9 }], [{ label: 'LABEL_0', score: 0.1 }]], 2))
            .toEqual([{ index: 0, score: 0.9 }, { index: 1, score: 0.1 }]);
        expect(parsePairScores([[{ label: 'LABEL_0', score: 0.9 }, { label: 'LABEL_0', score: 0.1 }]], 2)).toHaveLength(2);
        expect(parsePairScores([0.7, 0.2], 2)).toEqual([{ index: 0, score: 0.7 }, { index: 1, score: 0.2 }]);
    });

    it('refuses a reply with the wrong number of rows or no score', () => {
        expect(() => parsePairScores([{ label: 'LABEL_0', score: 0.9 }], 2)).toThrow(/1 rows for 2 pairs/);
        expect(() => parsePairScores({ error: 'nope' }, 2)).toThrow(/shape/);
        expect(() => parsePairScores([{ label: 'x' }, { label: 'y' }], 2)).toThrow(/no score/);
    });
});

describe('parseRerankResults', () => {
    it('reads index with relevance_score or score and drops out-of-range rows', () => {
        expect(parseRerankResults({ results: [{ index: 1, relevance_score: 0.8 }, { index: 0, score: 0.3 }, { index: 7, score: 0.9 }] }, 2))
            .toEqual([{ index: 1, score: 0.8 }, { index: 0, score: 0.3 }]);
        expect(() => parseRerankResults({ results: [] }, 2)).toThrow();
    });
});

describe('rerankWithFallback', () => {
    it('asks Hugging Face inference first with query and document as a pair', async () => {
        const calls = [];
        const out = await rerankWithFallback('q', ['a', 'b'], async (provider, body) => {
            calls.push([provider.name, body]);
            return [{ label: 'LABEL_0', score: 0.2 }, { label: 'LABEL_0', score: 0.7 }];
        });
        expect(calls).toHaveLength(1);
        expect(calls[0][0]).toBe('hf-inference');
        expect(calls[0][1]).toEqual({ inputs: [{ text: 'q', text_pair: 'a' }, { text: 'q', text_pair: 'b' }] });
        expect(out.provider).toBe('hf-inference');
        expect(out.scores).toEqual([{ index: 1, score: 0.7 }, { index: 0, score: 0.2 }]);
    });

    it('falls to the next provider when one fails or replies in an unusable shape', async () => {
        const out = await rerankWithFallback('q', ['a', 'b'], async (provider) => {
            if (provider.name === 'hf-inference') return { error: 'bad input' };
            return { results: [{ index: 0, relevance_score: 0.6 }, { index: 1, relevance_score: 0.1 }] };
        });
        expect(out.provider).toBe('scaleway');
        expect(out.failures[0]).toMatch(/^hf-inference: /);
    });

    it('throws with every provider named when all fail', async () => {
        await expect(rerankWithFallback('q', ['a'], async (provider) => { throw new Error(`${provider.name} down`); }))
            .rejects.toThrow(/HF Rerank API Error: hf-inference: hf-inference down \| scaleway: scaleway down/);
    });

    it('caps document length', async () => {
        let sent;
        await rerankWithFallback('q', ['x'.repeat(RERANK_DOC_CHARS + 500)], async (_p, body) => { sent = body; return [{ score: 0.5 }]; });
        expect(sent.inputs[0].text_pair).toHaveLength(RERANK_DOC_CHARS);
        expect(RERANK_PROVIDERS.map((p) => p.name)).toEqual(['hf-inference', 'scaleway']);
    });
});

describe('rerankProviders', () => {
    it('uses only the shared providers when no endpoint is set or the value is not an https address', () => {
        expect(rerankProviders(undefined)).toBe(RERANK_PROVIDERS);
        expect(rerankProviders('')).toBe(RERANK_PROVIDERS);
        expect(rerankProviders('not a url')).toBe(RERANK_PROVIDERS);
        expect(rerankProviders('http://insecure.example')).toBe(RERANK_PROVIDERS);
    });

    it('puts a dedicated endpoint first and asks it in the /rerank form', async () => {
        const providers = rerankProviders(' https://abc123.endpoints.example.cloud/ ');
        expect(providers.map((p) => p.name)).toEqual(['dedicated', 'hf-inference', 'scaleway']);
        expect(providers[0].url).toBe('https://abc123.endpoints.example.cloud/rerank');
        expect(rerankProviders('https://abc123.endpoints.example.cloud/rerank')[0].url).toBe('https://abc123.endpoints.example.cloud/rerank');
        const calls = [];
        const out = await rerankWithFallback('q', ['a', 'b'], async (provider, body) => {
            calls.push([provider.name, body]);
            return [{ index: 1, score: 0.9 }, { index: 0, score: 0.1 }];
        }, providers);
        expect(calls).toEqual([['dedicated', { query: 'q', texts: ['a', 'b'] }]]);
        expect(out.scores[0]).toEqual({ index: 1, score: 0.9 });
    });

    it('falls to the shared provider while the dedicated endpoint is asleep', async () => {
        const out = await rerankWithFallback('q', ['a'], async (provider) => {
            if (provider.name === 'dedicated') throw new Error('502 - Bad Gateway');
            return [{ label: 'LABEL_0', score: 0.4 }];
        }, rerankProviders('https://abc123.endpoints.example.cloud'));
        expect(out.provider).toBe('hf-inference');
        expect(out.failures).toEqual(['dedicated: 502 - Bad Gateway']);
    });

    it('does not wait longer than 5 seconds per provider', () => {
        expect(RERANK_TIMEOUT_MS).toBeLessThanOrEqual(5000);
    });
});
