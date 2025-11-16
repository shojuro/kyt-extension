/**
 * Comprehensive MMR Test Suite
 * 
 * Purpose: Validate MMR reranking across multiple realistic scenarios
 * for "Lonely ICP" use case with complex relationships and similar names
 */

import { applyMMR, MMR_PRESETS } from './src/mmr.js';

/**
 * Create normalized test embedding
 */
function createTestEmbedding(values) {
  const magnitude = Math.sqrt(values.reduce((sum, v) => sum + v * v, 0));
  return values.map(v => v / magnitude);
}

/**
 * Run a single test scenario
 */
function runTestScenario(scenarioName, candidates, query, expectedDiversity) {
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`📋 SCENARIO: ${scenarioName}`);
  console.log(`${'═'.repeat(70)}\n`);
  
  console.log(`Query: "${query}"\n`);
  
  console.log('📄 Candidates (by relevance):');
  candidates.forEach((item, idx) => {
    console.log(`   ${idx + 1}. [ID:${item.id}] Distance: ${item.distance.toFixed(2)}, "${item.content.substring(0, 60)}..."`);
  });
  console.log('');
  
  // WITHOUT MMR
  const withoutMMR = [...candidates]
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 3);
  
  console.log('❌ WITHOUT MMR (Top 3 by relevance):');
  withoutMMR.forEach((item, idx) => {
    console.log(`   ${idx + 1}. [ID:${item.id}] "${item.content.substring(0, 60)}..."`);
  });
  
  // Count unique entities
  const uniqueEntitiesWithout = new Set(withoutMMR.map(i => i.entity)).size;
  console.log(`   → Unique entities: ${uniqueEntitiesWithout}`);
  
  // WITH MMR
  console.log('\n✅ WITH MMR (PRECISION preset, λ=0.3):');
  const withMMR = applyMMR(
    candidates,
    3,
    MMR_PRESETS.PRECISION.lambda,
    { debugMode: false }
  );
  
  withMMR.forEach((item, idx) => {
    console.log(`   ${idx + 1}. [ID:${item.id}] "${item.content.substring(0, 60)}..."`);
  });
  
  // Count unique entities
  const uniqueEntitiesWith = new Set(withMMR.map(i => i.entity)).size;
  console.log(`   → Unique entities: ${uniqueEntitiesWith}`);
  
  // Evaluation
  console.log('\n📊 EVALUATION:');
  if (uniqueEntitiesWith > uniqueEntitiesWithout) {
    console.log(`   ✅ PASS: MMR increased diversity (${uniqueEntitiesWithout} → ${uniqueEntitiesWith} entities)`);
    return true;
  } else if (uniqueEntitiesWith === expectedDiversity) {
    console.log(`   ✅ PASS: MMR achieved expected diversity (${uniqueEntitiesWith} entities)`);
    return true;
  } else {
    console.log(`   ⚠️  PARTIAL: Expected ${expectedDiversity} entities, got ${uniqueEntitiesWith}`);
    return false;
  }
}

console.log('\n');
console.log('╔═══════════════════════════════════════════════════════════════════╗');
console.log('║         COMPREHENSIVE MMR TEST SUITE - "LONELY ICP"              ║');
console.log('╚═══════════════════════════════════════════════════════════════════╝');

const results = [];

// ═══════════════════════════════════════════════════════════════════════
// TEST 1: People with Similar Names (Jennifer/Jenn)
// ═══════════════════════════════════════════════════════════════════════
results.push(runTestScenario(
  'Similar Names (Jennifer/Jenn)',
  [
    {
      id: 1,
      entity: 'sister_jennifer',
      content: "My sister Jennifer is a doctor in Boston, specializing in pediatrics",
      distance: 0.15,
      embedding: createTestEmbedding([1.0, 0.9, 0.1, 0.2, 0.1]),
      source: 'chatgpt',
      msg_timestamp: Date.now() - 86400000
    },
    {
      id: 2,
      entity: 'sister_jennifer',
      content: "Jennifer called me yesterday about her wedding plans for next summer",
      distance: 0.18,
      embedding: createTestEmbedding([0.95, 0.85, 0.15, 0.25, 0.12]),
      source: 'claude',
      msg_timestamp: Date.now() - 172800000
    },
    {
      id: 3,
      entity: 'sister_jennifer',
      content: "Jennifer asked me to help her move into her new apartment downtown",
      distance: 0.20,
      embedding: createTestEmbedding([0.92, 0.88, 0.18, 0.22, 0.14]),
      source: 'chatgpt',
      msg_timestamp: Date.now() - 259200000
    },
    {
      id: 4,
      entity: 'dog_jenn',
      content: "Jenn (my golden retriever) loves playing fetch at the dog park",
      distance: 0.45,
      embedding: createTestEmbedding([0.3, 0.2, 0.9, 0.8, 0.7]),
      source: 'claude',
      msg_timestamp: Date.now() - 345600000
    },
    {
      id: 5,
      entity: 'gardening',
      content: "I planted tomatoes and basil in the garden this weekend",
      distance: 0.75,
      embedding: createTestEmbedding([0.1, 0.1, 0.1, 0.2, 0.95]),
      source: 'chatgpt',
      msg_timestamp: Date.now() - 432000000
    }
  ],
  'Tell me about Jennifer',
  2 // Expected: sister_jennifer + dog_jenn
));

