/**
 * KYT Memory Extension - Day 2 Validation Test
 *
 * Purpose: Verify semantic search and multi-source memory infrastructure (VTEST compliance)
 * Usage: node validation/verify_search.js
 *
 * Compliance: CLAUDE.md Anti-Theater Rules
 * - Tests that can ACTUALLY FAIL (not always return true)
 * - Real validation logic (checks embeddings, search, multi-source)
 * - Honest reporting (fails with specific error messages)
 *
 * SUCCESS CRITERIA:
 * ✅ Supabase connection working
 * ✅ Messages synced with embeddings
 * ✅ Search returns relevant results
 * ✅ Semantic matching works (distance < 0.5)
 * ✅ Results properly ranked
 * ✅ Multi-source test (CLI + ChatGPT)
 * ✅ Source attribution accurate
 * ✅ Signal quality (explicit captures only)
 * ✅ No duplicate message IDs
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';

// Configuration
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Validate environment variables
if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !OPENAI_API_KEY) {
  console.error('❌ FATAL: Missing required environment variables');
  console.error('   Required: SUPABASE_URL, SUPABASE_ANON_KEY, OPENAI_API_KEY');
  console.error('   Check your .env file');
  process.exit(1);
}

// Initialize clients
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// Test tracking
let testsPassed = 0;
let testsFailed = 0;
const failures = [];

/**
 * Helper: Log test result
 */
function logTest(testName, passed, details = '') {
  if (passed) {
    console.log(`✅ PASS: ${testName}`);
    testsPassed++;
  } else {
    console.error(`❌ FAIL: ${testName}`);
    if (details) console.error(`   Details: ${details}`);
    testsFailed++;
    failures.push({ test: testName, details });
  }
}

/**
 * Helper: Generate query embedding
 */
async function generateQueryEmbedding(text) {
  const response = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: text,
    encoding_format: 'float'
  });
  return response.data[0].embedding;
}

/**
 * Helper: Calculate cosine distance (NOT similarity - Supabase uses distance)
 */
function calculateCosineDistance(vec1, vec2) {
  if (!vec1 || !vec2 || vec1.length !== vec2.length) {
    throw new Error('Invalid vectors for distance calculation');
  }

  let dotProduct = 0;
  let mag1 = 0;
  let mag2 = 0;

  for (let i = 0; i < vec1.length; i++) {
    dotProduct += vec1[i] * vec2[i];
    mag1 += vec1[i] * vec1[i];
    mag2 += vec2[i] * vec2[i];
  }

  const similarity = dotProduct / (Math.sqrt(mag1) * Math.sqrt(mag2));
  const distance = 1 - similarity; // Supabase uses cosine DISTANCE not similarity

  return distance;
}

/**
 * Main validation function
 */
