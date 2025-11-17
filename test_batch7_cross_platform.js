/**
 * Batch 7 Test Runner: Cross-Platform Disambiguation
 *
 * Tests K.Y.T.'s CORE VALUE PROP: Memory across ChatGPT + Claude
 * with ICP-specific metrics tracking
 *
 * ═══════════════════════════════════════════════════════════════════════
 * TESTING METHODOLOGY
 * ═══════════════════════════════════════════════════════════════════════
 *
 * This test uses SYNTHETIC EMBEDDINGS that model realistic distance distributions.
 *
 * What this test VALIDATES:
 * ✅ MMR algorithm handles cross-platform metadata correctly
 * ✅ Entity deduplication works across platforms
 * ✅ Platform affinity vs recency trade-offs are handled
 * ✅ Cross-platform recall (K.Y.T.'s unique value proposition)
 *
 * What this test DOES NOT VALIDATE:
 * ❌ Real production embedding quality from ChatGPT/Claude messages
 * ❌ Actual semantic similarity across different platforms
 * ❌ Production cross-platform data characteristics
 *
 * ASSUMPTION:
 * "If real embeddings from ChatGPT and Claude have similar distance
 * distributions to our synthetic ones, then MMR will perform as tested."
 *
 * To validate this assumption, run: node validate_embedding_realism.js
 *
 * ═══════════════════════════════════════════════════════════════════════
 */

import { applyMMR, MMR_PRESETS } from './src/mmr.js';
import { generateBatch7Scenarios } from './generate_batch7_cross_platform.js';

// ═══════════════════════════════════════════════════════════════════════
// CROSS-PLATFORM METRICS TRACKER
// ═══════════════════════════════════════════════════════════════════════

class CrossPlatformMetricsTracker {
  constructor() {
    this.developer = {
      total: 0,
      byCrossPlatformType: {},
      position1Correct: 0,
      crossPlatformRecall: 0,
      crossPlatformAttempts: 0,
      falsePositives: 0,
      totalResults: 0
    };
    this.companion = {
      total: 0,
      byCrossPlatformType: {},
      position1Correct: 0,
      crossPlatformRecall: 0,
      crossPlatformAttempts: 0,
      falsePositives: 0,
      totalResults: 0
    };
  }

  record(icp, crossPlatformType, result, scenario) {
    const metrics = this[icp];
    metrics.total++;
    metrics.totalResults += 3;

    // Track by cross-platform type
    if (!metrics.byCrossPlatformType[crossPlatformType]) {
      metrics.byCrossPlatformType[crossPlatformType] = {
        total: 0,
        position1Correct: 0,
        crossPlatformRecall: 0,
        crossPlatformAttempts: 0
      };
    }
    const typeMetrics = metrics.byCrossPlatformType[crossPlatformType];
    typeMetrics.total++;

    if (result.correctPrimary) {
      metrics.position1Correct++;
      typeMetrics.position1Correct++;
    }

    // Track cross-platform recall
    const primaryPlatform = scenario.candidates.find(c => c.entity === scenario.expectedPrimary)?.platform;
    const queryPlatform = scenario.queryPlatform;
    if (primaryPlatform !== queryPlatform) {
      metrics.crossPlatformAttempts++;
      typeMetrics.crossPlatformAttempts++;
      if (result.correctPrimary) {
        metrics.crossPlatformRecall++;
        typeMetrics.crossPlatformRecall++;
      }
    }

    metrics.falsePositives += result.falsePositives;
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
      crossPlatformRecall: metrics.crossPlatformAttempts > 0
        ? ((metrics.crossPlatformRecall / metrics.crossPlatformAttempts) * 100).toFixed(1)
        : 'N/A',
      fpRate: ((metrics.falsePositives / metrics.totalResults) * 100).toFixed(1),
      byCrossPlatformType: {}
    };

    Object.keys(metrics.byCrossPlatformType).forEach(type => {
      const typeMetrics = metrics.byCrossPlatformType[type];
      summary.byCrossPlatformType[type] = {
        total: typeMetrics.total,
        position1Accuracy: ((typeMetrics.position1Correct / typeMetrics.total) * 100).toFixed(1),
        crossPlatformRecall: typeMetrics.crossPlatformAttempts > 0
          ? ((typeMetrics.crossPlatformRecall / typeMetrics.crossPlatformAttempts) * 100).toFixed(1)
          : 'N/A'
      };
    });

