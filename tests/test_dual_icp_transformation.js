/**
 * Test Dual ICP Query Transformation
 * Run with: node tests/test_dual_icp_transformation.js
 */

import { transformQuery } from '../src/query-transformer.js';
import assert from 'assert';

// Mock fetch for OpenAI API
global.fetch = async (url, options) => {
    if (url.includes('embeddings')) {
        return {
            ok: true,
            json: async () => ({
                data: [{ embedding: new Array(1536).fill(0.1) }]
            })
        };
    }

    if (url.includes('chat/completions')) {
        const body = JSON.parse(options.body);
        const userPrompt = body.messages[1].content;
        console.log('DEBUG: Mock received prompt:', userPrompt);

        let content = "default optimized query";

        // Simulate LLM logic based on input
        if (userPrompt.includes("fix that issue")) {
            content = "fix postgres RLS policy error";
        } else if (userPrompt.includes("I miss him so much")) {
            content = "breakup relationship advice ex-partner emotional support";
        }

        return {
            ok: true,
            json: async () => ({
                choices: [{
                    message: { content: content }
                }],
                usage: { total_tokens: 50 }
            })
        };
    }

    return { ok: false, statusText: 'Not Found' };
};

async function testDualICP() {
    console.log('🧠 Testing Dual ICP Query Transformation...');
    const apiKey = 'sk-test-key';

    try {
        // 1. Technical Query (Developer ICP)
        console.log('   Testing Technical Query...');
        // "issue" is not in the technical keywords list, so this should trigger transformation
        const techResult = await transformQuery(
            "how do I fix that issue?",
            { recentTopics: ['postgres', 'rls'] },
            apiKey
        );

        console.log('DEBUG: Tech Result:', techResult);
        assert.ok(techResult.success);
        assert.strictEqual(techResult.optimizedQuery, "fix postgres RLS policy error");
        console.log(`   ✅ Technical: "${techResult.originalQuery}" -> "${techResult.optimizedQuery}"`);

        // 2. Emotional Query (Companion ICP)
        console.log('   Testing Emotional Query...');
        // "miss" is not in the emotional keywords list, so this should trigger transformation
        const emoResult = await transformQuery(
            "I miss him so much",
            { recentTopics: ['breakup', 'sad'] },
            apiKey
        );

        console.log('DEBUG: Emo Result:', emoResult);
        assert.ok(emoResult.success);
        assert.strictEqual(emoResult.optimizedQuery, "breakup relationship advice ex-partner emotional support");
        console.log(`   ✅ Emotional: "${emoResult.originalQuery}" -> "${emoResult.optimizedQuery}"`);

        // 3. Already Optimized Check
        console.log('   Testing Already Optimized...');
        const optimizedTech = await transformQuery("fix postgres RLS policy", {}, apiKey);
        assert.strictEqual(optimizedTech.transformed, false, "Should skip transformation for technical query");

        const optimizedEmo = await transformQuery("I feel so lonely and sad", {}, apiKey);
        assert.strictEqual(optimizedEmo.transformed, false, "Should skip transformation for emotional query");
        console.log('   ✅ Optimization check passed');

        console.log('✅ Dual ICP Tests Passed!');
    } catch (error) {
        console.error('❌ Dual ICP Tests Failed:', error);
        process.exit(1);
    }
}

testDualICP();
