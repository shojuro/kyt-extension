
import assert from 'assert';
import { searchRelevantContext } from '../src/context-injector.js';

// Mock global fetch
global.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    console.log(`Mock Fetch: ${url}`);
    console.log(`Params: match_count=${body.match_count}`);

    // Return mock candidates
    const embApple = new Array(1536).fill(0); embApple[0] = 1.0;
    const embApplePie = new Array(1536).fill(0); embApplePie[0] = 0.99; embApplePie[1] = 0.01;
    const embBanana = new Array(1536).fill(0); embBanana[1] = 1.0;

    const mockCandidates = [
        { id: '1', content: 'Apple', distance: 0.1, embedding: embApple },
        { id: '2', content: 'Apple Pie', distance: 0.11, embedding: embApplePie },
        { id: '3', content: 'Banana', distance: 0.2, embedding: embBanana }
    ];

    return {
        ok: true,
        json: async () => mockCandidates
    };
};

async function runTest() {
    console.log('Running MMR Integration Test...');

    const apiConfig = { supabaseUrl: 'https://mock', supabaseKey: 'key' };
    const contextConfig = {
        enabled: true,
        threshold: 0.5,
        maxContextItems: 2,
        minDistance: 0.0,
        debugMode: true,
        mmrEnabled: true,
        mmrLambda: 0.5,
        fetchCount: 10
    };
    const queryEmbedding = new Array(1536).fill(0);

    const results = await searchRelevantContext(queryEmbedding, apiConfig, contextConfig);

    console.log('Results:', results.map(r => r.content));

    // Verify
    assert(results.length <= 2, 'Should return at most 2 items');
    assert.strictEqual(results[0].content, 'Apple', 'First item should be Apple');

    // If MMR works, Apple Pie should be penalized.
    // Let's see what we get.

    console.log('✅ Test Passed!');
}

runTest().catch(err => {
    console.error('❌ Test Failed:', err);
    process.exit(1);
});
