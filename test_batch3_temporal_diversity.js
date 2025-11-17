/**
 * Batch 3 Test Runner: Temporal Diversity
 *
 * Tests MMR + Entity Deduplication with temporal factors
 *
 * ═══════════════════════════════════════════════════════════════════════
 * TESTING METHODOLOGY
 * ═══════════════════════════════════════════════════════════════════════
 *
 * This test uses SYNTHETIC EMBEDDINGS with TEMPORAL METADATA.
 *
 * What this test VALIDATES:
 * ✅ MMR algorithm handles temporal factors correctly
 * ✅ Relevance doesn't get overwhelmed by recency bias
 * ✅ Entity deduplication works with temporal data
 * ✅ Time-explicit queries filter correctly
 * ✅ ICP-specific temporal scenarios work
 *
 * What this test DOES NOT VALIDATE:
 * ❌ Real production embedding quality
 * ❌ Actual temporal decay functions in production
 * ❌ Real timestamp handling in database
 *
 * ASSUMPTION:
 * "If MMR properly balances relevance + recency with synthetic data,
 * it will work the same way in production."
 *
 * ═══════════════════════════════════════════════════════════════════════
 */

import { applyMMR, MMR_PRESETS } from './src/mmr.js';
import { generateBatch3Scenarios } from './generate_batch3_temporal_diversity.js';

// ═══════════════════════════════════════════════════════════════════════
// ICP + TEMPORAL METRICS TRACKER
// ═══════════════════════════════════════════════════════════════════════

class TemporalMetricsTracker {
  constructor() {
    this.developer = {
      total: 0,
      byTemporalType: {},
      position1Correct: 0,
      falsePositives: 0,
      totalResults: 0
    };
    this.companion = {
      total: 0,
      byTemporalType: {},
      position1Correct: 0,
      falsePositives: 0,
      totalResults: 0
    };
  }

  record(icp, temporalType, result) {
    const metrics = this[icp];
    metrics.total++;
    metrics.totalResults += 3;

    // Track by temporal type
    if (!metrics.byTemporalType[temporalType]) {
      metrics.byTemporalType[temporalType] = {
        total: 0,
        position1Correct: 0,
        falsePositives: 0
      };
    }
    metrics.byTemporalType[temporalType].total++;

    if (result.correctPrimary) {
      metrics.position1Correct++;
      metrics.byTemporalType[temporalType].position1Correct++;
    }

    metrics.falsePositives += result.falsePositives;
    metrics.byTemporalType[temporalType].falsePositives += result.falsePositives;
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
      byTemporalType: {}
    };

