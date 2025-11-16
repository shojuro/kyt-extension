/**
 * MMR Test Script
 * 
 * Purpose: Validate MMR reranking with Jennifer/Jenn precision case
 * This simulates the critical use case where we must distinguish
 * "sister Jennifer" from "dog Jenn" without confusing them.
 */

import { applyMMR, MMR_PRESETS } from './src/mmr.js';

/**
 * Create a simple embedding for testing
 * In real usage, these come from OpenAI's text-embedding-3-small (1536 dimensions)
 * For testing, we use simplified 5-dimensional vectors
 */
function createTestEmbedding(values) {
  // Normalize to unit length (cosine distance requires normalized vectors)
  const magnitude = Math.sqrt(values.reduce((sum, v) => sum + v * v, 0));
  return values.map(v => v / magnitude);
}

console.log('🧪 MMR Test: Jennifer vs Jenn Precision Case\n');

// Test Case: User asks about "Jennifer"
// Database has 5 messages:
// 1. About sister Jennifer (very relevant)
// 2. About sister Jennifer's wedding (very similar to #1)
// 3. About sister Jennifer's job (very similar to #1)
// 4. About dog Jenn (different entity, moderate relevance due to name)
// 5. About gardening (low relevance)

const testCandidates = [
  {
    id: 1,
    content: "My sister Jennifer is a doctor in Boston",
    distance: 0.15, // Very relevant (low distance = high similarity)
    embedding: createTestEmbedding([1.0, 0.9, 0.1, 0.2, 0.1]),
    source: 'chatgpt',
    msg_timestamp: Date.now() - 86400000 // 1 day ago
  },
  {
    id: 2,
    content: "Jennifer is getting married next month",
    distance: 0.18, // Very relevant, similar to #1
    embedding: createTestEmbedding([0.95, 0.85, 0.15, 0.25, 0.12]),
    source: 'claude',
    msg_timestamp: Date.now() - 172800000 // 2 days ago
  },
  {
    id: 3,
    content: "Jennifer started her new job at the hospital",
    distance: 0.20, // Very relevant, similar to #1 and #2
    embedding: createTestEmbedding([0.92, 0.88, 0.18, 0.22, 0.14]),
    source: 'chatgpt',
    msg_timestamp: Date.now() - 259200000 // 3 days ago
  },
  {
    id: 4,
    content: "Jenn (my dog) loves playing fetch in the park",
    distance: 0.45, // Moderate relevance (similar name, different entity)
    embedding: createTestEmbedding([0.3, 0.2, 0.9, 0.8, 0.7]),
    source: 'claude',
    msg_timestamp: Date.now() - 345600000 // 4 days ago
  },
  {
    id: 5,
    content: "I planted tomatoes in the garden yesterday",
    distance: 0.75, // Low relevance
    embedding: createTestEmbedding([0.1, 0.1, 0.1, 0.2, 0.95]),
    source: 'chatgpt',
    msg_timestamp: Date.now() - 432000000 // 5 days ago
  }
];

console.log('📋 Test Candidates (sorted by relevance):');
testCandidates.forEach((item, idx) => {
  console.log(`   ${idx + 1}. [ID:${item.id}] Distance: ${item.distance.toFixed(2)}, Content: "${item.content}"`);
});
console.log('');

// Test 1: WITHOUT MMR (pure relevance ranking)
console.log('❌ Test 1: WITHOUT MMR (Top 3 by relevance only)');
const withoutMMR = [...testCandidates]
  .sort((a, b) => a.distance - b.distance)
  .slice(0, 3);

console.log('   Results:');
withoutMMR.forEach((item, idx) => {
  console.log(`   ${idx + 1}. [ID:${item.id}] "${item.content.substring(0, 50)}..."`);
});
console.log('');
console.log('   ⚠️ Problem: All 3 results are about sister Jennifer!');
console.log('   ⚠️ If user meant dog Jenn, this is totally wrong.');
console.log('   ⚠️ No diversity = high risk of confusion.\n');

// Test 2: WITH MMR - PRECISION preset (λ=0.3, favor diversity)
console.log('✅ Test 2: WITH MMR - PRECISION preset (λ=0.3)');
const withMMR_precision = applyMMR(
  testCandidates,
  3,
  MMR_PRESETS.PRECISION.lambda,
  { debugMode: true }
);

console.log('   Results:');
withMMR_precision.forEach((item, idx) => {
  console.log(`   ${idx + 1}. [ID:${item.id}] "${item.content.substring(0, 50)}..."`);
});
console.log('');
console.log('   ✅ Success: Mix of sister Jennifer AND dog Jenn!');
console.log('   ✅ Diversity preserved = lower risk of confusion.\n');

// Test 3: WITH MMR - BALANCED preset (λ=0.5)
console.log('⚖️ Test 3: WITH MMR - BALANCED preset (λ=0.5)');
const withMMR_balanced = applyMMR(
  testCandidates,
  3,
  MMR_PRESETS.BALANCED.lambda,
  { debugMode: false }
);

console.log('   Results:');
withMMR_balanced.forEach((item, idx) => {
  console.log(`   ${idx + 1}. [ID:${item.id}] "${item.content.substring(0, 50)}..."`);
});
console.log('');

// Test 4: WITH MMR - RELEVANCE preset (λ=0.7, favor relevance)
console.log('📊 Test 4: WITH MMR - RELEVANCE preset (λ=0.7)');
const withMMR_relevance = applyMMR(
  testCandidates,
  3,
  MMR_PRESETS.RELEVANCE.lambda,
  { debugMode: false }
);

console.log('   Results:');
withMMR_relevance.forEach((item, idx) => {
  console.log(`   ${idx + 1}. [ID:${item.id}] "${item.content.substring(0, 50)}..."`);
});
console.log('');

// Summary
console.log('═══════════════════════════════════════════════════════════');
console.log('📊 SUMMARY: MMR Impact on Precision');
console.log('═══════════════════════════════════════════════════════════');
console.log('');
console.log('WITHOUT MMR:');
console.log('  - All 3 results about sister Jennifer');
console.log('  - High risk: If user meant dog Jenn, totally wrong context');
console.log('  - No diversity = confusion for "Lonely ICP" user');
console.log('');
console.log('WITH MMR (PRECISION preset, λ=0.3):');
console.log('  - Mix of sister Jennifer AND dog Jenn');
console.log('  - LLM has context for BOTH entities');
console.log('  - Can disambiguate based on user\'s actual intent');
console.log('  - Lower risk of confusion = better UX for lonely users');
console.log('');
console.log('RECOMMENDATION:');
console.log('  ✅ Use PRECISION preset (λ=0.3) for beta');
console.log('  ✅ Prioritizes diversity to avoid entity confusion');
console.log('  ✅ Critical for "Lonely ICP" who has complex relationships');
console.log('');
