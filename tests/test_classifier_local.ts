#!/usr/bin/env -S deno run --allow-env --allow-net

/**
 * Local Memory Classifier Test
 * Tests the classification logic without requiring database deployment
 *
 * Usage: deno run --allow-env --allow-net tests/test_classifier_local.ts
 *
 * Prerequisites:
 * - OPENAI_API_KEY in environment or .env file
 * - Deno installed: curl -fsSL https://deno.land/install.sh | sh
 *
 * Date: 2025-11-24
 */

import { classifyMemory } from '../supabase/functions/_shared/memory-classifier.ts';

// Load environment variables from .env if available
try {
  const envFile = await Deno.readTextFile('.env');
  envFile.split('\n').forEach(line => {
    const [key, ...valueParts] = line.split('=');
    if (key && valueParts.length > 0) {
      const value = valueParts.join('=').trim();
      Deno.env.set(key.trim(), value);
    }
  });
  console.log('✅ Loaded environment variables from .env\n');
} catch {
  console.log('⚠️  No .env file found, using system environment variables\n');
}

const OPENAI_API_KEY = Deno.env.get('OPENAI_API_KEY');

if (!OPENAI_API_KEY) {
  console.error('❌ OPENAI_API_KEY not found in environment');
  console.error('   Set it with: export OPENAI_API_KEY=your_key_here');
  Deno.exit(1);
}

// Test cases covering different impact/intimacy levels
const testCases = [
  {
    name: 'High Impact, Deep Intimacy',
    data: {
      content: 'My mother passed away last week. I\'m still processing the grief and trying to figure out how to move forward.',
      speakers: ['User', 'Assistant'],
      topics: ['death', 'grief', 'loss', 'family']
    },
    expectedImpact: { min: 80, max: 100 },
    expectedIntimacy: { min: 2, max: 3 }
  },
  {
    name: 'Medium Impact, Personal Disclosure',
    data: {
      content: 'I got promoted at work today! I\'ve been working towards this for two years. I\'m excited but also nervous about the new responsibilities.',
      speakers: ['User', 'Assistant'],
      topics: ['career', 'promotion', 'achievement', 'personal growth']
    },
    expectedImpact: { min: 40, max: 70 },
    expectedIntimacy: { min: 1, max: 2 }
  },
  {
    name: 'Low Impact, Surface Conversation',
    data: {
      content: 'The weather is nice today. I might go for a walk later.',
      speakers: ['User', 'Assistant'],
      topics: ['weather', 'daily activities']
    },
    expectedImpact: { min: 0, max: 20 },
    expectedIntimacy: { min: 0, max: 1 }
  },
  {
    name: 'Very High Impact, Maximum Vulnerability',
    data: {
      content: 'I\'ve been struggling with suicidal thoughts. I feel completely alone and don\'t know who to talk to. I\'m scared.',
      speakers: ['User', 'Assistant'],
      topics: ['mental health', 'crisis', 'vulnerability', 'depression']
    },
    expectedImpact: { min: 95, max: 100 },
    expectedIntimacy: { min: 3, max: 3 }
  },
  {
    name: 'Medium Impact, Moderate Intimacy',
    data: {
      content: 'I\'m thinking about moving to a new city for a job opportunity. It\'s exciting but I\'m worried about leaving my friends and starting over.',
      speakers: ['User', 'Assistant'],
      topics: ['relocation', 'career decision', 'relationships', 'change']
    },
    expectedImpact: { min: 40, max: 60 },
    expectedIntimacy: { min: 1, max: 2 }
  },
  {
    name: 'Technical/Factual Query',
    data: {
      content: 'What\'s the capital of France?',
      speakers: ['User', 'Assistant'],
      topics: ['geography', 'factual question']
    },
    expectedImpact: { min: 0, max: 10 },
    expectedIntimacy: { min: 0, max: 0 }
  }
];

console.log('╔════════════════════════════════════════════════════════════╗');
console.log('║  MEMORY CLASSIFIER LOCAL TEST SUITE                       ║');
console.log('╚════════════════════════════════════════════════════════════╝\n');

let passed = 0;
let failed = 0;
let total = testCases.length;

for (const testCase of testCases) {
  console.log(`\n📋 Test: ${testCase.name}`);
  console.log(`   Content: "${testCase.data.content.substring(0, 60)}..."`);

  try {
    const result = await classifyMemory(testCase.data, OPENAI_API_KEY);

    console.log(`   Impact Score: ${result.impact_score} (expected ${testCase.expectedImpact.min}-${testCase.expectedImpact.max})`);
    console.log(`   Intimacy Level: ${result.intimacy_level} (expected ${testCase.expectedIntimacy.min}-${testCase.expectedIntimacy.max})`);
    console.log(`   Reasoning: ${result.reasoning.substring(0, 80)}...`);

    // Validate impact score range
    const impactValid = result.impact_score >= testCase.expectedImpact.min &&
                       result.impact_score <= testCase.expectedImpact.max;

    // Validate intimacy level range
    const intimacyValid = result.intimacy_level >= testCase.expectedIntimacy.min &&
                         result.intimacy_level <= testCase.expectedIntimacy.max;

    if (impactValid && intimacyValid) {
      console.log('   ✅ PASSED');
      passed++;
    } else {
      console.log('   ❌ FAILED');
      if (!impactValid) {
        console.log(`      Impact score ${result.impact_score} outside expected range [${testCase.expectedImpact.min}, ${testCase.expectedImpact.max}]`);
      }
      if (!intimacyValid) {
        console.log(`      Intimacy level ${result.intimacy_level} outside expected range [${testCase.expectedIntimacy.min}, ${testCase.expectedIntimacy.max}]`);
      }
      failed++;
    }

  } catch (error) {
    console.log(`   ❌ ERROR: ${error.message}`);
    failed++;
  }

  // Rate limit: wait 1 second between API calls
  if (testCases.indexOf(testCase) < testCases.length - 1) {
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}

console.log('\n╔════════════════════════════════════════════════════════════╗');
console.log('║  TEST RESULTS                                              ║');
console.log('╚════════════════════════════════════════════════════════════╝\n');

console.log(`Total Tests: ${total}`);
console.log(`✅ Passed: ${passed}`);
console.log(`❌ Failed: ${failed}`);
console.log(`Success Rate: ${((passed / total) * 100).toFixed(1)}%\n`);

if (failed === 0) {
  console.log('🎉 All tests passed! The memory classifier is working correctly.\n');
  console.log('Next steps:');
  console.log('  1. Deploy database schema (see DEPLOYMENT_GUIDE.md)');
  console.log('  2. Deploy Edge Functions');
  console.log('  3. Run end-to-end integration tests\n');
  Deno.exit(0);
} else {
  console.log('⚠️  Some tests failed. Review the classifier prompt or expected ranges.\n');
  Deno.exit(1);
}
