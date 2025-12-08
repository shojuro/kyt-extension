/**
 * Test Query Expansion
 * Run with: node tests/test_query_expansion.js
 */

import { QueryExpander } from '../src/query-expansion.js';
import assert from 'assert';

// Mock dependencies for integration test
global.chrome = {
    storage: {
        local: {
            get: async () => ({
                api_config: {
                    supabaseUrl: 'https://mock.supabase.co',
                    supabaseKey: 'mock-key',
                    openaiKey: 'mock-openai-key'
                },
                captured_messages: [
                    { id: '1', content: 'Appointment on 2025-03-15', role: 'user' },
                    { id: '2', content: 'Product costs $1,299.99', role: 'assistant' },
                    { id: '3', content: 'Meeting with Dr. Chen', role: 'user' }
                ]
            })
        }
    }
};

const expander = new QueryExpander();

function testDateExpansion() {
    console.log('📅 Testing Date Expansion...');

    // 1. Month Name -> ISO/US
    const res1 = expander.expand('March 15 appointment');
    assert.ok(res1.variants.includes('2025-03-15 appointment'), 'Should include ISO date');
    assert.ok(res1.variants.includes('03/15 appointment'), 'Should include US short date');

    // 2. ISO -> Month Name
    const res2 = expander.expand('appointment on 2025-03-15');
    assert.ok(res2.variants.includes('appointment on March 15'), 'Should include Month Name');

    // 3. US -> ISO
    const res3 = expander.expand('03/15/2025');
    assert.ok(res3.variants.includes('March 15'), 'Should include Month Name');

    console.log('✅ Date Expansion Passed');
}

function testCurrencyExpansion() {
    console.log('💰 Testing Currency Expansion...');

    // 1. No commas -> Commas
    const res1 = expander.expand('$1299');
    console.log('DEBUG: $1299 variants:', res1.variants);
    assert.ok(res1.variants.includes('$1,299'), 'Should include commas');
    assert.ok(res1.variants.includes('$1,299.00'), 'Should include decimals');

    // 2. Commas -> No commas
    const res2 = expander.expand('$1,299.99');
    console.log('DEBUG: $1,299.99 variants:', res2.variants);
    assert.ok(res2.variants.includes('$1299.99'), 'Should remove commas');
    assert.ok(res2.variants.includes('1299.99'), 'Should remove symbol');

    console.log('✅ Currency Expansion Passed');
}

function testNumberExpansion() {
    console.log('🔢 Testing Number Expansion...');

    // 1. Units
    const res1 = expander.expand('47 GB');
    assert.ok(res1.variants.includes('47GB'), 'Should remove space');

    // 2. Large numbers
    const res2 = expander.expand('10000 users');
    assert.ok(res2.variants.includes('10,000 users'), 'Should add commas');

    console.log('✅ Number Expansion Passed');
}

function testNameExpansion() {
    console.log('👤 Testing Name Expansion...');

    // 1. Title -> Name
    const res1 = expander.expand('Dr. Chen');
    assert.ok(res1.variants.includes('Chen'), 'Should include just name');
    assert.ok(res1.variants.includes('Doctor Chen'), 'Should expand title');

    console.log('✅ Name Expansion Passed');
}

async function runTests() {
    try {
        testDateExpansion();
        testCurrencyExpansion();
        testNumberExpansion();
        testNameExpansion();

        console.log('\n✅ All Query Expansion Tests Passed!');
    } catch (error) {
        console.error('\n❌ Test Failed:', error);
        process.exit(1);
    }
}

runTests();
