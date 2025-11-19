/**
 * KYT Deduplication - Priority Inversion Testing
 *
 * Tests that high-confidence captures (Fetch 95%) CANNOT be downgraded
 * by subsequent low-confidence captures (DOM 70%) for the same message.
 *
 * Critical: Prevents data quality corruption where delayed, low-quality
 * captures overwrite high-quality data.
 *
 * Run: node tests/playwright/priority-inversion.spec.js
 * Or: npx playwright test tests/playwright/priority-inversion.spec.js
 */

const { chromium } = require('playwright');

async function testHighToLowRejection() {
  console.log('🧪 Starting High-to-Low Confidence Rejection Test...\n');

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();

  try {
    const page = await context.newPage();

    console.log('📂 Opening ChatGPT...');
    await page.goto('https://chatgpt.com');
    await page.waitForLoadState('networkidle');

    console.log('✅ Page loaded\n');

    const testMessage = 'priority inversion test message';

    console.log('🔧 Test Setup:');
    console.log(`   Message: "${testMessage}"`);
    console.log(`   Step 1: Simulate HIGH confidence (Fetch 95%) capture`);
    console.log(`   Step 2: Simulate LOW confidence (DOM 70%) capture`);
    console.log(`   Expected: Step 2 should be REJECTED (skip log)\n`);

    // Step 1: Simulate high-confidence capture by directly calling deduplicator
    console.log('⚡ Simulating HIGH confidence (Fetch 95%) capture...');

    const highConfidenceResult = await page.evaluate((msg) => {
      if (!window.KYT_Deduplicator) {
        throw new Error('KYT_Deduplicator not found - extension not loaded');
      }

      // Capture with high confidence (Fetch method)
      const shouldCapture = window.KYT_Deduplicator.shouldCapture(msg, 'fetch');

      return {
        shouldCapture,
        stats: window.KYT_Deduplicator.getStats()
      };
    }, testMessage);

    if (!highConfidenceResult.shouldCapture) {
      throw new Error('❌ HIGH confidence capture was rejected (should be captured)');
    }

    console.log('✅ HIGH confidence capture ACCEPTED (as expected)');
    console.log(`   Stats: ${JSON.stringify(highConfidenceResult.stats, null, 2)}\n`);

    // Small delay to ensure the entry is recorded
    await page.waitForTimeout(100);

    // Step 2: Attempt low-confidence capture (should be rejected)
    console.log('⚡ Attempting LOW confidence (DOM 70%) capture...');

    const lowConfidenceResult = await page.evaluate((msg) => {
      // Attempt capture with low confidence (DOM method)
      const shouldCapture = window.KYT_Deduplicator.shouldCapture(msg, 'dom');

      return {
        shouldCapture,
        stats: window.KYT_Deduplicator.getStats()
      };
    }, testMessage);

    console.log(`📊 LOW confidence capture result: ${lowConfidenceResult.shouldCapture ? 'ACCEPTED' : 'REJECTED'}`);
    console.log(`   Stats: ${JSON.stringify(lowConfidenceResult.stats, null, 2)}\n`);

    // Verify the low-confidence capture was rejected
    if (lowConfidenceResult.shouldCapture) {
      throw new Error('❌ CRITICAL: LOW confidence capture was ACCEPTED - priority inversion occurred!');
    }

    console.log('✅ PASS: LOW confidence capture was REJECTED');
    console.log('✅ PASS: HIGH confidence data protected from downgrade\n');

    console.log('📊 Verification:');
    console.log('   ✅ Confidence-based rejection working correctly');
    console.log('   ✅ High-quality data cannot be corrupted by low-quality data');
    console.log('   ✅ Database integrity maintained\n');

    // Keep browser open for inspection
    console.log('⏸️  Browser will stay open for 20 seconds for inspection...');
    await new Promise(resolve => setTimeout(resolve, 20000));

  } catch (error) {
    console.error('❌ Test failed:', error.message);
    throw error;
  } finally {
    await browser.close();
    console.log('✅ Test complete');
  }
}

async function testLowToHighUpgrade() {
  console.log('\n🧪 Starting Low-to-High Confidence Upgrade Test...\n');

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();

  try {
    const page = await context.newPage();

    console.log('📂 Opening ChatGPT...');
    await page.goto('https://chatgpt.com');
    await page.waitForLoadState('networkidle');

    console.log('✅ Page loaded\n');

    const testMessage = 'upgrade test message';

    console.log('🔧 Test Setup:');
    console.log(`   Message: "${testMessage}"`);
    console.log(`   Step 1: Simulate LOW confidence (DOM 70%) capture`);
    console.log(`   Step 2: Simulate HIGH confidence (Fetch 95%) upgrade`);
    console.log(`   Expected: Step 2 should UPGRADE (replace low with high)\n`);

    // Step 1: Simulate low-confidence capture
    console.log('⚡ Simulating LOW confidence (DOM 70%) capture...');

    const lowConfidenceResult = await page.evaluate((msg) => {
      if (!window.KYT_Deduplicator) {
        throw new Error('KYT_Deduplicator not found - extension not loaded');
      }

      const shouldCapture = window.KYT_Deduplicator.shouldCapture(msg, 'dom');

      return {
        shouldCapture,
        stats: window.KYT_Deduplicator.getStats()
      };
    }, testMessage);

    if (!lowConfidenceResult.shouldCapture) {
      throw new Error('❌ LOW confidence capture was rejected (should be captured)');
    }

    console.log('✅ LOW confidence capture ACCEPTED (as expected)');
    console.log(`   Stats: ${JSON.stringify(lowConfidenceResult.stats, null, 2)}\n`);

    await page.waitForTimeout(100);

    // Step 2: Attempt high-confidence upgrade (should be accepted)
    console.log('⚡ Attempting HIGH confidence (Fetch 95%) upgrade...');

    const highConfidenceResult = await page.evaluate((msg) => {
      const shouldCapture = window.KYT_Deduplicator.shouldCapture(msg, 'fetch');

      return {
        shouldCapture,
        stats: window.KYT_Deduplicator.getStats()
      };
    }, testMessage);

    console.log(`📊 HIGH confidence upgrade result: ${highConfidenceResult.shouldCapture ? 'ACCEPTED (upgraded)' : 'REJECTED'}`);
    console.log(`   Stats: ${JSON.stringify(highConfidenceResult.stats, null, 2)}\n`);

    // Verify the high-confidence upgrade was accepted
    if (!highConfidenceResult.shouldCapture) {
      throw new Error('❌ CRITICAL: HIGH confidence upgrade was REJECTED - upgrade mechanism broken!');
    }

    console.log('✅ PASS: HIGH confidence upgrade was ACCEPTED');
    console.log('✅ PASS: Data quality improved (DOM → Fetch)\n');

    console.log('📊 Verification:');
    console.log('   ✅ Upgrade mechanism working correctly');
    console.log('   ✅ Low-quality data can be replaced by high-quality data');
    console.log('   ✅ Console should show "🔄 Upgrade capture" log\n');

    // Keep browser open for inspection
    console.log('⏸️  Browser will stay open for 20 seconds for inspection...');
    await new Promise(resolve => setTimeout(resolve, 20000));

  } catch (error) {
    console.error('❌ Test failed:', error.message);
    throw error;
  } finally {
    await browser.close();
    console.log('✅ Test complete');
  }
}

