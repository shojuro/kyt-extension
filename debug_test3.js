import { applyMMR, MMR_PRESETS } from './src/mmr.js';

// Create normalized test embedding
function createTestEmbedding(values) {
  const magnitude = Math.sqrt(values.reduce((sum, v) => sum + v * v, 0));
  return values.map(v => v / magnitude);
}

// Test 3: Hiking scenario
const candidates = [
  {
    id: 1,
    entity: 'Sarah (friend)',
    content: "Sarah and I went hiking at Mount Rainier last summer, amazing views and wildflowers",
    distance: 0.10,
    embedding: createTestEmbedding([1.0, 0.95, 0.1, 0.05, 0.1])
  },
  {
    id: 2,
    entity: 'Sarah (friend)',
    content: "Sarah wants to go hiking again next month, maybe try a different trail this time",
    distance: 0.14,
    embedding: createTestEmbedding([0.98, 0.93, 0.12, 0.08, 0.11])
  },
  {
    id: 3,
    entity: 'User (hiking club)',
    content: "Joined a hiking club to meet new people who enjoy outdoor activities",
    distance: 0.18,
    embedding: createTestEmbedding([0.85, 0.80, 0.3, 0.2, 0.15])
  },
  {
    id: 4,
    entity: 'Tom (brother)',
    content: "My brother Tom suggested we go hiking together over Thanksgiving break",
    distance: 0.35,
    embedding: createTestEmbedding([0.6, 0.5, 0.7, 0.6, 0.4])
  },
  {
    id: 5,
    entity: 'Emma (coworker)',
    content: "Coworker Emma mentioned her hiking trip to the Grand Canyon last year",
    distance: 0.40,
    embedding: createTestEmbedding([0.5, 0.4, 0.75, 0.70, 0.5])
  }
];

console.log('Testing λ=0.3 with DEBUG mode:\n');
const result = applyMMR(candidates, 3, 0.3, { debugMode: true });

console.log('\n\nFinal Results:');
result.forEach((item, idx) => {
  console.log(`${idx + 1}. [ID:${item.id}] Entity: ${item.entity}`);
});
