/**
 * Embedding provider route (supabase/functions/_shared/embedding-provider.ts).
 *
 * Regression for 2026-11-13: the Scaleway route through Hugging Face answered
 * every call with HTTP 402 ("Pay-as-you go is not enabled for provider
 * scaleway yet"), so nothing was embedded or searchable. Embeddings now go to
 * DeepInfra through the same Hugging Face router, same model
 * (Qwen3-Embedding-8B), verified against stored vectors.
 */
import { describe, it, expect } from 'vitest';
import {
    EMBEDDING_URL,
    EMBEDDING_MODEL,
    TARGET_DIMS,
    buildEmbeddingRequest,
    EMBEDDING_PROVIDERS,
    embedWithFallback,
    parseEmbeddingResponse,
} from '../../supabase/functions/_shared/embedding-provider.ts';

/** A 4096-dim vector whose first value is `first` and the rest `rest`. */
function fullVector(first, rest = 0.01) {
    const v = new Array(4096).fill(rest);
    v[0] = first;
    return v;
}

describe('embedding provider route', () => {
    it('does not send embeddings to the Scaleway route', () => {
        expect(EMBEDDING_URL).not.toMatch(/scaleway/i);
    });

    it('targets DeepInfra through the Hugging Face router with the Hub model id', () => {
        const { url, body } = buildEmbeddingRequest('hello');
        expect(url).toBe('https://router.huggingface.co/deepinfra/v1/openai/embeddings');
        expect(body).toEqual({ input: 'hello', model: 'Qwen/Qwen3-Embedding-8B' });
        expect(EMBEDDING_MODEL).toBe('Qwen/Qwen3-Embedding-8B');
    });

    it('passes a batch through as an array', () => {
        const { body } = buildEmbeddingRequest(['a', 'b']);
        expect(body.input).toEqual(['a', 'b']);
    });
});

describe('parseEmbeddingResponse', () => {
    it('truncates to 1024 dims and re-normalizes to unit length', () => {
        const [vec] = parseEmbeddingResponse({ data: [{ index: 0, embedding: fullVector(0.5) }] });
        expect(TARGET_DIMS).toBe(1024);
        expect(vec).toHaveLength(1024);
        const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
        expect(norm).toBeCloseTo(1, 10);
    });

    it('returns vectors in input order even when the provider reorders them', () => {
        const out = parseEmbeddingResponse({
            data: [
                { index: 1, embedding: fullVector(-0.9) },
                { index: 0, embedding: fullVector(0.9) },
            ],
        });
        expect(out[0][0]).toBeGreaterThan(0);
        expect(out[1][0]).toBeLessThan(0);
    });

    it('rejects a response with no data array', () => {
        expect(() => parseEmbeddingResponse({ error: 'nope' })).toThrow(/unexpected response/i);
        expect(() => parseEmbeddingResponse(null)).toThrow(/unexpected response/i);
    });

    it('rejects vectors shorter than the stored dimension instead of storing them', () => {
        const short = new Array(768).fill(0.1);
        expect(() => parseEmbeddingResponse({ data: [{ index: 0, embedding: short }] }))
            .toThrow(/768/);
    });
});

/**
 * 2026-11-13 17:21 UTC: DeepInfra answered 429 "Model busy" and the Hugging
 * Face router then paused it (503), so every search and save lost its
 * embedding. Scaleway serves the same model and is the second leg.
 */
describe('embedWithFallback', () => {
    const ok = (first) => ({ data: [{ index: 0, embedding: fullVector(first) }] });

    it('lists DeepInfra first and Scaleway second, same model family', () => {
        expect(EMBEDDING_PROVIDERS.map((p) => p.name)).toEqual(['deepinfra', 'scaleway']);
        expect(EMBEDDING_PROVIDERS[1].url).toBe('https://router.huggingface.co/scaleway/v1/embeddings');
        expect(EMBEDDING_PROVIDERS[1].model).toBe('qwen3-embedding-8b');
    });

    it('uses only the first provider when it answers', async () => {
        const calls = [];
        const out = await embedWithFallback('hi', async (provider, body) => {
            calls.push([provider.name, body]);
            return ok(0.5);
        });
        expect(calls).toEqual([['deepinfra', { input: 'hi', model: 'Qwen/Qwen3-Embedding-8B' }]]);
        expect(out).toHaveLength(1);
        expect(out[0]).toHaveLength(1024);
    });

    it('falls back to Scaleway with its own model id when DeepInfra is busy', async () => {
        const calls = [];
        const out = await embedWithFallback(['a'], async (provider, body) => {
            calls.push([provider.name, body.model]);
            if (provider.name === 'deepinfra') throw new Error('HF Embedding API Error: 429 - Model busy, retry later');
            return ok(-0.5);
        });
        expect(calls).toEqual([['deepinfra', 'Qwen/Qwen3-Embedding-8B'], ['scaleway', 'qwen3-embedding-8b']]);
        expect(out[0][0]).toBeLessThan(0);
    });

    it('falls back when the first provider returns an unusable body', async () => {
        const out = await embedWithFallback('hi', async (provider) =>
            provider.name === 'deepinfra' ? { error: 'paused' } : ok(0.5));
        expect(out[0]).toHaveLength(1024);
    });

    it('reports both failures, with a retryable one first so the retry policy retries', async () => {
        const err = await embedWithFallback('hi', async (provider) => {
            if (provider.name === 'deepinfra') throw new Error('HF Embedding API Error: 402 - billing');
            throw new Error('HF Embedding API Error: 503 - paused');
        }).catch((e) => e);
        expect(err.message).toMatch(/402/);
        expect(err.message).toMatch(/503/);
        expect(err.message.indexOf('503')).toBeLessThan(err.message.indexOf('402'));
    });

    it('is not retryable when every provider refuses for good', async () => {
        const { isNonRetryableError } = await import('../../supabase/functions/_shared/retry-policy.ts');
        const err = await embedWithFallback('hi', async () => {
            throw new Error('HF Embedding API Error: 402 - billing');
        }).catch((e) => e);
        expect(isNonRetryableError(err.message)).toBe(true);
    });
});
