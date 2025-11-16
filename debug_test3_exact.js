import { applyMMR } from './src/mmr.js';

// Create normalized test embedding (EXACT from comprehensive test)
function createTestEmbedding(values) {
  const magnitude = Math.sqrt(values.reduce((sum, v) => sum + v * v, 0));
  return values.map(v => v / magnitude);
}

// Test 3: EXACT candidates from comprehensive test
const candidates = [
  {
    id: 1,
    entity: 'sarah_hiking',
    content: "Sarah and I went hiking at Mount Rainier last summer, amazing views",
    distance: 0.10,
    embedding: createTestEmbedding([0.9, 0.85, 0.2, 0.15, 0.1])
  },
  {
    id: 2,
    entity: 'sarah_hiking',
    content: "Sarah wants to go hiking again next month, maybe try a different trail",
    distance: 0.14,
    embedding: createTestEmbedding([0.88, 0.83, 0.22, 0.17, 0.12])
  },
  {
    id: 3,
    entity: 'hiking_club',
    content: "Joined a hiking club to meet new people who enjoy outdoor activities",
    distance: 0.18,
    embedding: createTestEmbedding([0.85, 0.8, 0.25, 0.2, 0.15])
  },
  {
    id: 4,
    entity: 'brother_hiking',
    content: "My brother Tom suggested we go hiking together over Thanksgiving break",
    distance: 0.35,
    embedding: createTestEmbedding([0.4, 0.5, 0.75, 0.8, 0.6])
  },
  {
    id: 5,
    entity: 'coworker_hiking',
    content: "Coworker Emma mentioned her hiking trip to the Grand Canyon was incredible",
    distance: 0.40,
    embedding: createTestEmbedding([0.35, 0.45, 0.8, 0.85, 0.65])
  }
];

console.log('Testing λ=0.3 with EXACT comprehensive test embeddings:\n');
const result = applyMMR(candidates, 3, 0.3, { debugMode: true });

console.log('\n\nFinal Results:');
result.forEach((item, idx) => {
  console.log(`${idx + 1}. [ID:${item.id}] Entity: ${item.entity} - "${item.content.substring(0, 50)}..."`);
});

console.log('\n\nEntity Check:');
const uniqueEntities = new Set(result.map(i => i.entity));
console.log(`Unique entities: ${uniqueEntities.size}`);
console.log(`Entities: ${Array.from(uniqueEntities).join(', ')}`);

if (uniqueEntities.size < 3) {
  console.log('\n❌ FAIL: Should have 3 unique entities, got ' + uniqueEntities.size);
} else {
  console.log('\n✅ PASS: 3 unique entities');
}
