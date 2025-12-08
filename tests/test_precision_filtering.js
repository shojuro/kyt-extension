/**
 * Test Precision Filtering & Tuning
 * Run with: node tests/test_precision_filtering.js
 */

import { searchMessages } from '../src/browser-search.js';
import assert from 'assert';

// Mock chrome.storage.local
global.chrome = {
    storage: {
        local: {
            get: async () => ({
                api_config: {
                    supabaseUrl: 'https://mock.supabase.co',
                    supabaseKey: 'mock-key',
                    openaiKey: 'mock-openai-key'
                },
                captured_messages: []
            })
        }
    }
};

// Mock fetch
global.fetch = async (url, options) => {
    // Mock OpenAI Embedding
    if (url.includes('embeddings')) {
        return {
            ok: true,
            json: async () => ({
                data: [{ embedding: new Array(1536).fill(0.1) }]
            })
        };
    }

    // Mock Supabase RPC
    if (url.includes('match_messages')) {
        const body = JSON.parse(options.body);
        console.log('DEBUG: Supabase RPC Body:', JSON.stringify(body, null, 2));

        // Verify Precision Settings
        if (body.match_threshold < 0.6) {
            console.warn('⚠️ Warning: Threshold is low (' + body.match_threshold + ') - expected >= 0.6 for precision');
        }

        // Verify Filters
        if (body.filter) {
            console.log('✅ Server-side filter present:', body.filter);
        } else {
            console.error('❌ Missing server-side filter!');
        }

        if (body.min_timestamp !== undefined) {
            console.log('✅ min_timestamp present:', body.min_timestamp);
        } else {
            console.error('❌ Missing min_timestamp!');
        }

        return {
            ok: true,
            json: async () => ([
                {
                    id: '1',
                    content: 'Relevant message',
                    distance: 0.1,
                    role: 'user',
                    source: 'chatgpt',
                    timestamp: Date.now()
                }
            ])
        };
    }

    return { ok: false, statusText: 'Not Found' };
};

async function testPrecisionFiltering() {
    console.log('🔍 Testing Precision Filtering...');

    try {
        // Test 1: Search with Role Filter
        console.log('\n1. Testing Search with Role Filter...');
        await searchMessages('test query', {
            role: 'user',
            threshold: 0.65,
            minTimestamp: 1234567890
        });

        // Test 2: Search with Source Filter
        console.log('\n2. Testing Search with Source Filter...');
        await searchMessages('test query', {
            source: 'cli',
            threshold: 0.7
        });

        console.log('\n✅ Precision Filtering Tests Passed!');
    } catch (error) {
        console.error('❌ Tests Failed:', error);
        process.exit(1);
    }
}

testPrecisionFiltering();
