/**
 * Batch 2 Test Runner: Query Complexity Variations
 *
 * Tests MMR + Entity Deduplication across different query formulations
 * with ICP-specific metrics tracking
 *
 * ═══════════════════════════════════════════════════════════════════════
 * TESTING METHODOLOGY
 * ═══════════════════════════════════════════════════════════════════════
 *
 * This test uses SYNTHETIC EMBEDDINGS that model realistic distance distributions.
 *
 * What this test VALIDATES:
 * ✅ MMR algorithm logic is correct
 * ✅ Entity deduplication prevents duplicates
 * ✅ Query complexity handling (single-word, vague, full-sentence)
 * ✅ ICP-specific scenarios work correctly
 *
 * What this test DOES NOT VALIDATE:
 * ❌ Real production embedding quality
 * ❌ Actual semantic similarity from your embedding model
 * ❌ Production data characteristics
 *
 * ASSUMPTION:
 * "If real embeddings from production have similar distance distributions
 * to our synthetic ones, then MMR will perform as tested."
 *
 * To validate this assumption, run: node validate_embedding_realism.js
 *
 * ═══════════════════════════════════════════════════════════════════════
 */

import { applyMMR, MMR_PRESETS } from './src/mmr.js';
import { generateBatch2Scenarios } from './generate_batch2_query_complexity.js';

// ═══════════════════════════════════════════════════════════════════════
// ICP-SPECIFIC METRICS TRACKER
// ═══════════════════════════════════════════════════════════════════════

class ICPMetricsTracker {
  constructor() {
    this.developer = {
      total: 0,
      byQueryType: {},
      position1Correct: 0,
      falsePositives: 0,
      totalResults: 0
    };
    this.companion = {
      total: 0,
      byQueryType: {},
      position1Correct: 0,
      falsePositives: 0,
      totalResults: 0
    };
  }

  record(icp, queryType, result) {
    const metrics = this[icp];
    metrics.total++;
    metrics.totalResults += 3;

    // Track by query type
    if (!metrics.byQueryType[queryType]) {
      metrics.byQueryType[queryType] = {
        total: 0,
        position1Correct: 0,
        falsePositives: 0
      };
    }
    metrics.byQueryType[queryType].total++;

    if (result.correctPrimary) {
      metrics.position1Correct++;
      metrics.byQueryType[queryType].position1Correct++;
    }

    metrics.falsePositives += result.falsePositives;
    metrics.byQueryType[queryType].falsePositives += result.falsePositives;
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
      byQueryType: {}
    };

