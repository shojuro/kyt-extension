/**
 * KYT HyDE Preprocessor Tests
 *
 * Tests hypothetical question generation for conversation chunks.
 * Run: node src/test-hyde-preprocessor.js
 *
 * Phase 8: HyDE Preprocessing Testing
 */

import { generateHypotheticalQuestions, batchProcessHyDE } from './hyde-preprocessor.js';
import * as dotenv from 'dotenv';

// Load environment variables
dotenv.config();

const API_KEY = process.env.OPENAI_API_KEY;

if (!API_KEY) {
  console.error('❌ Missing OPENAI_API_KEY in .env file');
  process.exit(1);
}

/**
 * Test turn chunks (realistic examples)
 */
const TEST_CHUNKS = [
  {
    id: 'test-1',
    content: 'User: How do I fix the RLS policy error in Supabase?\n\nAssistant: You need to create a policy that uses auth.uid() to filter rows. First, enable RLS on your table with ALTER TABLE table_name ENABLE ROW LEVEL SECURITY. Then create a policy like: CREATE POLICY user_isolation ON table_name USING (user_id = auth.uid());',
    topics: ['rls', 'supabase', 'auth', 'policy'],
    speakers: ['user', 'assistant']
  },
  {
    id: 'test-2',
    content: 'User: My embeddings are failing with a token limit error\n\nAssistant: This happens when you send too many messages at once. Try batching your messages into smaller groups. For OpenAI text-embedding-3-small, keep each batch under 8000 tokens.',
    topics: ['embedding', 'openai', 'token', 'error'],
    speakers: ['user', 'assistant']
  },
  {
    id: 'test-3',
    content: 'User: What is the best distance metric for vector search?\n\nAssistant: For OpenAI embeddings which are normalized, use cosine distance. It measures angular similarity rather than magnitude. In PostgreSQL with pgvector, use the <=> operator for cosine distance.',
    topics: ['vector', 'search', 'cosine', 'distance', 'pgvector'],
    speakers: ['user', 'assistant']
  }
];

/**
 * Run all tests
 */
async function runTests() {
  console.log('🧪 KYT HyDE Preprocessor Tests\n');
  console.log('='.repeat(60));

  let passed = 0;
  let failed = 0;

  // Test 1: Single chunk question generation
  console.log('\n📋 Test 1: Generate Questions for Single Chunk');
  console.log('-'.repeat(60));

  const chunk1 = TEST_CHUNKS[0];
  console.log('Input chunk ID:', chunk1.id);
  console.log('Topics:', chunk1.topics);
  console.log('Content preview:', chunk1.content.substring(0, 100) + '...');

  try {
    const result = await generateHypotheticalQuestions(chunk1, API_KEY, 3);

    console.log('\nGenerated questions:');
    result.questions.forEach((q, idx) => {
      console.log(`  ${idx + 1}. ${q}`);
    });
    console.log(`Tokens used: ${result.tokensUsed}`);

    if (result.success && result.questions.length >= 2) {
      console.log('✅ PASS: Generated multiple diverse questions');
      passed++;
    } else {
      console.log('❌ FAIL: Insufficient questions generated');
      failed++;
    }

  } catch (error) {
    console.log('❌ FAIL:', error.message);
    failed++;
  }

  // Test 2: Batch processing (small batch)
  console.log('\n📋 Test 2: Batch Process Multiple Chunks');
  console.log('-'.repeat(60));

  console.log(`Processing ${TEST_CHUNKS.length} chunks in batch...`);

  try {
    const batchResult = await batchProcessHyDE(TEST_CHUNKS, API_KEY, {
      questionCount: 3,
      batchSize: 2,
      delayMs: 500
    });

    console.log('\nBatch processing results:');
    console.log(`  Processed: ${batchResult.processed} chunks`);
    console.log(`  Total questions: ${batchResult.totalQuestions}`);
    console.log(`  Failed: ${batchResult.failed} chunks`);

    // Show sample questions from each chunk
    console.log('\nSample questions by chunk:');
    batchResult.chunks.forEach((chunk, idx) => {
      console.log(`  Chunk ${idx + 1} (${chunk.topics.slice(0, 3).join(', ')}):`);
      chunk.hypothetical_questions.forEach((q, qIdx) => {
        console.log(`    ${qIdx + 1}. ${q}`);
      });
    });

    if (batchResult.success && batchResult.totalQuestions >= TEST_CHUNKS.length * 2) {
      console.log('\n✅ PASS: Batch processing generated sufficient questions');
      passed++;
    } else {
      console.log('\n❌ FAIL: Batch processing incomplete');
      failed++;
    }

  } catch (error) {
    console.log('❌ FAIL:', error.message);
    failed++;
  }

  // Test 3: Question quality validation
  console.log('\n📋 Test 3: Question Quality Validation');
  console.log('-'.repeat(60));

  const chunk3 = TEST_CHUNKS[2];
  console.log('Testing question quality for chunk:', chunk3.id);

  try {
    const result = await generateHypotheticalQuestions(chunk3, API_KEY, 5);

    console.log('\nValidating question quality:');

    let qualityPassed = true;

    // Check 1: Questions should contain relevant keywords
    const keywords = chunk3.topics;
    let keywordMatches = 0;

    for (const question of result.questions) {
      const hasKeyword = keywords.some(kw =>
        question.toLowerCase().includes(kw.toLowerCase())
      );
      if (hasKeyword) keywordMatches++;
    }

    console.log(`  Keyword relevance: ${keywordMatches}/${result.questions.length} questions contain topic keywords`);

    if (keywordMatches < result.questions.length * 0.5) {
      qualityPassed = false;
      console.log('  ⚠️ Low keyword relevance');
    }

    // Check 2: Questions should be diverse (not all starting with same word)
    const firstWords = result.questions.map(q => q.split(' ')[0].toLowerCase());
    const uniqueFirstWords = new Set(firstWords);

    console.log(`  Question diversity: ${uniqueFirstWords.size}/${result.questions.length} unique starting words`);

    if (uniqueFirstWords.size < result.questions.length * 0.6) {
      qualityPassed = false;
      console.log('  ⚠️ Low question diversity');
    }

    // Check 3: Questions should be reasonable length (5-30 words)
    const validLengths = result.questions.filter(q => {
      const wordCount = q.split(/\s+/).length;
      return wordCount >= 3 && wordCount <= 30;
    });

    console.log(`  Length validation: ${validLengths.length}/${result.questions.length} questions have valid length`);

    if (validLengths.length < result.questions.length) {
      qualityPassed = false;
      console.log('  ⚠️ Some questions too long or too short');
    }

    if (qualityPassed) {
      console.log('\n✅ PASS: Questions meet quality standards');
      passed++;
    } else {
      console.log('\n❌ FAIL: Question quality issues detected');
      failed++;
    }

  } catch (error) {
    console.log('❌ FAIL:', error.message);
    failed++;
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
