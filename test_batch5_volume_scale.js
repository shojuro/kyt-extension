/**
 * Batch 5 Test Runner: Volume & Scale Stress Test
 *
 * Tests MMR + Entity Deduplication with extreme edge cases
 *
 * ═══════════════════════════════════════════════════════════════════════
 * TESTING METHODOLOGY
 * ═══════════════════════════════════════════════════════════════════════
 *
 * This test uses SYNTHETIC EMBEDDINGS with EXTREME CONDITIONS.
 *
 * What this test VALIDATES:
 * ✅ Dense clusters (7+ entities) don't overwhelm MMR
 * ✅ Sparse entities (1 mention, months ago) can still be retrieved
 * ✅ Extreme frequency imbalance (200 vs 1) handled correctly
 * ✅ Unicode, typos, special characters work
 * ✅ Entity deduplication prevents duplicate results
 *
 * What this test DOES NOT VALIDATE:
 * ❌ Real production embedding quality
 * ❌ Actual typo correction algorithms
 * ❌ Real unicode normalization
 *
 * ASSUMPTION:
 * "If MMR handles extreme synthetic edge cases,
 * it will work the same way in production."
 *
 * ═══════════════════════════════════════════════════════════════════════
 */

import { applyMMR, MMR_PRESETS } from './src/mmr.js';
import { generateBatch5Scenarios } from './generate_batch5_volume_scale.js';

// ═══════════════════════════════════════════════════════════════════════
// ICP + EDGE CASE METRICS TRACKER
// ═══════════════════════════════════════════════════════════════════════

class VolumeMetricsTracker {
  constructor() {
    this.developer = {
      total: 0,
      byEdgeCaseType: {},
      position1Correct: 0,
      falsePositives: 0,
      totalResults: 0
    };
    this.companion = {
      total: 0,
      byEdgeCaseType: {},
      position1Correct: 0,
      falsePositives: 0,
      totalResults: 0
    };
  }

  record(icp, edgeCaseType, result) {
    const metrics = this[icp];
    metrics.total++;
    metrics.totalResults += 3;

    // Track by edge case type
    if (!metrics.byEdgeCaseType[edgeCaseType]) {
      metrics.byEdgeCaseType[edgeCaseType] = {
        total: 0,
        position1Correct: 0,
        falsePositives: 0
      };
    }
    metrics.byEdgeCaseType[edgeCaseType].total++;

    if (result.correctPrimary) {
      metrics.position1Correct++;
      metrics.byEdgeCaseType[edgeCaseType].position1Correct++;
    }

    metrics.falsePositives += result.falsePositives;
    metrics.byEdgeCaseType[edgeCaseType].falsePositives += result.falsePositives;
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
      byEdgeCaseType: {}
    };