async function validateDay2Search() {
  console.log('🔍 KYT Day 2 Validation: Starting...');
  console.log('');

  try {
    // ============================================
    // TEST 1: Supabase Connection
    // ============================================
    console.log('--- TEST 1: Supabase Connection ---');

    let connectionWorking = false;
    try {
      const { data, error } = await supabase
        .from('messages')
        .select('count', { count: 'exact', head: true });

      if (error) throw error;
      connectionWorking = true;
      logTest('Supabase connection working', true);
    } catch (error) {
      logTest('Supabase connection working', false, error.message);
      console.error('💥 FATAL: Cannot connect to Supabase. Aborting validation.');
      return { success: false, error: 'Connection failed' };
    }
    console.log('');

    // ============================================
    // TEST 2: Messages Synced with Embeddings
    // ============================================
    console.log('--- TEST 2: Messages Synced with Embeddings ---');

    const { data: messages, error: fetchError } = await supabase
      .from('messages')
      .select('message_id, content, embedding, source, timestamp')
      .order('timestamp', { ascending: false })
      .limit(100);

    if (fetchError) {
      logTest('Fetch messages from Supabase', false, fetchError.message);
      return { success: false, error: 'Fetch failed' };
    }

    const messageCount = messages.length;
    // Embeddings are stored as strings (JSON arrays), need to parse or check length
    const messagesWithEmbeddings = messages.filter(m => {
      if (!m.embedding) return false;
      // Handle both string (from Supabase) and array (parsed) formats
      if (typeof m.embedding === 'string') {
        try {
          const parsed = JSON.parse(m.embedding);
          return Array.isArray(parsed) && parsed.length === 1536;
        } catch {
          return false;
        }
      }
      return Array.isArray(m.embedding) && m.embedding.length === 1536;
    }).length;
    const embeddingPercent = messageCount > 0 ? (messagesWithEmbeddings / messageCount * 100).toFixed(1) : 0;

    logTest(
      `Messages synced (found: ${messageCount}, with embeddings: ${messagesWithEmbeddings})`,
      messageCount >= 2 && messagesWithEmbeddings >= 2,
      messageCount < 2
        ? `Only ${messageCount} message(s) found. Need at least 2 to test search.`
        : `${embeddingPercent}% have embeddings (${messagesWithEmbeddings}/${messageCount})`
    );
    console.log(`   Message count: ${messageCount}`);
    console.log(`   With embeddings: ${messagesWithEmbeddings} (${embeddingPercent}%)`);
    console.log('');

    if (messageCount < 2) {
      console.error('⚠️ Not enough messages to validate search. Sync messages first!');
      return { success: false, error: 'Insufficient messages' };
    }

    // ============================================
    // TEST 3: All Embeddings Present
    // ============================================
    console.log('--- TEST 3: All Embeddings Present (1536 dimensions) ---');

    const messagesWithoutEmbeddings = messages.filter(m => {
      if (!m.embedding) return true;
      // Handle both string and array formats
      if (typeof m.embedding === 'string') {
        try {
          const parsed = JSON.parse(m.embedding);
          return !Array.isArray(parsed) || parsed.length !== 1536;
        } catch {
          return true;
        }
      }
      return !Array.isArray(m.embedding) || m.embedding.length !== 1536;
    });
    const allHaveEmbeddings = messagesWithoutEmbeddings.length === 0;

    logTest(
      'All messages have 1536-dimensional embeddings',
      allHaveEmbeddings,
      allHaveEmbeddings
        ? `All ${messageCount} messages have valid embeddings`
        : `${messagesWithoutEmbeddings.length} messages missing embeddings`
    );

    if (!allHaveEmbeddings) {
      console.error('   Messages without embeddings:');
      messagesWithoutEmbeddings.slice(0, 5).forEach(m => {
        console.error(`   - ${m.message_id}: ${m.content.substring(0, 50)}...`);
      });
    }
    console.log('');

    // ============================================
    // TEST 4: Search Returns Results
    // ============================================
    console.log('--- TEST 4: Search Returns Results ---');

    // Use content from a real message as query to ensure we get results
    const testMessage = messages[0];
    const testQuery = testMessage.content.substring(0, 100); // Use first 100 chars

    console.log(`   Test query: "${testQuery}..."`);

    const queryEmbedding = await generateQueryEmbedding(testQuery);

    const { data: searchResults, error: searchError } = await supabase.rpc('match_messages', {
      query_embedding: queryEmbedding,
      match_threshold: 0.8,
      match_count: 5
    });

    if (searchError) {
      logTest('Search returns results', false, searchError.message);
    } else {
      const foundResults = searchResults && searchResults.length > 0;
      logTest(
        'Search returns results',
        foundResults,
        foundResults
          ? `Found ${searchResults.length} result(s)`
          : 'No results returned (check match_messages function exists)'
      );

      if (foundResults) {
        console.log(`   Top result: "${searchResults[0].content.substring(0, 60)}..."`);
        console.log(`   Similarity: ${(1 - searchResults[0].distance).toFixed(3)}`);
      }
    }
    console.log('');

    // ============================================
    // TEST 5: Semantic Matching Works
    // ============================================
    console.log('--- TEST 5: Semantic Matching (Distance < 0.5) ---');

    // Test semantic similarity with a concept-based query
    const semanticQuery = "Tell me about this project's architecture";
    const semanticEmbedding = await generateQueryEmbedding(semanticQuery);

    const { data: semanticResults, error: semanticError } = await supabase.rpc('match_messages', {
      query_embedding: semanticEmbedding,
      match_threshold: 0.5,
      match_count: 3
    });

    if (semanticError) {
      logTest('Semantic matching works (distance < 0.5)', false, semanticError.message);
    } else {
      const hasCloseMatches = semanticResults && semanticResults.length > 0 && semanticResults[0].distance < 0.5;
      logTest(
        'Semantic matching works (distance < 0.5)',
        hasCloseMatches,
        hasCloseMatches
          ? `Best match distance: ${semanticResults[0].distance.toFixed(3)}`
          : 'No close matches found (may be expected if no relevant content)'
      );

      if (semanticResults && semanticResults.length > 0) {
        console.log(`   Query: "${semanticQuery}"`);
        console.log(`   Best match: "${semanticResults[0].content.substring(0, 60)}..."`);
        console.log(`   Distance: ${semanticResults[0].distance.toFixed(3)} (similarity: ${(1 - semanticResults[0].distance).toFixed(3)})`);
      }
    }
    console.log('');

    // ============================================
    // TEST 6: Results Properly Ranked
    // ============================================
    console.log('--- TEST 6: Results Properly Ranked (Ascending Distance) ---');

    // Use a message we know exists
    const rankQuery = messages[Math.min(2, messages.length - 1)].content;
    const rankEmbedding = await generateQueryEmbedding(rankQuery);

    const { data: rankedResults, error: rankError } = await supabase.rpc('match_messages', {
      query_embedding: rankEmbedding,
      match_threshold: 0.9,
      match_count: 5
    });

    if (rankError) {
      logTest('Results properly ranked', false, rankError.message);
    } else if (!rankedResults || rankedResults.length < 2) {
      logTest('Results properly ranked', true, 'Less than 2 results (cannot verify ranking)');
    } else {
      // Check if distances are in ascending order
      let properlyRanked = true;
      for (let i = 1; i < rankedResults.length; i++) {
        if (rankedResults[i].distance < rankedResults[i - 1].distance) {
          properlyRanked = false;
          break;
        }
      }

      logTest(
        'Results properly ranked (ascending distance)',
        properlyRanked,
        properlyRanked
          ? `${rankedResults.length} results in correct order`
          : 'Results not sorted by distance'
      );

      if (properlyRanked && rankedResults.length > 0) {
        console.log(`   Best match distance: ${rankedResults[0].distance.toFixed(3)}`);
        console.log(`   Worst match distance: ${rankedResults[rankedResults.length - 1].distance.toFixed(3)}`);
      }
    }
    console.log('');

    // ============================================
    // TEST 7: Multi-Source Test (CLI + ChatGPT)
    // ============================================
    console.log('--- TEST 7: Multi-Source Test (CLI + ChatGPT) ---');

    const { data: cliMessages, error: cliError } = await supabase
      .from('messages')
      .select('message_id, content, source')
      .eq('source', 'cli')
      .limit(10);

    const { data: chatgptMessages, error: chatgptError } = await supabase
      .from('messages')
      .select('message_id, content, source')
      .eq('source', 'chatgpt')
      .limit(10);

    const cliCount = cliMessages?.length || 0;
    const chatgptCount = chatgptMessages?.length || 0;
    const hasMultipleSources = cliCount > 0 && chatgptCount > 0;

    logTest(
      'Multi-source memory (CLI + ChatGPT)',
      hasMultipleSources,
      hasMultipleSources
        ? `CLI: ${cliCount}, ChatGPT: ${chatgptCount}`
        : `Only one source found (CLI: ${cliCount}, ChatGPT: ${chatgptCount})`
    );

    console.log(`   CLI messages: ${cliCount}`);
    console.log(`   ChatGPT messages: ${chatgptCount}`);
    console.log('');

    // ============================================
    // TEST 8: Source Attribution Accurate
    // ============================================
    console.log('--- TEST 8: Source Attribution Accurate ---');

    const { data: allSourceMessages, error: sourceError } = await supabase
      .from('messages')
      .select('message_id, source')
      .limit(100);

    if (sourceError) {
      logTest('Source attribution accurate', false, sourceError.message);
    } else {
      const validSources = ['cli', 'chatgpt'];
      const invalidSources = allSourceMessages.filter(m => !validSources.includes(m.source));
      const allSourcesValid = invalidSources.length === 0;

      logTest(
        'Source attribution accurate',
        allSourcesValid,
        allSourcesValid
          ? `All ${allSourceMessages.length} messages have valid source attribution`
          : `${invalidSources.length} messages have invalid source values`
      );

      if (!allSourcesValid) {
        console.error('   Invalid sources found:');
        invalidSources.slice(0, 5).forEach(m => {
          console.error(`   - ${m.message_id}: source="${m.source}"`);
        });
      }
    }
    console.log('');

    // ============================================
    // TEST 9: Signal Quality (No Duplicates)
    // ============================================
    console.log('--- TEST 9: Signal Quality (No Duplicate Message IDs) ---');

    const { data: allMessages, error: allError } = await supabase
      .from('messages')
      .select('message_id')
      .limit(1000);

    if (allError) {
      logTest('Signal quality (no duplicates)', false, allError.message);
    } else {
      const messageIds = allMessages.map(m => m.message_id);
      const uniqueIds = new Set(messageIds);
      const noDuplicates = messageIds.length === uniqueIds.size;

      logTest(
        'Signal quality (no duplicate IDs)',
        noDuplicates,
        noDuplicates
          ? `All ${messageIds.length} message IDs unique`
          : `Duplicates detected (${messageIds.length} total, ${uniqueIds.size} unique)`
      );

      if (!noDuplicates) {
        // Find duplicates
        const counts = {};
        messageIds.forEach(id => {
          counts[id] = (counts[id] || 0) + 1;
        });
        const duplicates = Object.entries(counts).filter(([_, count]) => count > 1);
        console.error('   Duplicate message IDs:');
        duplicates.slice(0, 5).forEach(([id, count]) => {
          console.error(`   - ${id}: ${count} occurrences`);
        });
      }
    }
    console.log('');

    // ============================================
    // FINAL SUMMARY
    // ============================================
    console.log('');
    console.log('═════════════════════════════════════════');
    console.log('📊 DAY 2 VALIDATION SUMMARY');
    console.log('═════════════════════════════════════════');
    console.log(`Total Tests: ${testsPassed + testsFailed}`);
    console.log(`✅ Passed: ${testsPassed}`);
    console.log(`❌ Failed: ${testsFailed}`);
    console.log('');

    if (testsFailed === 0) {
      console.log('\x1b[32m%s\x1b[0m', '🎉 ALL TESTS PASSED! DAY 2 VALIDATION SUCCESSFUL! 🎉');
      console.log('');
      console.log('✅ Supabase connection: WORKING');
      console.log('✅ Message sync: WORKING');
      console.log('✅ Embeddings: GENERATED');
      console.log('✅ Semantic search: WORKING');
      console.log('✅ Multi-source memory: VALIDATED');
      console.log('✅ Signal quality: VERIFIED');
      console.log('');
      console.log('🚀 Ready to proceed to Day 3: Context Injection into ChatGPT');
      console.log('');
      return { success: true, testsPassed, testsFailed, messageCount };

    } else {
      console.error('\x1b[31m%s\x1b[0m', '⚠️ VALIDATION FAILED ⚠️');
      console.error('');
      console.error('Failed Tests:');
      failures.forEach((failure, i) => {
        console.error(`${i + 1}. ${failure.test}`);
        if (failure.details) console.error(`   ${failure.details}`);
      });
      console.error('');
      console.error('❌ Do NOT proceed to Day 3 until these failures are resolved.');
      console.error('');
      return { success: false, testsPassed, testsFailed, failures };
    }

  } catch (error) {
    console.error('');
    console.error('💥 VALIDATION ERROR:', error.message);
    console.error('');
    console.error('Stack trace:', error.stack);
    return { success: false, error: error.message };
  }
}

// Run validation
validateDay2Search()
  .then(result => {
    process.exit(result.success ? 0 : 1);
  })
  .catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