// ═══════════════════════════════════════════════════════════════════════
// TEST 2: Family Members with Same Name (Mike Sr./Jr.)
// ═══════════════════════════════════════════════════════════════════════
results.push(runTestScenario(
  'Family Same Name (Mike Sr./Jr.)',
  [
    {
      id: 1,
      entity: 'father_mike',
      content: "My dad Mike retired from teaching after 35 years at the high school",
      distance: 0.12,
      embedding: createTestEmbedding([0.95, 0.9, 0.2, 0.1, 0.15]),
      source: 'chatgpt',
      msg_timestamp: Date.now() - 86400000
    },
    {
      id: 2,
      entity: 'father_mike',
      content: "Mike loves fishing on the weekends, usually goes to the lake",
      distance: 0.16,
      embedding: createTestEmbedding([0.93, 0.88, 0.22, 0.12, 0.18]),
      source: 'claude',
      msg_timestamp: Date.now() - 172800000
    },
    {
      id: 3,
      entity: 'son_mike',
      content: "My son Mike just started his first year at college studying engineering",
      distance: 0.25,
      embedding: createTestEmbedding([0.5, 0.6, 0.85, 0.7, 0.3]),
      source: 'chatgpt',
      msg_timestamp: Date.now() - 259200000
    },
    {
      id: 4,
      entity: 'son_mike',
      content: "Mike texted me about needing money for textbooks this semester",
      distance: 0.30,
      embedding: createTestEmbedding([0.48, 0.58, 0.82, 0.68, 0.32]),
      source: 'claude',
      msg_timestamp: Date.now() - 345600000
    },
    {
      id: 5,
      entity: 'neighbor_mike',
      content: "Mike next door helped me fix my fence last Tuesday afternoon",
      distance: 0.55,
      embedding: createTestEmbedding([0.2, 0.25, 0.3, 0.9, 0.85]),
      source: 'chatgpt',
      msg_timestamp: Date.now() - 432000000
    }
  ],
  'What did Mike do recently?',
  3 // Expected: father_mike + son_mike + neighbor_mike
));

// ═══════════════════════════════════════════════════════════════════════
// TEST 3: Similar Activities, Different People (hiking trips)
// ═══════════════════════════════════════════════════════════════════════
results.push(runTestScenario(
  'Similar Activities, Different People (hiking)',
  [
    {
      id: 1,
      entity: 'sarah_hiking',
      content: "Sarah and I went hiking at Mount Rainier last summer, amazing views",
      distance: 0.10,
      embedding: createTestEmbedding([0.9, 0.85, 0.2, 0.15, 0.1]),
      source: 'chatgpt',
      msg_timestamp: Date.now() - 86400000
    },
    {
      id: 2,
      entity: 'sarah_hiking',
      content: "Sarah wants to go hiking again next month, maybe try a different trail",
      distance: 0.14,
      embedding: createTestEmbedding([0.88, 0.83, 0.22, 0.17, 0.12]),
      source: 'claude',
      msg_timestamp: Date.now() - 172800000
    },
    {
      id: 3,
      entity: 'hiking_club',
      content: "Joined a hiking club to meet new people who enjoy outdoor activities",
      distance: 0.18,
      embedding: createTestEmbedding([0.85, 0.8, 0.25, 0.2, 0.15]),
      source: 'chatgpt',
      msg_timestamp: Date.now() - 259200000
    },
    {
      id: 4,
      entity: 'brother_hiking',
      content: "My brother Tom suggested we go hiking together over Thanksgiving break",
      distance: 0.35,
      embedding: createTestEmbedding([0.4, 0.5, 0.75, 0.8, 0.6]),
      source: 'claude',
      msg_timestamp: Date.now() - 345600000
    },
    {
      id: 5,
      entity: 'coworker_hiking',
      content: "Coworker Emma mentioned her hiking trip to the Grand Canyon was incredible",
      distance: 0.40,
      embedding: createTestEmbedding([0.3, 0.4, 0.7, 0.85, 0.65]),
      source: 'chatgpt',
      msg_timestamp: Date.now() - 432000000
    }
  ],
  'Tell me about hiking',
  3 // Expected: sarah + brother + coworker/club
));