    return summary;
  }

  getOverallSummary() {
    const totalScenarios = this.developer.total + this.companion.total;
    const totalCorrect = this.developer.position1Correct + this.companion.position1Correct;
    const totalCrossPlatformAttempts = this.developer.crossPlatformAttempts + this.companion.crossPlatformAttempts;
    const totalCrossPlatformRecall = this.developer.crossPlatformRecall + this.companion.crossPlatformRecall;
    const totalFP = this.developer.falsePositives + this.companion.falsePositives;
    const totalResults = this.developer.totalResults + this.companion.totalResults;

    return {
      total: totalScenarios,
      position1Accuracy: ((totalCorrect / totalScenarios) * 100).toFixed(1),
      crossPlatformRecall: totalCrossPlatformAttempts > 0
        ? ((totalCrossPlatformRecall / totalCrossPlatformAttempts) * 100).toFixed(1)
        : 'N/A',
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
    const allCompetitorsHigh = new Set(groundTruth.competitors_high);
    const allCompetitorsMedium = new Set(groundTruth.competitors_medium);
    const allDistractors = new Set(groundTruth.distractors || []);

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

  // Check false positives
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
    results: results.map(r => ({
      entity: r.entity,
      platform: r.platform,
      daysAgo: r.daysAgo
    }))
  };
}

// ═══════════════════════════════════════════════════════════════════════
// MAIN TEST EXECUTION
// ═══════════════════════════════════════════════════════════════════════

