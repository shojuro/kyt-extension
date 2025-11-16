/**
 * KYT Query Transformer Tests
 *
 * Tests query transformation with various input types.
 * Run: node src/test-query-transformer.js
 *
 * Phase 7: Query Transformation Testing
 */

import { transformQuery, extractRecentTopics } from './query-transformer.js';
import * as dotenv from 'dotenv';

// Load environment variables
dotenv.config();

const API_KEY = process.env.OPENAI_API_KEY;

if (!API_KEY) {
  console.error('❌ Missing OPENAI_API_KEY in .env file');
  process.exit(1);
}

/**
 * Test cases for query transformation
 */
const TEST_CASES = [
  {
    name: 'Vague query with temporal reference',
    query: 'that python thing from last week',
    context: {
      recentTopics: ['python', 'rls', 'supabase'],
      searchContext: 'chat_history'
    },
    expectedKeywords: ['python'] // Should contain at least this
  },
  {
    name: 'Casual query with filler words',
    query: 'um like how do I fix that database error thing',
    context: {
      recentTopics: ['postgres', 'rls', 'error'],
      searchContext: 'chat_history'
    },
    expectedKeywords: ['database', 'error']
  },
  {
    name: 'Already optimized technical query',
    query: 'python RLS policy Supabase database configuration',
    context: {
      recentTopics: ['python', 'rls', 'supabase'],
      searchContext: 'chat_history'
    },
    expectedKeywords: ['python', 'RLS', 'policy', 'Supabase']
  },
  {
    name: 'Vague pronoun reference',
    query: 'how did we solve that issue',
    context: {
      recentTopics: ['auth', 'bug', 'fix'],
      searchContext: 'chat_history'
    },
    expectedKeywords: ['auth'] // Should leverage context
  },
  {
    name: 'Multi-concept vague query',
    query: 'the api stuff and database setup from yesterday',
    context: {
      recentTopics: ['api', 'database', 'supabase', 'schema'],
      searchContext: 'chat_history'
    },
    expectedKeywords: ['api', 'database']
  }
];

/**
 * Mock recent messages for context extraction test
 */
const MOCK_MESSAGES = [
  {
    content: 'How do I fix the RLS policy in Supabase?',
    role: 'user'
  },
  {
    content: 'You need to create a policy that filters by user_id = auth.uid()',
    role: 'assistant'
  },
  {
    content: 'I\'m getting a Python error when syncing embeddings',
    role: 'user'
  },
  {
    content: 'Check your OpenAI API key configuration',
    role: 'assistant'
  },
  {
    content: 'The vector search with cosine distance is working now',
    role: 'user'
  }
];

/**
 * Run all tests
 */
async function runTests() {
  console.log('🧪 KYT Query Transformer Tests\n');
  console.log('='.repeat(60));

  let passed = 0;
  let failed = 0;

  // Test 1: Context extraction
  console.log('\n📋 Test 1: Extract Recent Topics');
  console.log('-'.repeat(60));
  const topics = extractRecentTopics(MOCK_MESSAGES, 10);
  console.log('Input messages:', MOCK_MESSAGES.length);
  console.log('Extracted topics:', topics);

  if (topics.includes('rls') && topics.includes('python') && topics.includes('supabase')) {
    console.log('✅ PASS: Context extraction found expected topics');
    passed++;
  } else {
    console.log('❌ FAIL: Missing expected topics');
    failed++;
  }

  // Test 2-6: Query transformations
  for (let i = 0; i < TEST_CASES.length; i++) {
    const testCase = TEST_CASES[i];
    const testNum = i + 2;

    console.log(`\n📋 Test ${testNum}: ${testCase.name}`);
    console.log('-'.repeat(60));
    console.log(`Input query: "${testCase.query}"`);
    console.log(`Context topics: [${testCase.context.recentTopics.join(', ')}]`);

    try {
      const result = await transformQuery(
        testCase.query,
        testCase.context,
        API_KEY
      );

      console.log(`Optimized query: "${result.optimizedQuery}"`);
      console.log(`Transformed: ${result.transformed}`);
      console.log(`Success: ${result.success}`);

      if (result.tokensUsed) {
        console.log(`Tokens used: ${result.tokensUsed}`);
      }

      // Validation: Check if optimized query contains expected keywords
      let hasExpectedKeywords = true;
      for (const keyword of testCase.expectedKeywords) {
        if (!result.optimizedQuery.toLowerCase().includes(keyword.toLowerCase())) {
          hasExpectedKeywords = false;
          console.log(`⚠️ Missing expected keyword: "${keyword}"`);
        }
      }

      // Validation: Check if filler words were removed (for vague queries)
      const fillerWords = ['um', 'like', 'that', 'thing'];
      let hasFillerWords = false;
      for (const filler of fillerWords) {
        if (result.optimizedQuery.toLowerCase().includes(filler)) {
          hasFillerWords = true;
          console.log(`⚠️ Still contains filler word: "${filler}"`);
        }
      }

      if (result.success && hasExpectedKeywords && !hasFillerWords) {
        console.log(`✅ PASS: Query successfully transformed`);
        passed++;
      } else {
        console.log(`❌ FAIL: Transformation quality issues`);
        failed++;
      }

    } catch (error) {
      console.log(`❌ FAIL: ${error.message}`);
      failed++;
    }

    // Rate limit protection
    if (i < TEST_CASES.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 1000)); // 1s delay between tests
    }
  }

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('📊 Test Summary');
  console.log('='.repeat(60));
  console.log(`Total tests: ${passed + failed}`);
  console.log(`✅ Passed: ${passed}`);
  console.log(`❌ Failed: ${failed}`);
  console.log(`Success rate: ${((passed / (passed + failed)) * 100).toFixed(1)}%`);

  if (failed === 0) {
    console.log('\n🎉 All tests passed!');
  } else {
    console.log(`\n⚠️ ${failed} test(s) failed`);
  }
}

// Run tests
runTests().catch(error => {
  console.error('❌ Test execution failed:', error);
  process.exit(1);
});