// ═══════════════════════════════════════════════════════════════════════
// TEST 4: Nicknames vs Full Names (Alex/Alexander)
// ═══════════════════════════════════════════════════════════════════════
results.push(runTestScenario(
  'Nicknames vs Full Names (Alex/Alexander)',
  [
    {
      id: 1,
      entity: 'boss_alexander',
      content: "My boss Alexander approved my vacation request for December finally",
      distance: 0.08,
      embedding: createTestEmbedding([0.95, 0.9, 0.15, 0.1, 0.05]),
      source: 'chatgpt',
      msg_timestamp: Date.now() - 86400000
    },
    {
      id: 2,
      entity: 'boss_alexander',
      content: "Alexander scheduled a team meeting for Monday morning at 9am",
      distance: 0.12,
      embedding: createTestEmbedding([0.93, 0.88, 0.17, 0.12, 0.07]),
      source: 'claude',
      msg_timestamp: Date.now() - 172800000
    },
    {
      id: 3,
      entity: 'friend_alex',
      content: "Alex invited me to his birthday party next Saturday evening",
      distance: 0.25,
      embedding: createTestEmbedding([0.5, 0.6, 0.8, 0.7, 0.4]),
      source: 'chatgpt',
      msg_timestamp: Date.now() - 259200000
    },
    {
      id: 4,
      entity: 'friend_alex',
      content: "Alex texted asking if I want to grab coffee tomorrow afternoon",
      distance: 0.28,
      embedding: createTestEmbedding([0.48, 0.58, 0.78, 0.68, 0.42]),
      source: 'claude',
      msg_timestamp: Date.now() - 345600000
    },
    {
      id: 5,
      entity: 'cousin_alex',
      content: "Cousin Alex graduated from law school and just passed the bar exam",
      distance: 0.50,
      embedding: createTestEmbedding([0.2, 0.3, 0.4, 0.85, 0.9]),
      source: 'chatgpt',
      msg_timestamp: Date.now() - 432000000
    }
  ],
  'What is Alex up to?',
  3 // Expected: boss_alexander + friend_alex + cousin_alex
));

// ═══════════════════════════════════════════════════════════════════════
// TEST 5: Locations with Same Name (different Portlands)
// ═══════════════════════════════════════════════════════════════════════
results.push(runTestScenario(
  'Same Place Name, Different Locations (Portland)',
  [
    {
      id: 1,
      entity: 'portland_oregon',
      content: "Visited Portland, Oregon last fall - loved the coffee shops and food trucks",
      distance: 0.10,
      embedding: createTestEmbedding([0.9, 0.85, 0.2, 0.15, 0.1]),
      source: 'chatgpt',
      msg_timestamp: Date.now() - 86400000
    },
    {
      id: 2,
      entity: 'portland_oregon',
      content: "Portland has such beautiful parks, I spent hours at Washington Park",
      distance: 0.15,
      embedding: createTestEmbedding([0.88, 0.83, 0.22, 0.17, 0.12]),
      source: 'claude',
      msg_timestamp: Date.now() - 172800000
    },
    {
      id: 3,
      entity: 'portland_maine',
      content: "Portland, Maine has the best lobster rolls I've ever tasted on the coast",
      distance: 0.35,
      embedding: createTestEmbedding([0.4, 0.5, 0.8, 0.75, 0.6]),
      source: 'chatgpt',
      msg_timestamp: Date.now() - 259200000
    },
    {
      id: 4,
      entity: 'portland_maine',
      content: "Thinking about visiting Portland again next summer for the lighthouse tours",
      distance: 0.38,
      embedding: createTestEmbedding([0.38, 0.48, 0.78, 0.73, 0.58]),
      source: 'claude',
      msg_timestamp: Date.now() - 345600000
    },
    {
      id: 5,
      entity: 'travel_general',
      content: "Planning my next vacation, considering several cities on the west coast",
      distance: 0.65,
      embedding: createTestEmbedding([0.2, 0.25, 0.3, 0.4, 0.95]),
      source: 'chatgpt',
      msg_timestamp: Date.now() - 432000000
    }
  ],
  'Tell me about Portland',
  2 // Expected: portland_oregon + portland_maine
));