    Object.keys(metrics.byQueryType).forEach(type => {
      const typeMetrics = metrics.byQueryType[type];
      summary.byQueryType[type] = {
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
    competitors_medium: candidates.filter(c => c.ground_truth === 'competitor_medium').map(c => c.entity),
    distractors: candidates.filter(c => c.ground_truth === 'distractor').map(c => c.entity)
  };

  // Check primary entity
  const gotPrimary = results[0].entity;
  const correctPrimary = gotPrimary === expectedPrimary;

  // Detailed failure analysis
  let failureType = null;
  if (!correctPrimary) {
    // Flatten all competitor arrays
    const allCompetitorsHigh = new Set(groundTruth.competitors_high);
    const allCompetitorsMedium = new Set(groundTruth.competitors_medium);
    const allDistractors = new Set(groundTruth.distractors);

    if (allCompetitorsHigh.has(gotPrimary)) {
      failureType = 'confused_with_high_similarity_competitor';
    } else if (allCompetitorsMedium.has(gotPrimary)) {
      failureType = 'confused_with_medium_similarity_competitor';
    } else if (allDistractors.has(gotPrimary)) {
      failureType = 'confused_with_distractor';
    } else {
      failureType = 'unexpected_entity';
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
    correctPrimary,
    gotPrimary,
    expectedPrimary,
    falsePositives,
    falsePositiveEntities,
    failureType,
    top3Results: top3,
    groundTruth,
    results: results.map(r => r.entity)
  };
}

// ═══════════════════════════════════════════════════════════════════════
// MAIN TEST EXECUTION
// ═══════════════════════════════════════════════════════════════════════

function runBatch2Tests() {
  console.log('\n╔═══════════════════════════════════════════════════════════════════╗');
  console.log('║         BATCH 2: QUERY COMPLEXITY TEST SUITE                     ║');
  console.log('╚═══════════════════════════════════════════════════════════════════╝\n');

  const scenarios = generateBatch2Scenarios();
  const tracker = new ICPMetricsTracker();
  const failures = [];

  scenarios.forEach((scenario, idx) => {
    const result = runScenario(scenario);
    tracker.record(scenario.icp, scenario.queryType, result);

    if (!result.correctPrimary) {
      failures.push({
        num: scenario.num,
        name: scenario.name,
        icp: scenario.icp,
        queryType: scenario.queryType,
        expected: scenario.expectedPrimary,
        got: result.gotPrimary,
        failureType: result.failureType,
        top3: result.top3Results
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

  console.log('   By Query Type:');
  Object.keys(summary.developer.byQueryType).forEach(type => {
    const metrics = summary.developer.byQueryType[type];
    console.log(`   - ${type.padEnd(20)}: ${metrics.position1Accuracy}% accurate, ${metrics.fpRate}% FP (${metrics.total} scenarios)`);
  });

  // Companion ICP metrics
  console.log('\n💬 AI COMPANION USER (25 scenarios):');
  console.log(`   Position #1 Accuracy: ${summary.companion.position1Accuracy}% (target: ≥85%)`);
  console.log(`   False Positive Rate: ${summary.companion.fpRate}% (target: ≤40%)\n`);

  console.log('   By Query Type:');
  Object.keys(summary.companion.byQueryType).forEach(type => {
    const metrics = summary.companion.byQueryType[type];
    console.log(`   - ${type.padEnd(20)}: ${metrics.position1Accuracy}% accurate, ${metrics.fpRate}% FP (${metrics.total} scenarios)`);
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
    console.log('✅ BATCH 2 TEST SUITE PASSED\n');
    console.log('   → Both ICPs meet position #1 accuracy targets');
    console.log('   → Query complexity handled across all formulations');
    console.log('   → Safe to proceed with Batch 3 (Temporal Diversity)\n');
  } else {
    console.log('❌ BATCH 2 TEST SUITE FAILED\n');
    console.log('   → Accuracy targets not met for one or both ICPs');
    console.log('   → Review failures below and adjust MMR lambda\n');
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
      console.log(`   ICP: ${f.icp}, Query Type: ${f.queryType}`);
      console.log(`   Expected: "${f.expected}"`);
      console.log(`   Got:      "${f.got}"`);
      console.log(`   Type:     ${f.failureType}`);
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

  console.log('Query Type Performance:');
  console.log('- Single-word queries: Test if embeddings handle minimal context');
  console.log('- Context queries: Test if additional context improves accuracy');
  console.log('- Full sentence: Test natural language understanding');
  console.log('- Vague queries: Hardest case, expect lower accuracy');
  console.log('- Clarified: Test explicit disambiguation\n');

  console.log('Next Steps:');
  if (overallPass) {
    console.log('1. Proceed to Batch 3 (Temporal Diversity)');
    console.log('2. Monitor if FP rates trend upward across batches');
    console.log('3. Consider λ adjustment if Developer FP > 30% consistently\n');
  } else {
    console.log('1. Review failure patterns by query type');
    console.log('2. Consider increasing λ (more relevance) for failing query types');
    console.log('3. Test with λ=0.4 or 0.5 if vague queries consistently fail\n');
  }

  return {
    passed: overallPass,
    summary,
    failures
  };
}

// Run tests
runBatch2Tests();
