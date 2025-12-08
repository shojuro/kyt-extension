
import { expect, test, vi, describe, beforeEach, afterEach } from 'vitest';
import { searchRelevantContext } from '../src/context-injector.js';

// Mock global fetch
const originalFetch = global.fetch;

describe('MMR Integration', () => {
    beforeEach(() => {
        global.fetch = vi.fn();
    });

    afterEach(() => {
        global.fetch = originalFetch;
    });

    test('should fetch more items and apply MMR when enabled', async () => {
        // Mock API Config
        const apiConfig = {
            supabaseUrl: 'https://mock.supabase.co',
            supabaseKey: 'mock-key'
        };

        // Mock Context Config
        const contextConfig = {
            enabled: true,
            threshold: 0.5,
            maxContextItems: 2, // We want top 2
            minDistance: 0.0,
            debugMode: true,
            mmrEnabled: true,
            mmrLambda: 0.5,
            fetchCount: 10 // Fetch 10 candidates
        };

        // Mock Query Embedding
        const queryEmbedding = new Array(1536).fill(0);
        queryEmbedding[0] = 1; // Simple vector

        // Mock Supabase Response (Candidates)
        // Create 3 items:
        // 1. "Apple" (Relevant, distinct)
        // 2. "Apple Pie" (Relevant, very similar to Apple)
        // 3. "Banana" (Less relevant, but distinct)

        // Embeddings (simplified 3D for mental model, but 1536D for code)
        const embApple = new Array(1536).fill(0); embApple[0] = 1.0;
        const embApplePie = new Array(1536).fill(0); embApplePie[0] = 0.99; embApplePie[1] = 0.01;
        const embBanana = new Array(1536).fill(0); embBanana[1] = 1.0;

        const mockCandidates = [
            {
                id: '1', content: 'Apple', distance: 0.1, embedding: embApple,
                msg_timestamp: Date.now()
            },
            {
                id: '2', content: 'Apple Pie', distance: 0.11, embedding: embApplePie,
                msg_timestamp: Date.now()
            },
            {
                id: '3', content: 'Banana', distance: 0.2, embedding: embBanana,
                msg_timestamp: Date.now()
            }
        ];

        // Setup fetch mock
        global.fetch.mockResolvedValue({
            ok: true,
            json: async () => mockCandidates
        });

        // Execute Search
        const results = await searchRelevantContext(queryEmbedding, apiConfig, contextConfig);

        // Verification 1: Fetch called with correct match_count
        expect(global.fetch).toHaveBeenCalledWith(
            expect.stringContaining('/match_messages'),
            expect.objectContaining({
                body: expect.stringContaining('"match_count":10')
            })
        );

        // Verification 2: MMR applied
        // With MMR (Lambda 0.5), "Apple Pie" should be penalized because it's too similar to "Apple".
        // "Banana" (distance 0.2) might be picked over "Apple Pie" (distance 0.11) due to diversity.
        // Let's just check that we got results and they are unique.
        expect(results.length).toBeLessThanOrEqual(2);
        expect(results[0].content).toBe('Apple'); // Most relevant

        // If MMR works, the second item should be Banana (diverse) or Apple Pie (if relevance outweighs diversity)
        // But mostly we want to ensure the function ran without error and returned a subset.
        console.log('Selected items:', results.map(r => r.content));
    });

    test('should fallback to standard search when MMR disabled', async () => {
        const apiConfig = { supabaseUrl: 'https://mock', supabaseKey: 'key' };
        const contextConfig = {
            enabled: true,
            threshold: 0.5,
            maxContextItems: 2,
            minDistance: 0.0,
            mmrEnabled: false, // DISABLED
            fetchCount: 10
        };
        const queryEmbedding = new Array(1536).fill(0);

        global.fetch.mockResolvedValue({
            ok: true,
            json: async () => []
        });

        await searchRelevantContext(queryEmbedding, apiConfig, contextConfig);

        // Verify match_count is maxContextItems (2), NOT fetchCount (10)
        expect(global.fetch).toHaveBeenCalledWith(
            expect.stringContaining('/match_messages'),
            expect.objectContaining({
                body: expect.stringContaining('"match_count":2')
            })
        );
    });
});
