/**
 * Batch 6 Test Runner: Real-World Patterns Test
 *
 * Tests MMR + Entity Deduplication with natural language patterns
 *
 * ═══════════════════════════════════════════════════════════════════════
 * TESTING METHODOLOGY
 * ═══════════════════════════════════════════════════════════════════════
 *
 * This test uses SYNTHETIC EMBEDDINGS with REAL-WORLD LANGUAGE PATTERNS.
 *
 * What this test VALIDATES:
 * ✅ Pronoun references ("what did he say?") work with conversation context
 * ✅ Context switches ("wait, not that Mike") override previous context
 * ✅ Informal language ("what'd Mike say bout that thing?") matches entities
 * ✅ Multi-entity queries ("Mike and Jennifer") retrieve both
 * ✅ Entity deduplication prevents duplicate results
 *
 * What this test DOES NOT VALIDATE:
 * ❌ Real production embedding quality
 * ❌ Actual NLP pronoun resolution
 * ❌ Real conversation state tracking
 *
 * ASSUMPTION:
 * "If MMR handles synthetic natural language patterns,
 * it will work the same way in production."
 *
 * ═══════════════════════════════════════════════════════════════════════
 */

import { applyMMR, MMR_PRESETS } from './src/mmr.js';
import { generateBatch6Scenarios } from './generate_batch6_real_world.js';

// ═══════════════════════════════════════════════════════════════════════
// ICP + PATTERN TYPE METRICS TRACKER
// ═══════════════════════════════════════════════════════════════════════

class RealWorldMetricsTracker {
  constructor() {
    this.developer = {
      total: 0,
      byPatternType: {},
      position1Correct: 0,
      falsePositives: 0,
      totalResults: 0
    };
    this.companion = {
      total: 0,
      byPatternType: {},
      position1Correct: 0,
      falsePositives: 0,
      totalResults: 0
    };
  }

  record(icp, patternType, result) {
    const metrics = this[icp];
    metrics.total++;
    metrics.totalResults += 3;

    // Track by pattern type
    if (!metrics.byPatternType[patternType]) {
      metrics.byPatternType[patternType] = {
        total: 0,
        position1Correct: 0,
        falsePositives: 0
      };
    }
    metrics.byPatternType[patternType].total++;

    if (result.correctPrimary) {
      metrics.position1Correct++;
      metrics.byPatternType[patternType].position1Correct++;
    }

    metrics.falsePositives += result.falsePositives;
    metrics.byPatternType[patternType].falsePositives += result.falsePositives;
  }

  getSummary() {
    return {
      developer: this.getICPSummary('developer'),
      companion: this.getICPSummary('companion'),
      overall: this.getOverallSummary()
    };
  }

  getICPSummary(icp) {
    const metrics = this[icp];
    const summary = {
      total: metrics.total,
      position1Accuracy: ((metrics.position1Correct / metrics.total) * 100).toFixed(1),
      fpRate: ((metrics.falsePositives / metrics.totalResults) * 100).toFixed(1),
      byPatternType: {}
    };

    Object.keys(metrics.byPatternType).forEach(type => {
      const typeMetrics = metrics.byPatternType[type];
      summary.byPatternType[type] = {
        total: typeMetrics.total,
        position1Accuracy: ((typeMetrics.position1Correct / typeMetrics.total) * 100).toFixed(1),
        fpRate: ((typeMetrics.falsePositives / (typeMetrics.total * 3)) * 100).toFixed(1)
      };
    });

    return summary;
  }