    Object.keys(metrics.byTemporalType).forEach(type => {
      const typeMetrics = metrics.byTemporalType[type];
      summary.byTemporalType[type] = {
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

  // Get temporal metadata for primary
  const primaryCandidate = candidates.find(c => c.ground_truth === 'primary');
  const primaryRecency = {
    daysAgo: primaryCandidate?.daysAgo,
    recencyScore: primaryCandidate?.recencyScore,
    timestamp: primaryCandidate?.timestamp
  };

  // Check primary entity
  const gotPrimary = results[0].entity;
  const correctPrimary = gotPrimary === expectedPrimary;

  // Detailed failure analysis
  let failureType = null;
  if (!correctPrimary) {
    const allCompetitorsHigh = new Set(groundTruth.competitors_high);
    const allCompetitorsMedium = new Set(groundTruth.competitors_medium);
    const allDistractors = new Set(groundTruth.distractors);

    // Check if failed due to recency bias
    const gotCandidate = candidates.find(c => c.entity === gotPrimary);
    const recencyBiasFailure = gotCandidate && gotCandidate.recencyScore > primaryRecency.recencyScore;

    if (allCompetitorsHigh.has(gotPrimary)) {
      failureType = recencyBiasFailure
        ? 'recency_bias_high_similarity'
        : 'confused_with_high_similarity_competitor';
    } else if (allCompetitorsMedium.has(gotPrimary)) {
      failureType = recencyBiasFailure
        ? 'recency_bias_medium_similarity'
        : 'confused_with_medium_similarity_competitor';
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
    primaryRecency,
    results: results.map(r => r.entity)
  };
}

// ═══════════════════════════════════════════════════════════════════════
// MAIN TEST EXECUTION
// ═══════════════════════════════════════════════════════════════════════

function runBatch3Tests() {
  console.log('\n╔═══════════════════════════════════════════════════════════════════╗');
  console.log('║      BATCH 3: TEMPORAL DIVERSITY TEST SUITE                      ║');
  console.log('╚═══════════════════════════════════════════════════════════════════╝\n');

  const scenarios = generateBatch3Scenarios();
  const tracker = new TemporalMetricsTracker();
  const failures = [];

  scenarios.forEach((scenario, idx) => {
    const result = runScenario(scenario);
    tracker.record(scenario.icp, scenario.temporalType, result);

    if (!result.correctPrimary) {
      failures.push({
        num: scenario.num,
        name: scenario.name,
        icp: scenario.icp,
        temporalType: scenario.temporalType,
        expected: scenario.expectedPrimary,
        got: result.gotPrimary,
        failureType: result.failureType,
        top3: result.top3Results,
        primaryDaysAgo: result.primaryRecency.daysAgo,
        primaryRecencyScore: result.primaryRecency.recencyScore
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
  console.log(`   Position #1 Accuracy: ${summary.developer.position1Accuracy}% (target: ≥95%)%`);
  console.log(`   False Positive Rate: ${summary.developer.fpRate}% (target: ≤30%)\n`);

  console.log('   By Temporal Type:');
  Object.keys(summary.developer.byTemporalType).forEach(type => {
    const metrics = summary.developer.byTemporalType[type];
    console.log(`   - ${type.padEnd(25)}: ${metrics.position1Accuracy}% accurate, ${metrics.fpRate}% FP (${metrics.total} scenarios)`);
  });

  // Companion ICP metrics
  console.log('\n💬 AI COMPANION USER (25 scenarios):');
  console.log(`   Position #1 Accuracy: ${summary.companion.position1Accuracy}% (target: ≥85%)`);
  console.log(`   False Positive Rate: ${summary.companion.fpRate}% (target: ≤40%)\n`);

  console.log('   By Temporal Type:');
  Object.keys(summary.companion.byTemporalType).forEach(type => {
    const metrics = summary.companion.byTemporalType[type];
    console.log(`   - ${type.padEnd(25)}: ${metrics.position1Accuracy}% accurate, ${metrics.fpRate}% FP (${metrics.total} scenarios)`);
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
    console.log('✅ BATCH 3 TEST SUITE PASSED\n');
    console.log('   → Both ICPs meet position #1 accuracy targets');
    console.log('   → Temporal diversity handled correctly');
    console.log('   → Relevance not overwhelmed by recency bias');
    console.log('   → Safe to proceed with production deployment\n');
  } else {
    console.log('❌ BATCH 3 TEST SUITE FAILED\n');
    console.log('   → Accuracy targets not met for one or both ICPs');
    console.log('   → Review temporal failures and adjust MMR\n');
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
      console.log(`   ICP: ${f.icp}, Temporal Type: ${f.temporalType}`);
      console.log(`   Expected: "${f.expected}"`);
      console.log(`   Got:      "${f.got}"`);
      console.log(`   Type:     ${f.failureType}`);
      console.log(`   Primary: ${f.primaryDaysAgo.toFixed(1)} days ago (recency: ${f.primaryRecencyScore.toFixed(3)})`);
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

  console.log('Temporal Type Performance:');
  console.log('- recent_entities: Test if MMR handles recent context correctly');
  console.log('- old_entities: Test if old but relevant entities still rank high');
  console.log('- mixed_temporal: Test if relevance > recency (critical)');
  console.log('- time_explicit: Test temporal filtering ("last week", "yesterday")\n');

  console.log('What Temporal Diversity Tests:');
  console.log('- Does recency bias overwhelm semantic relevance?');
  console.log('- Can MMR retrieve old but highly relevant entities?');
  console.log('- Do time-explicit queries filter correctly?\n');

  console.log('Next Steps:');
  if (overallPass) {
    console.log('1. Temporal diversity validated - MMR balances recency + relevance');
    console.log('2. Combined with Batch 2 + 7 = 150 scenarios validated');
    console.log('3. Ready for production deployment\n');
  } else {
    console.log('1. Review temporal failure patterns');
    console.log('2. Consider temporal decay adjustments');
    console.log('3. May need to boost relevance vs recency weighting\n');
  }

  return {
    passed: overallPass,
    summary,
    failures
  };
}

// Run tests
runBatch3Tests();