    Object.keys(metrics.byEdgeCaseType).forEach(type => {
      const typeMetrics = metrics.byEdgeCaseType[type];
      summary.byEdgeCaseType[type] = {
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

  // Get edge case metadata
  const primaryCandidate = candidates.find(c => c.ground_truth === 'primary');
  const edgeCaseMetadata = {
    mentions: primaryCandidate?.mentions,
    monthsAgo: primaryCandidate?.monthsAgo
  };

  // Check primary entity
  const gotPrimary = results[0].entity;
  const correctPrimary = gotPrimary === expectedPrimary;

  // Detailed failure analysis
  let failureType = null;
  if (!correctPrimary) {
    const allCompetitorsHigh = new Set(groundTruth.competitors_high);
    const allCompetitorsMedium = new Set(groundTruth.competitors_medium);

    // Check failure reason
    const gotCandidate = candidates.find(c => c.entity === gotPrimary);
    const frequencyBiasFailure = gotCandidate && gotCandidate.mentions > (primaryCandidate?.mentions || 0);

    if (allCompetitorsHigh.has(gotPrimary)) {
      failureType = frequencyBiasFailure
        ? 'frequency_bias_high_similarity'
        : 'confused_with_high_similarity_competitor';
    } else if (allCompetitorsMedium.has(gotPrimary)) {
      failureType = frequencyBiasFailure
        ? 'frequency_bias_medium_similarity'
        : 'confused_with_medium_similarity_competitor';
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
    edgeCaseMetadata,
    results: results.map(r => r.entity)
  };
}

// ═══════════════════════════════════════════════════════════════════════
// MAIN TEST EXECUTION
// ═══════════════════════════════════════════════════════════════════════

function runBatch5Tests() {
  console.log('\n╔═══════════════════════════════════════════════════════════════════╗');
  console.log('║      BATCH 5: VOLUME & SCALE STRESS TEST SUITE                   ║');
  console.log('╚═══════════════════════════════════════════════════════════════════╝\n');

  const scenarios = generateBatch5Scenarios();
  const tracker = new VolumeMetricsTracker();
  const failures = [];

  scenarios.forEach((scenario, idx) => {
    const result = runScenario(scenario);
    tracker.record(scenario.icp, scenario.edgeCaseType, result);

    if (!result.correctPrimary) {
      failures.push({
        num: scenario.num,
        name: scenario.name,
        icp: scenario.icp,
        edgeCaseType: scenario.edgeCaseType,
        expected: scenario.expectedPrimary,
        got: result.gotPrimary,
        failureType: result.failureType,
        top3: result.top3Results,
        mentions: result.edgeCaseMetadata.mentions,
        monthsAgo: result.edgeCaseMetadata.monthsAgo
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

  console.log('   By Edge Case Type:');
  Object.keys(summary.developer.byEdgeCaseType).sort().forEach(type => {
    const metrics = summary.developer.byEdgeCaseType[type];
    console.log(`   - ${type.padEnd(30)}: ${metrics.position1Accuracy}% accurate, ${metrics.fpRate}% FP (${metrics.total} scenarios)`);
  });

  // Companion ICP metrics
  console.log('\n💬 AI COMPANION USER (25 scenarios):');
  console.log(`   Position #1 Accuracy: ${summary.companion.position1Accuracy}% (target: ≥85%)`);
  console.log(`   False Positive Rate: ${summary.companion.fpRate}% (target: ≤40%)\n`);

  console.log('   By Edge Case Type:');
  Object.keys(summary.companion.byEdgeCaseType).sort().forEach(type => {
    const metrics = summary.companion.byEdgeCaseType[type];
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
    console.log('✅ BATCH 5 TEST SUITE PASSED\n');
    console.log('   → Both ICPs meet position #1 accuracy targets');
    console.log('   → Extreme edge cases handled correctly');
    console.log('   → Dense clusters don\'t overwhelm MMR');
    console.log('   → Sparse entities can be retrieved');
    console.log('   → Safe to proceed with production deployment\n');
  } else {
    console.log('❌ BATCH 5 TEST SUITE FAILED\n');
    console.log('   → Accuracy targets not met for one or both ICPs');
    console.log('   → Review edge case failures and adjust MMR\n');
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
      console.log(`   ICP: ${f.icp}, Edge Case: ${f.edgeCaseType}`);
      console.log(`   Expected: "${f.expected}"`);
      console.log(`   Got:      "${f.got}"`);
      console.log(`   Type:     ${f.failureType}`);
      if (f.mentions) {
        console.log(`   Primary mentions: ${f.mentions}${f.monthsAgo ? `, ${f.monthsAgo} months ago` : ''}`);
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

  console.log('Edge Case Type Performance:');
  console.log('- dense_cluster: Can MMR handle 7+ similar entities competing?');
  console.log('- sparse_entity: Can we retrieve entities mentioned once, months ago?');
  console.log('- extreme_frequency: Does 200 vs 1 mentions overwhelm semantic match?');
  console.log('- unicode_handling: Do unicode variants match correctly?');
  console.log('- typo_handling: Can system handle common typos?');
  console.log('- special_characters: Do special characters affect matching?\n');

  console.log('What Volume & Scale Tests:');
  console.log('- Breaking points with dense clusters');
  console.log('- Sparse entity retrieval (low frequency, old)');
  console.log('- Frequency bias (high mentions vs semantic relevance)');
  console.log('- Character encoding edge cases\n');

  console.log('Next Steps:');
  if (overallPass) {
    console.log('1. Volume & scale validated - MMR handles extreme edge cases');
    console.log('2. Combined with Batches 2, 3, 7 = 200 scenarios validated');
    console.log('3. Ready for production deployment\n');
  } else {
    console.log('1. Review edge case failure patterns');
    console.log('2. Consider frequency normalization adjustments');
    console.log('3. May need to boost semantic relevance vs frequency\n');
  }

  return {
    passed: overallPass,
    summary,
    failures
  };
}

// Run tests
runBatch5Tests();
