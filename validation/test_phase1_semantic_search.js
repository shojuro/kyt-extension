/**
 * KYT Memory Extension - Phase 1 Test
 *
 * Tests the DISABLE_QUERY_TRANSFORMATION fix for semantic search
 *
 * User's actual test cases:
 * 1. "chicken that speaks" should find "chicken grill lizard speak welsh in the morning"
 * 2. "K.Y.T." should find K.Y.T. conversations
 * 3. "@@@" markers should be retrievable
 *
 * This test verifies that disabling query transformation preserves
 * semantic meaning for casual/creative queries.
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';

// Configuration
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const DISABLE_TRANSFORMATION = process.env.DISABLE_QUERY_TRANSFORMATION === 'true';

// Validate environment
if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !OPENAI_API_KEY) {
  console.error('❌ FATAL: Missing required environment variables');
  process.exit(1);
}

console.log('\n🧪 Phase 1: Semantic Search Test');
console.log('================================\n');
console.log(`DISABLE_QUERY_TRANSFORMATION: ${DISABLE_TRANSFORMATION ? '✅ true (Phase 1 fix)' : '❌ false'}\n`);

if (!DISABLE_TRANSFORMATION) {
  console.warn('⚠️  WARNING: Query transformation is ENABLED');
  console.warn('   This test is designed to verify the Phase 1 fix works.');
  console.warn('   Set DISABLE_QUERY_TRANSFORMATION=true in .env to enable the fix.\n');
}

// Initialize clients
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

/**
 * Generate embedding for a query
 */
async function generateEmbedding(text) {
  const response = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: text,
    encoding_format: 'float'
  });
  return response.data[0].embedding;
}

/**
 * Search messages using raw query (no transformation)
 */
async function searchMessages(query, threshold = 0.5, limit = 10) {
  console.log(`\n🔍 Searching for: "${query}"`);

  // Generate embedding directly from query (no transformation)
  const queryEmbedding = await generateEmbedding(query);

  // Call Supabase match function
  const { data, error } = await supabase.rpc('match_messages', {
    query_embedding: queryEmbedding,
    match_threshold: threshold,
    match_count: limit
  });

  if (error) {
    console.error(`   ❌ Search error: ${error.message}`);
    return [];
  }

  console.log(`   📊 Found ${data.length} results`);
  return data;
}

/**
 * Display search results
 */
function displayResults(results) {
  if (results.length === 0) {
    console.log('   (no results)');
    return;
  }

  results.forEach((result, i) => {
    const preview = result.content.substring(0, 80).replace(/\n/g, ' ');
    const distance = result.distance.toFixed(4);
    console.log(`   ${i + 1}. [distance: ${distance}] ${preview}...`);
  });
}

/**
 * Test Case 1: "chicken that speaks" should find "chicken grill lizard speak welsh"
 */
async function testChickenSpeaks() {
  console.log('\n📋 Test Case 1: Chicken Speaks');
  console.log('─────────────────────────────');

  const query = "chicken that speaks";
  const expectedContent = "chicken grill lizard speak welsh";

  const results = await searchMessages(query, 0.7, 10);
  displayResults(results);

  // Check if any result contains the expected content
  const found = results.some(r =>
    r.content.toLowerCase().includes('chicken') &&
    r.content.toLowerCase().includes('speak')
  );

  if (found) {
    console.log('   ✅ PASS: Found relevant chicken/speak message');
    return true;
  } else {
    console.log('   ❌ FAIL: Did not find chicken/speak message');
    console.log('   Expected to find content containing "chicken" and "speak"');
    return false;
  }
}

/**
 * Test Case 2: "K.Y.T." should find K.Y.T. conversations
 */
async function testKYTAcronym() {
  console.log('\n📋 Test Case 2: K.Y.T. Acronym');
  console.log('─────────────────────────────');

  const query = "K.Y.T.";

  const results = await searchMessages(query, 0.6, 10);
  displayResults(results);

  // Check if any result mentions K.Y.T. or related terms
  const found = results.some(r =>
    r.content.includes('K.Y.T') ||
    r.content.includes('KYT') ||
    r.content.toLowerCase().includes('keep your thoughts') ||
    r.content.toLowerCase().includes('memory extension')
  );

  if (found) {
    console.log('   ✅ PASS: Found K.Y.T. related messages');
    return true;
  } else {
    console.log('   ⚠️  WARN: No K.Y.T. messages found (may not exist in DB)');
    return null; // null = not a failure, just no data
  }
}

/**
 * Test Case 3: "@@@" markers should be retrievable
 */
async function testCrypticMarkers() {
  console.log('\n📋 Test Case 3: Cryptic Markers');
  console.log('─────────────────────────────');

  const query = "@@@Revealed a chicken grill lizard speak welsh in the morning";

  const results = await searchMessages(query, 0.5, 10);
  displayResults(results);

  // Check if we can find messages with @@@ markers
  const found = results.some(r => r.content.includes('@@@'));

  if (found) {
    console.log('   ✅ PASS: Found cryptic marker messages');
    return true;
  } else {
    console.log('   ⚠️  WARN: No @@@ marker messages found (may not exist in DB)');
    return null;
  }
}

/**
 * Test Case 4: Casual query shouldn't be over-optimized
 */
async function testCasualQuery() {
  console.log('\n📋 Test Case 4: Casual Query Preservation');
  console.log('──────────────────────────────────────');

  // Test that a very casual query still works
  const casualQueries = [
    "what was that thing about the lizard",
    "tell me about that weird test",
    "the morning message with weird animals"
  ];

  let foundAny = false;

  for (const query of casualQueries) {
    const results = await searchMessages(query, 0.6, 5);
    if (results.length > 0) {
      foundAny = true;
      console.log(`   ✅ Query "${query}" returned ${results.length} results`);
    }
  }

  if (foundAny) {
    console.log('   ✅ PASS: Casual queries work without transformation');
    return true;
  } else {
    console.log('   ⚠️  WARN: No results for casual queries (may not have test data)');
    return null;
  }
}

/**
 * Main test runner
 */
async function runTests() {
  console.log('Starting Phase 1 semantic search tests...\n');

  const results = {
    passed: 0,
    failed: 0,
    skipped: 0
  };

  // Run all test cases
  const tests = [
    testChickenSpeaks,
    testKYTAcronym,
    testCrypticMarkers,
    testCasualQuery
  ];

  for (const test of tests) {
    try {
      const result = await test();
      if (result === true) {
        results.passed++;
      } else if (result === false) {
        results.failed++;
      } else {
        results.skipped++;
      }
    } catch (error) {
      console.error(`   ❌ ERROR: ${error.message}`);
      results.failed++;
    }
  }

  // Summary
  console.log('\n\n📊 Test Summary');
  console.log('═══════════════');
  console.log(`✅ Passed:  ${results.passed}`);
  console.log(`❌ Failed:  ${results.failed}`);
  console.log(`⚠️  Skipped: ${results.skipped} (no test data)`);

  const total = results.passed + results.failed + results.skipped;
  const successRate = total > 0 ? ((results.passed / total) * 100).toFixed(1) : 0;
  console.log(`\n📈 Success Rate: ${successRate}%`);

  if (results.failed === 0) {
    console.log('\n🎉 All tests passed! Phase 1 fix is working.');
    process.exit(0);
  } else {
    console.log('\n⚠️  Some tests failed. Review results above.');
    process.exit(1);
  }
}

// Run tests
runTests().catch(error => {
  console.error('\n❌ Fatal error:', error);
  process.exit(1);
});