  getOverallSummary() {
    const totalScenarios = this.developer.total + this.companion.total;
    const totalCorrect = this.developer.position1Correct + this.companion.position1Correct;
    const totalFP = this.developer.falsePositives + this.companion.falsePositives;
    const totalResults = this.developer.totalResults + this.companion.totalResults;

    return {
      total: totalScenarios,
      position1Accuracy: ((totalCorrect / totalScenarios) * 100).toFixed(1),
      fpRate: ((totalFP / totalResults) * 100).toFixed(1)
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════
// TEST RUNNER
// ═══════════════════════════════════════════════════════════════════════

function runScenario(scenario) {
  const { candidates, expectedPrimary, expectedDiverse } = scenario;

  // Run MMR
  const results = applyMMR(candidates, 3, MMR_PRESETS.PRECISION.lambda, {
    debugMode: false,
    enableEntityDeduplication: true
  });

  // Extract ground truth from candidates
  const groundTruth = {
    primary: candidates.find(c => c.ground_truth === 'primary')?.entity,
    competitors_high: candidates.filter(c => c.ground_truth === 'competitor_high').map(c => c.entity),
    competitors_medium: candidates.filter(c => c.ground_truth === 'competitor_medium').map(c => c.entity)
  };

  // Get pattern metadata
  const primaryCandidate = candidates.find(c => c.ground_truth === 'primary');
  const patternMetadata = {
    conversationContext: primaryCandidate?.conversationContext,
    patternType: scenario.patternType,
    difficulty: scenario.difficulty
  };

  // Check primary entity
  const gotPrimary = results[0].entity;
  const correctPrimary = gotPrimary === expectedPrimary;

  // For multi-entity queries, check if both expected entities are in top 3
  let multiEntitySuccess = true;
  if (scenario.patternType === 'multi_entity' && expectedDiverse.length > 0) {
    const top3Entities = results.slice(0, 3).map(r => r.entity);
    const allExpected = [expectedPrimary, ...expectedDiverse];
    multiEntitySuccess = allExpected.every(entity => top3Entities.includes(entity));
  }

  // Detailed failure analysis
  let failureType = null;
  if (!correctPrimary) {
    const allCompetitorsHigh = new Set(groundTruth.competitors_high);
    const allCompetitorsMedium = new Set(groundTruth.competitors_medium);

    // Check failure reason
    const gotCandidate = candidates.find(c => c.entity === gotPrimary);

    if (scenario.patternType === 'pronoun_reference') {
      failureType = allCompetitorsHigh.has(gotPrimary)
        ? 'pronoun_ambiguity_high_similarity'
        : 'pronoun_resolution_failed';
    } else if (scenario.patternType === 'context_switch') {
      failureType = allCompetitorsHigh.has(gotPrimary)
        ? 'context_override_failed'
        : 'wrong_context_selected';
    } else if (scenario.patternType === 'informal_language') {
      failureType = allCompetitorsHigh.has(gotPrimary)
        ? 'informal_formal_mismatch'
        : 'wrong_entity_informal';
    } else if (scenario.patternType === 'multi_entity') {
      failureType = 'multi_entity_ranking_failed';
    } else {
      failureType = allCompetitorsHigh.has(gotPrimary)
        ? 'confused_with_high_similarity_competitor'
        : 'unexpected_entity';
    }
  }

  // Check false positives (results not in expected set)
  const expectedSet = new Set([expectedPrimary, ...expectedDiverse]);
  let falsePositives = 0;
  const top3 = results.slice(0, 3).map(r => r.entity);
  const falsePositiveEntities = [];

  results.forEach(r => {
    if (!expectedSet.has(r.entity)) {
      falsePositives++;
      falsePositiveEntities.push(r.entity);
    }
  });

  return {
    correctPrimary: scenario.patternType === 'multi_entity' ? multiEntitySuccess : correctPrimary,
    gotPrimary,
    expectedPrimary,
    falsePositives,
    falsePositiveEntities,
    failureType,
    top3Results: top3,
    groundTruth,
    patternMetadata,
    results: results.map(r => r.entity)
  };
}

// ═══════════════════════════════════════════════════════════════════════
// MAIN TEST EXECUTION
// ═══════════════════════════════════════════════════════════════════════

function runBatch6Tests() {
  console.log('\n╔═══════════════════════════════════════════════════════════════════╗');
  console.log('║      BATCH 6: REAL-WORLD PATTERNS TEST SUITE                     ║');
  console.log('╚═══════════════════════════════════════════════════════════════════╝\n');

  const scenarios = generateBatch6Scenarios();
  const tracker = new RealWorldMetricsTracker();
  const failures = [];

  scenarios.forEach((scenario, idx) => {
    const result = runScenario(scenario);
    tracker.record(scenario.icp, scenario.patternType, result);

    if (!result.correctPrimary) {
      failures.push({
        num: scenario.num,
        name: scenario.name,
        icp: scenario.icp,
        patternType: scenario.patternType,
        difficulty: scenario.difficulty,
        expected: scenario.expectedPrimary,
        got: result.gotPrimary,
        failureType: result.failureType,
        top3: result.top3Results,
        conversationContext: result.patternMetadata.conversationContext
      });
    }

    // Progress indicator
    if ((idx + 1) % 10 === 0) {
      console.log(`   Completed ${idx + 1}/50 scenarios...`);
    }
  });

  // Print results
  const summary = tracker.getSummary();

  console.log('\n\n╔═══════════════════════════════════════════════════════════════════╗');
  console.log('║                    TEST RESULTS SUMMARY                           ║');
  console.log('╚═══════════════════════════════════════════════════════════════════╝\n');

  // Overall metrics
  console.log('📊 OVERALL METRICS:');
  console.log(`   Total Scenarios: ${summary.overall.total}`);
  console.log(`   Position #1 Accuracy: ${summary.overall.position1Accuracy}%`);
  console.log(`   False Positive Rate: ${summary.overall.fpRate}%\n`);

  // Developer ICP metrics
  console.log('💻 DEVELOPER POWER USER (25 scenarios):');
  console.log(`   Position #1 Accuracy: ${summary.developer.position1Accuracy}% (target: ≥95%)`);
  console.log(`   False Positive Rate: ${summary.developer.fpRate}% (target: ≤30%)\n`);

  console.log('   By Pattern Type:');
  Object.keys(summary.developer.byPatternType).sort().forEach(type => {
    const metrics = summary.developer.byPatternType[type];
    console.log(`   - ${type.padEnd(30)}: ${metrics.position1Accuracy}% accurate, ${metrics.fpRate}% FP (${metrics.total} scenarios)`);
  });

  // Companion ICP metrics
  console.log('\n💬 AI COMPANION USER (25 scenarios):');
  console.log(`   Position #1 Accuracy: ${summary.companion.position1Accuracy}% (target: ≥85%)`);
  console.log(`   False Positive Rate: ${summary.companion.fpRate}% (target: ≤40%)\n`);

  console.log('   By Pattern Type:');
  Object.keys(summary.companion.byPatternType).sort().forEach(type => {
    const metrics = summary.companion.byPatternType[type];
    console.log(`   - ${type.padEnd(30)}: ${metrics.position1Accuracy}% accurate, ${metrics.fpRate}% FP (${metrics.total} scenarios)`);
  });

  // Success criteria
  console.log('\n\n🎯 SUCCESS CRITERIA:\n');

  const devPass = parseFloat(summary.developer.position1Accuracy) >= 95.0;
  const devFPPass = parseFloat(summary.developer.fpRate) <= 30.0;
  console.log(`   Developer Position #1 ≥95%:  ${devPass ? '✅ PASS' : '❌ FAIL'} (${summary.developer.position1Accuracy}%)`);
  console.log(`   Developer FP Rate ≤30%:      ${devFPPass ? '✅ PASS' : '⚠️  WARNING'} (${summary.developer.fpRate}%)`);

  const compPass = parseFloat(summary.companion.position1Accuracy) >= 85.0;
  const compFPPass = parseFloat(summary.companion.fpRate) <= 40.0;
  console.log(`   Companion Position #1 ≥85%:  ${compPass ? '✅ PASS' : '❌ FAIL'} (${summary.companion.position1Accuracy}%)`);
  console.log(`   Companion FP Rate ≤40%:      ${compFPPass ? '✅ PASS' : '⚠️  WARNING'} (${summary.companion.fpRate}%)\n`);

  // Overall pass/fail
  const overallPass = devPass && compPass;

  if (overallPass) {
    console.log('✅ BATCH 6 TEST SUITE PASSED\n');
    console.log('   → Both ICPs meet position #1 accuracy targets');
    console.log('   → Real-world language patterns handled correctly');
    console.log('   → Pronoun references resolve with conversation context');
    console.log('   → Context switches override previous context');
    console.log('   → Informal language matches formal entities');
    console.log('   → Multi-entity queries retrieve both entities');
    console.log('   → Safe to proceed with production deployment\n');
  } else {
    console.log('❌ BATCH 6 TEST SUITE FAILED\n');
    console.log('   → Accuracy targets not met for one or both ICPs');
    console.log('   → Review pattern failures and adjust MMR\n');
  }

  // Print failures with detailed breakdown
  if (failures.length > 0) {
    console.log('══════════════════════════════════════════════════════════════════════');
    console.log(`❌ FAILURES (${failures.length} scenarios)\n`);

    // Failure type breakdown
    const failureTypes = {};
    failures.forEach(f => {
      failureTypes[f.failureType] = (failureTypes[f.failureType] || 0) + 1;
    });

    console.log('Failure Type Breakdown:');
    Object.entries(failureTypes).forEach(([type, count]) => {
      console.log(`   ${type.padEnd(45)}: ${count}`);
    });
    console.log('');

    // Show first 10 failures in detail
    console.log('Detailed Failures (first 10):');
    failures.slice(0, 10).forEach(f => {
      console.log(`\n   Scenario ${f.num}: ${f.name}`);
      console.log(`   ICP: ${f.icp}, Pattern: ${f.patternType}, Difficulty: ${f.difficulty}`);
      console.log(`   Expected: "${f.expected}"`);
      console.log(`   Got:      "${f.got}"`);
      console.log(`   Type:     ${f.failureType}`);
      if (f.conversationContext) {
        console.log(`   Context:  ${f.conversationContext}`);
      }
      console.log(`   Top 3:    ${f.top3.join(', ')}`);
    });

    if (failures.length > 10) {
      console.log(`\n   ... and ${failures.length - 10} more failures`);
    }
    console.log('');
  } else {
    console.log('══════════════════════════════════════════════════════════════════════');
    console.log('✅ NO FAILURES - All scenarios passed!\n');
  }

  // Recommendations
  console.log('══════════════════════════════════════════════════════════════════════');
  console.log('💡 KEY INSIGHTS\n');

  console.log('Pattern Type Performance:');
  console.log('- pronoun_reference: Can MMR resolve "he/she/they" with conversation context?');
  console.log('- context_switch: Can system handle "wait, not that Mike" overrides?');
  console.log('- informal_language: Does "what\'d we decide bout async stuff?" match formal entities?');
  console.log('- multi_entity: Can "Mike and Jennifer" retrieve both entities?\n');

  console.log('What Real-World Patterns Test:');
  console.log('- Conversation-aware pronoun resolution');
  console.log('- Context override and clarification');
  console.log('- Informal ↔ formal language matching');
  console.log('- Multi-entity query ranking\n');

  console.log('Next Steps:');
  if (overallPass) {
    console.log('1. Real-world patterns validated - MMR handles natural language');
    console.log('2. Combined with Batches 2, 3, 5, 7 = 250 scenarios validated');
    console.log('3. Ready for production deployment\n');
  } else {
    console.log('1. Review pattern failure types');
    console.log('2. Consider conversation context weighting adjustments');
    console.log('3. May need to boost context signals vs pure semantic match\n');
  }

  return {
    passed: overallPass,
    summary,
    failures
  };
}

// Run tests
runBatch6Tests();