async function testSameConfidenceRejection() {
  console.log('\n🧪 Starting Same-Confidence Rejection Test...\n');

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();

  try {
    const page = await context.newPage();

    console.log('📂 Opening ChatGPT...');
    await page.goto('https://chatgpt.com');
    await page.waitForLoadState('networkidle');

    console.log('✅ Page loaded\n');

    const testMessage = 'same confidence test message';

    console.log('🔧 Test Setup:');
    console.log(`   Message: "${testMessage}"`);
    console.log(`   Step 1: Capture with Fetch (95%)`);
    console.log(`   Step 2: Re-capture with WebSocket (95%)`);
    console.log(`   Expected: Step 2 should be REJECTED (duplicate)\n`);

    // Step 1: Fetch capture
    console.log('⚡ Simulating first Fetch (95%) capture...');

    const firstResult = await page.evaluate((msg) => {
      if (!window.KYT_Deduplicator) {
        throw new Error('KYT_Deduplicator not found');
      }

      const shouldCapture = window.KYT_Deduplicator.shouldCapture(msg, 'fetch');
      return {
        shouldCapture,
        stats: window.KYT_Deduplicator.getStats()
      };
    }, testMessage);

    if (!firstResult.shouldCapture) {
      throw new Error('❌ First capture was rejected');
    }

    console.log('✅ First Fetch capture ACCEPTED');
    console.log(`   Stats: ${JSON.stringify(firstResult.stats, null, 2)}\n`);

    await page.waitForTimeout(100);

    // Step 2: WebSocket capture (same confidence)
    console.log('⚡ Attempting second WebSocket (95%) capture...');

    const secondResult = await page.evaluate((msg) => {
      const shouldCapture = window.KYT_Deduplicator.shouldCapture(msg, 'websocket');
      return {
        shouldCapture,
        stats: window.KYT_Deduplicator.getStats()
      };
    }, testMessage);

    console.log(`📊 Second capture result: ${secondResult.shouldCapture ? 'ACCEPTED' : 'REJECTED'}`);
    console.log(`   Stats: ${JSON.stringify(secondResult.stats, null, 2)}\n`);

    if (secondResult.shouldCapture) {
      throw new Error('❌ CRITICAL: Same-confidence duplicate was ACCEPTED');
    }

    console.log('✅ PASS: Same-confidence duplicate was REJECTED');
    console.log('✅ PASS: Console should show "⏭️ Duplicate skipped"\n');

    // Keep browser open for inspection
    console.log('⏸️  Browser will stay open for 20 seconds for inspection...');
    await new Promise(resolve => setTimeout(resolve, 20000));

  } catch (error) {
    console.error('❌ Test failed:', error.message);
    throw error;
  } finally {
    await browser.close();
    console.log('✅ Test complete');
  }
}

// Run all priority tests
(async () => {
  try {
    console.log('='.repeat(70));
    console.log('PRIORITY INVERSION TESTING SUITE - Data Quality Protection');
    console.log('='.repeat(70) + '\n');

    await testHighToLowRejection();
    console.log('\n' + '='.repeat(70) + '\n');

    await testLowToHighUpgrade();
    console.log('\n' + '='.repeat(70) + '\n');

    await testSameConfidenceRejection();

    console.log('\n' + '='.repeat(70));
    console.log('ALL PRIORITY INVERSION TESTS COMPLETE');
    console.log('='.repeat(70) + '\n');

    console.log('📋 Summary:');
    console.log('   ✅ High→Low rejection tested (data protection)');
    console.log('   ✅ Low→High upgrade tested (quality improvement)');
    console.log('   ✅ Same-confidence rejection tested (no duplicates)\n');

    console.log('🔍 Verification:');
    console.log('   ✅ High-quality data protected from corruption');
    console.log('   ✅ Low-quality data can be upgraded');
    console.log('   ✅ Same-confidence duplicates correctly rejected');
    console.log('   ✅ Database maintains data quality integrity\n');

  } catch (error) {
    console.error('Fatal error:', error);
    process.exit(1);
  }
})();
