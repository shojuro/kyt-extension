/**
 * Production MMR Test Suite - 50 Scenarios
 * 
 * Catastrophic Failure Prevention for "Lonely ICP" Memory Extension
 * Each scenario: 10-20 candidates, precision > recall standard
 */

import { applyMMR, MMR_PRESETS } from './src/mmr.js';

function createTestEmbedding(values) {
  const magnitude = Math.sqrt(values.reduce((sum, v) => sum + v * v, 0));
  return values.map(v => v / magnitude);
}

class TestMetrics {
  constructor() {
    this.totalTests = 0;
    this.catastrophicFailures = [];
    this.correctPrimaryEntity = 0;
    this.diversityImprovements = 0;
    this.falsePositives = 0;
  }

  recordScenario(scenarioNum, scenarioName, result) {
    this.totalTests++;
    if (result.catastrophicFailure) {
      this.catastrophicFailures.push({
        num: scenarioNum,
        name: scenarioName,
        expected: result.expectedPrimary,
        got: result.gotPrimary
      });
    }
    if (result.correctPrimaryEntity) this.correctPrimaryEntity++;
    if (result.diversityImprovement) this.diversityImprovements++;
    this.falsePositives += result.falsePositiveCount || 0;
  }

  getSummary() {
    return {
      totalTests: this.totalTests,
      catastrophicFailures: this.catastrophicFailures.length,
      entityPrecision: (this.correctPrimaryEntity / this.totalTests * 100).toFixed(1),
      diversityRate: (this.diversityImprovements / this.totalTests * 100).toFixed(1),
      falsePositiveRate: (this.falsePositives / (this.totalTests * 3) * 100).toFixed(1),
      passRate: this.catastrophicFailures.length === 0 && (this.correctPrimaryEntity / this.totalTests * 100) >= 95
    };
  }
}

function runTestScenario(num, name, candidates, query, expectedPrimary, expectedDiverse) {
  const withoutMMR = [...candidates].sort((a, b) => a.distance - b.distance).slice(0, 3);
  const uniqueWithout = new Set(withoutMMR.map(i => i.entity)).size;

  const withMMR = applyMMR(candidates, 3, MMR_PRESETS.PRECISION.lambda, {
    debugMode: false,
    enableEntityDeduplication: true
  });

  const uniqueWith = new Set(withMMR.map(i => i.entity)).size;
  const primaryReturned = withMMR[0].entity;

  const result = {
    catastrophicFailure: primaryReturned !== expectedPrimary,
    correctPrimaryEntity: primaryReturned === expectedPrimary,
    diversityImprovement: uniqueWith > uniqueWithout,
    falsePositiveCount: 0,
    expectedPrimary,
    gotPrimary: primaryReturned
  };

  const allExpected = new Set([expectedPrimary, ...expectedDiverse]);
  withMMR.forEach(item => {
    if (!allExpected.has(item.entity)) result.falsePositiveCount++;
  });

  return result;
}

const metrics = new TestMetrics();

console.log('\n╔═══════════════════════════════════════════════════════════════════╗');
console.log('║       PRODUCTION MMR TEST: 50 SCENARIOS, 10-20 CANDIDATES        ║');
console.log('╚═══════════════════════════════════════════════════════════════════╝\n');
console.log('Standard: Precision > Recall | Zero Catastrophic Failures\n');

console.log('Running 50 test scenarios...\n');