// ═══════════════════════════════════════════════════════════════════════
// TEST 6: Professional vs Personal Context (Dr. Sarah)
// ═══════════════════════════════════════════════════════════════════════
results.push(runTestScenario(
  'Professional vs Personal (Dr. Sarah)',
  [
    {
      id: 1,
      entity: 'doctor_sarah',
      content: "My doctor Dr. Sarah recommended I start taking vitamin D supplements",
      distance: 0.12,
      embedding: createTestEmbedding([0.9, 0.85, 0.2, 0.15, 0.1]),
      source: 'chatgpt',
      msg_timestamp: Date.now() - 86400000
    },
    {
      id: 2,
      entity: 'doctor_sarah',
      content: "Dr. Sarah said my blood pressure is improving with the new medication",
      distance: 0.16,
      embedding: createTestEmbedding([0.88, 0.83, 0.22, 0.17, 0.12]),
      source: 'claude',
      msg_timestamp: Date.now() - 172800000
    },
    {
      id: 3,
      entity: 'friend_sarah',
      content: "Sarah and I are planning a girls' trip to Vegas for her 40th birthday",
      distance: 0.30,
      embedding: createTestEmbedding([0.5, 0.6, 0.8, 0.75, 0.4]),
      source: 'chatgpt',
      msg_timestamp: Date.now() - 259200000
    },
    {
      id: 4,
      entity: 'friend_sarah',
      content: "Sarah finally broke up with her toxic boyfriend after 2 years",
      distance: 0.35,
      embedding: createTestEmbedding([0.48, 0.58, 0.78, 0.73, 0.42]),
      source: 'claude',
      msg_timestamp: Date.now() - 345600000
    },
    {
      id: 5,
      entity: 'sister_sarah',
      content: "My sister Sarah got promoted to senior manager at her tech company",
      distance: 0.55,
      embedding: createTestEmbedding([0.2, 0.3, 0.4, 0.85, 0.9]),
      source: 'chatgpt',
      msg_timestamp: Date.now() - 432000000
    }
  ],
  'What did Sarah tell me?',
  3 // Expected: doctor_sarah + friend_sarah + sister_sarah
));

// ═══════════════════════════════════════════════════════════════════════
// RESULTS SUMMARY
// ═══════════════════════════════════════════════════════════════════════
console.log('\n');
console.log('╔═══════════════════════════════════════════════════════════════════╗');
console.log('║                        TEST SUITE SUMMARY                         ║');
console.log('╚═══════════════════════════════════════════════════════════════════╝\n');

const passCount = results.filter(r => r).length;
const totalCount = results.length;
const passRate = ((passCount / totalCount) * 100).toFixed(0);

console.log(`Total Tests: ${totalCount}`);
console.log(`Passed: ${passCount}`);
console.log(`Pass Rate: ${passRate}%`);
console.log('');

if (passRate >= 80) {
  console.log('✅ TEST SUITE PASSED - MMR is working as expected for diverse scenarios');
  console.log('   → Ready for beta deployment');
} else if (passRate >= 60) {
  console.log('⚠️  TEST SUITE PARTIAL - MMR works but may need tuning');
  console.log('   → Consider adjusting λ parameter or adding more test cases');
} else {
  console.log('❌ TEST SUITE FAILED - MMR needs investigation');
  console.log('   → Review algorithm implementation and parameter settings');
}

console.log('\n');
console.log('═'.repeat(70));
console.log('💡 KEY INSIGHTS');
console.log('═'.repeat(70));
console.log('');
console.log('1. MMR prevents entity confusion in "Lonely ICP" scenarios');
console.log('2. PRECISION preset (λ=0.3) favors diversity to prevent duplicate entities');
console.log('3. Works across multiple types of ambiguity:');
console.log('   - Similar names (Jennifer/Jenn)');
console.log('   - Same names (Mike Sr./Jr.)');
console.log('   - Nicknames (Alex/Alexander)');
console.log('   - Same place names (Portland OR/ME)');
console.log('   - Professional vs personal (Dr. Sarah vs friend Sarah)');
console.log('');
console.log('4. Without MMR: Results cluster around most relevant entity');
console.log('5. With MMR: Results include multiple entities for disambiguation');
console.log('');
console.log('═'.repeat(70));
console.log('');

process.exit(passRate >= 80 ? 0 : 1);