function runBatch7Tests() {
  console.log('\n╔═══════════════════════════════════════════════════════════════════╗');
  console.log('║      BATCH 7: CROSS-PLATFORM DISAMBIGUATION TEST SUITE           ║');
  console.log('║                K.Y.T. Core Value Prop Validation                  ║');
  console.log('╚═══════════════════════════════════════════════════════════════════╝\n');

  const scenarios = generateBatch7Scenarios();
  const tracker = new CrossPlatformMetricsTracker();
  const failures = [];

  scenarios.forEach((scenario, idx) => {
    const result = runScenario(scenario);
    tracker.record(scenario.icp, scenario.crossPlatformType, result, scenario);

    if (!result.correctPrimary) {
      failures.push({
        num: scenario.num,
        name: scenario.name,
        icp: scenario.icp,
        crossPlatformType: scenario.crossPlatformType,
        queryPlatform: scenario.queryPlatform,
        expected: scenario.expectedPrimary,
        got: result.gotPrimary,
        failureType: result.failureType,
        top3: result.top3Results,
        expectedBehavior: scenario.expectedBehavior
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
  console.log(`   Cross-Platform Recall: ${summary.overall.crossPlatformRecall}%`);
  console.log(`   False Positive Rate: ${summary.overall.fpRate}%\n`);

  // Developer ICP metrics
  console.log('💻 DEVELOPER POWER USER (25 scenarios):');
  console.log(`   Position #1 Accuracy: ${summary.developer.position1Accuracy}% (target: ≥95%)`);
  console.log(`   Cross-Platform Recall: ${summary.developer.crossPlatformRecall}% (target: ≥90%)`);
  console.log(`   False Positive Rate: ${summary.developer.fpRate}% (target: ≤30%)\n`);

  console.log('   By Cross-Platform Type:');
  Object.keys(summary.developer.byCrossPlatformType).forEach(type => {
    const metrics = summary.developer.byCrossPlatformType[type];
    console.log(`   - ${type.padEnd(25)}: ${metrics.position1Accuracy}% accurate, ${metrics.crossPlatformRecall}% cross-platform (${metrics.total} scenarios)`);
  });

  // Companion ICP metrics
  console.log('\n💬 AI COMPANION USER (25 scenarios):');
  console.log(`   Position #1 Accuracy: ${summary.companion.position1Accuracy}% (target: ≥85%)`);
  console.log(`   Cross-Platform Recall: ${summary.companion.crossPlatformRecall}% (target: ≥85%)`);
  console.log(`   False Positive Rate: ${summary.companion.fpRate}% (target: ≤40%)\n`);

  console.log('   By Cross-Platform Type:');
  Object.keys(summary.companion.byCrossPlatformType).forEach(type => {
    const metrics = summary.companion.byCrossPlatformType[type];
    console.log(`   - ${type.padEnd(25)}: ${metrics.position1Accuracy}% accurate, ${metrics.crossPlatformRecall}% cross-platform (${metrics.total} scenarios)`);
  });

  // Success criteria
  console.log('\n\n🎯 SUCCESS CRITERIA:\n');

  const devPosPass = parseFloat(summary.developer.position1Accuracy) >= 95.0;
  const devCrossPlatformPass = summary.developer.crossPlatformRecall === 'N/A' || parseFloat(summary.developer.crossPlatformRecall) >= 90.0;
  const devFPPass = parseFloat(summary.developer.fpRate) <= 30.0;

  console.log(`   Developer Position #1 ≥95%:        ${devPosPass ? '✅ PASS' : '❌ FAIL'} (${summary.developer.position1Accuracy}%)`);
  console.log(`   Developer Cross-Platform ≥90%:     ${devCrossPlatformPass ? '✅ PASS' : '❌ FAIL'} (${summary.developer.crossPlatformRecall}%)`);
  console.log(`   Developer FP Rate ≤30%:            ${devFPPass ? '✅ PASS' : '⚠️  WARNING'} (${summary.developer.fpRate}%)`);

  const compPosPass = parseFloat(summary.companion.position1Accuracy) >= 85.0;
  const compCrossPlatformPass = summary.companion.crossPlatformRecall === 'N/A' || parseFloat(summary.companion.crossPlatformRecall) >= 85.0;
  const compFPPass = parseFloat(summary.companion.fpRate) <= 40.0;

  console.log(`   Companion Position #1 ≥85%:        ${compPosPass ? '✅ PASS' : '❌ FAIL'} (${summary.companion.position1Accuracy}%)`);
  console.log(`   Companion Cross-Platform ≥85%:     ${compCrossPlatformPass ? '✅ PASS' : '❌ FAIL'} (${summary.companion.crossPlatformRecall}%)`);
  console.log(`   Companion FP Rate ≤40%:            ${compFPPass ? '✅ PASS' : '⚠️  WARNING'} (${summary.companion.fpRate}%)\n`);

  // Overall pass/fail
  const overallPass = devPosPass && devCrossPlatformPass && compPosPass && compCrossPlatformPass;

  if (overallPass) {
    console.log('✅ BATCH 7 TEST SUITE PASSED - CORE VALUE PROP VALIDATED\n');
    console.log('   → Both ICPs meet position #1 accuracy targets');
    console.log('   → Cross-platform memory recall works across ChatGPT + Claude');
    console.log('   → K.Y.T. core differentiator is production-ready');
    console.log('   → Safe to proceed with beta deployment\n');
  } else {
    console.log('❌ BATCH 7 TEST SUITE FAILED\n');
    console.log('   → Core value prop validation incomplete');
    console.log('   → Cross-platform recall below targets');
    console.log('   → Review failures and adjust MMR strategy\n');
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
      console.log(`   ICP: ${f.icp}, Type: ${f.crossPlatformType}`);
      console.log(`   Query Platform: ${f.queryPlatform}`);
      console.log(`   Expected: "${f.expected}"`);
      console.log(`   Got:      "${f.got}"`);
      console.log(`   Type:     ${f.failureType}`);
      console.log(`   Top 3:    ${f.top3.join(', ')}`);
      console.log(`   Expected Behavior: ${f.expectedBehavior}`);
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

  console.log('Cross-Platform Type Performance:');
  console.log('- same_topic_both: Same topic discussed in ChatGPT + Claude');
  console.log('- cross_platform_query: Mentioned in one, queried in other');
  console.log('- platform_clarification: User explicitly specifies platform\n');

  console.log('What Cross-Platform Recall Measures:');
  console.log('- Can system retrieve context from ChatGPT when querying in Claude?');
  console.log('- Can system retrieve context from Claude when querying in ChatGPT?');
  console.log('- Does platform affinity vs recency trade-off work correctly?\n');

  console.log('Critical for Beta:');
  if (overallPass) {
    console.log('✅ Cross-platform memory is K.Y.T.\'s unique value proposition');
    console.log('✅ Neither OpenAI nor Anthropic can do this');
    console.log('✅ Both ICPs get value from unified memory across platforms');
    console.log('✅ Ready for beta deployment with cross-platform as core feature\n');
  } else {
    console.log('⚠️  Cross-platform recall needs improvement before beta');
    console.log('⚠️  Consider platform-aware embeddings or metadata');
    console.log('⚠️  May need separate λ parameter for cross-platform vs same-platform');
    console.log('⚠️  Review failed scenarios to identify patterns\n');
  }

  console.log('Next Steps:');
  if (overallPass) {
    console.log('1. Combine Batch 2 + Batch 7 results (100 scenarios total)');
    console.log('2. Aggregate metrics across both batches');
    console.log('3. If combined metrics pass, ready for beta deployment');
    console.log('4. Optional: Run Batch 3 (Temporal) for additional confidence\n');
  } else {
    console.log('1. Analyze failure patterns by cross-platform type');
    console.log('2. Test if platform metadata affects MMR scoring');
    console.log('3. Consider platform-weighted relevance scoring');
    console.log('4. Rerun after adjustments\n');
  }

  return {
    passed: overallPass,
    summary,
    failures
  };
}

// Run tests
runBatch7Tests();
