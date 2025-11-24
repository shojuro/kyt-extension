/**
 * Basic test script for cross-encoder reranker module
 *
 * This script verifies:
 * 1. Module imports successfully
 * 2. Sigmoid normalization works correctly
 * 3. Input validation catches errors
 * 4. rerankCandidates() can score sample data
 * 5. Scores are properly normalized (0-1 range)
 * 6. Results are sorted by relevance
 */

import { rerankCandidates, __testing__ } from '../src/cross-encoder-reranker.js';

// Test colors
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const BLUE = '\x1b[34m';
const RESET = '\x1b[0m';

let testsPassed = 0;
let testsFailed = 0;

function assert(condition, testName) {
  if (condition) {
    console.log(`${GREEN}✓${RESET} ${testName}`);
    testsPassed++;
  } else {
    console.log(`${RED}✗${RESET} ${testName}`);
    testsFailed++;
  }
}

async function runTests() {
  console.log(`${BLUE}========================================${RESET}`);
  console.log(`${BLUE}Cross-Encoder Reranker Basic Tests${RESET}`);
  console.log(`${BLUE}========================================${RESET}\n`);

  // ====================================================================
  // TEST 1: Sigmoid Normalization
  // ====================================================================
  console.log('Test 1: Sigmoid normalization function');
  const { normalizeScore } = __testing__;

  const score0 = normalizeScore(0);
  const score2 = normalizeScore(2);
  const scoreNeg2 = normalizeScore(-2);

  assert(Math.abs(score0 - 0.5) < 0.01, 'normalizeScore(0) ≈ 0.5');
  assert(Math.abs(score2 - 0.88) < 0.01, 'normalizeScore(2) ≈ 0.88');
  assert(Math.abs(scoreNeg2 - 0.12) < 0.01, 'normalizeScore(-2) ≈ 0.12');
  console.log();

  // ====================================================================
  // TEST 2: Input Validation
  // ====================================================================
  console.log('Test 2: Input validation');
  const { validateRerankInputs } = __testing__;

  try {
    validateRerankInputs('', []);
    assert(false, 'Empty query should throw error');
  } catch (error) {
    assert(error.message.includes('query'), 'Empty query throws correct error');
  }

  try {
    validateRerankInputs('test query', []);
    assert(false, 'Empty candidates should throw error');
  } catch (error) {
    assert(error.message.includes('empty'), 'Empty candidates throws correct error');
  }

  try {
    validateRerankInputs('test query', [{ message_id: 'abc' }]);
    assert(false, 'Missing content should throw error');
  } catch (error) {
    assert(error.message.includes('content'), 'Missing content throws correct error');
  }

  console.log();

  // ====================================================================
  // TEST 3: Sample Data Reranking
  // ====================================================================
  console.log('Test 3: Reranking sample data');
  console.log('(This will download the model on first run - may take 30-60 seconds)\n');

  const query = "Tell me about Jennifer's startup idea";
  const candidates = [
    {
      message_id: 'msg_1',
      content: 'Jennifer founded an AI tutoring startup called EduAI that helps students learn math through personalized lessons.',
      weighted_score: 0.72
    },
    {
      message_id: 'msg_2',
      content: 'The weather in Tokyo is sunny today with temperatures around 25 degrees.',
      weighted_score: 0.68
    },
    {
      message_id: 'msg_3',
      content: 'Jennifer mentioned her startup pitch deck at the investor meeting. The startup focuses on adaptive learning algorithms.',
      weighted_score: 0.65
    }
  ];

  try {
    const startTime = Date.now();
    const results = await rerankCandidates(query, candidates, { debugMode: true });
    const latency = Date.now() - startTime;

    console.log();
    console.log(`Reranking completed in ${latency}ms\n`);

    // Verify results structure
    assert(Array.isArray(results), 'Results is an array');
    assert(results.length === 3, 'Results has 3 items');
    assert(results[0].cross_encoder_score !== undefined, 'First result has cross_encoder_score');
    assert(results[0].cross_encoder_score >= 0 && results[0].cross_encoder_score <= 1, 'Score is normalized (0-1)');

    // Verify sorting (descending by score)
    const sorted = results.every((item, i) => {
      if (i === 0) return true;
      return item.cross_encoder_score <= results[i - 1].cross_encoder_score;
    });
    assert(sorted, 'Results are sorted by cross_encoder_score (descending)');

    // Print results
    console.log('\nReranking Results:');
    console.log('─────────────────────────────────────────');
    results.forEach((item, idx) => {
      const content = item.content.slice(0, 60) + '...';
      console.log(`${idx + 1}. ${item.message_id}`);
      console.log(`   Score: ${item.cross_encoder_score.toFixed(3)} (weighted: ${item.weighted_score.toFixed(3)})`);
      console.log(`   Content: "${content}"`);
      console.log();
    });

    // Verify relevance ranking makes sense
    // msg_1 and msg_3 (relevant) should score higher than msg_2 (irrelevant)
    const msg1 = results.find(r => r.message_id === 'msg_1');
    const msg2 = results.find(r => r.message_id === 'msg_2');
    const msg3 = results.find(r => r.message_id === 'msg_3');

    const relevantScoreAvg = (msg1.cross_encoder_score + msg3.cross_encoder_score) / 2;
    const irrelevantScore = msg2.cross_encoder_score;

    assert(relevantScoreAvg > irrelevantScore, 'Relevant content scores higher than irrelevant content');

    console.log(`Relevance Check:`);
    console.log(`  Relevant avg score: ${relevantScoreAvg.toFixed(3)}`);
    console.log(`  Irrelevant score: ${irrelevantScore.toFixed(3)}`);
    console.log(`  Difference: ${(relevantScoreAvg - irrelevantScore).toFixed(3)}`);
    console.log();

  } catch (error) {
    console.error(`${RED}Test failed with error:${RESET}`, error);
    assert(false, 'Reranking sample data');
  }

  // ====================================================================
  // TEST 4: Error Handling State
  // ====================================================================
  console.log('Test 4: Error handling state');
  const { getState } = __testing__;

  const initialState = getState();
  assert(initialState.consecutiveFailures === 0, 'Initial consecutive failures is 0');
  assert(initialState.alertSent === false, 'Initial alertSent is false');
  assert(initialState.modelLoaded === true, 'Model is loaded after successful reranking');

  console.log();

  // ====================================================================
  // SUMMARY
  // ====================================================================
  console.log(`${BLUE}========================================${RESET}`);
  console.log(`${BLUE}Test Summary${RESET}`);
  console.log(`${BLUE}========================================${RESET}`);
  console.log(`${GREEN}Passed: ${testsPassed}${RESET}`);
  console.log(`${RED}Failed: ${testsFailed}${RESET}`);

  if (testsFailed === 0) {
    console.log(`\n${GREEN}✓ All tests passed!${RESET}`);
    process.exit(0);
  } else {
    console.log(`\n${RED}✗ Some tests failed${RESET}`);
    process.exit(1);
  }
}

// Run tests
runTests().catch(error => {
  console.error(`${RED}Fatal error:${RESET}`, error);
  process.exit(1);
});
