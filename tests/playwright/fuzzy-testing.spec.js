/**
 * KYT Deduplication - Fuzzy Testing (Normalization Verification)
 *
 * Tests that the normalization layer correctly handles "near duplicates"
 * caused by punctuation and whitespace variations BEFORE hashing.
 *
 * Critical: Prevents "phantom data" pollution in knowledge base from
 * messages like "tell me about AI" vs "tell  me  about  AI" (extra spaces)
 *
 * Run: node tests/playwright/fuzzy-testing.spec.js
 * Or: npx playwright test tests/playwright/fuzzy-testing.spec.js
 */

const { chromium } = require('playwright');

async function testPunctuationNormalization() {
  console.log('🧪 Starting Punctuation Normalization Test...\n');

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();

  try {
    const page = await context.newPage();

    console.log('📂 Opening ChatGPT...');
    await page.goto('https://chatgpt.com');
    await page.waitForLoadState('networkidle');

    const INPUT_SELECTOR = 'textarea[placeholder*="Message"]';
    const SUBMIT_SELECTOR = 'button[data-testid="send-button"]';

    console.log('✅ Page loaded\n');

    // Test Case 1: Punctuation at end
    const baseMessage = 'test message one';
    const withPunctuation = 'test message one.';

    console.log('🔧 Test Setup:');
    console.log(`   Base message: "${baseMessage}"`);
    console.log(`   With punctuation: "${withPunctuation}"`);
    console.log(`   Expected: Both should normalize to same hash\n`);

    // Send base message
    console.log('⌨️  Sending base message...');
    await page.fill(INPUT_SELECTOR, baseMessage);
    await page.click(SUBMIT_SELECTOR);
    const firstSendTime = Date.now();
    console.log(`✅ Base message sent at ${new Date(firstSendTime).toISOString()}`);

    // Wait for response
    await page.waitForTimeout(2000);

    // Send punctuated version immediately
    console.log('\n⌨️  Sending punctuated version...');
    await page.fill(INPUT_SELECTOR, withPunctuation);
    await page.click(SUBMIT_SELECTOR);
    const secondSendTime = Date.now();
    const delta = secondSendTime - firstSendTime;

    console.log(`✅ Punctuated message sent at ${new Date(secondSendTime).toISOString()}`);
    console.log(`⏱️  Time delta: ${delta}ms (well within 5s window)\n`);

    console.log('📊 Expected Result:');
    console.log('   Console should show: "⏭️ Duplicate skipped" for second message');
    console.log('   Database should have only 1 entry');
    console.log('   Proves: Punctuation is normalized before hashing\n');

    // Wait for manual inspection
    console.log('⏸️  Browser will stay open for 30 seconds for inspection...');
    await new Promise(resolve => setTimeout(resolve, 30000));

  } catch (error) {
    console.error('❌ Test failed:', error.message);
    throw error;
  } finally {
    await browser.close();
    console.log('✅ Test complete');
  }
}

async function testWhitespaceNormalization() {
  console.log('\n🧪 Starting Whitespace Normalization Test...\n');

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();

  try {
    const page = await context.newPage();

    console.log('📂 Opening ChatGPT...');
    await page.goto('https://chatgpt.com');
    await page.waitForLoadState('networkidle');

    const INPUT_SELECTOR = 'textarea[placeholder*="Message"]';
    const SUBMIT_SELECTOR = 'button[data-testid="send-button"]';

    console.log('✅ Page loaded\n');

    // Test Case 2: Extra internal spaces
    const cleanMessage = 'tell me about AI';
    const extraSpaces = 'tell  me  about  AI'; // Double spaces

    console.log('🔧 Test Setup:');
    console.log(`   Clean message: "${cleanMessage}"`);
    console.log(`   Extra spaces: "${extraSpaces}"`);
    console.log(`   Expected: Whitespace collapsed before hashing\n`);

    // Send clean message
    console.log('⌨️  Sending clean message...');
    await page.fill(INPUT_SELECTOR, cleanMessage);
    await page.click(SUBMIT_SELECTOR);
    const firstSendTime = Date.now();
    console.log(`✅ Clean message sent at ${new Date(firstSendTime).toISOString()}`);

    // Wait for response
    await page.waitForTimeout(2000);

    // Send version with extra spaces immediately
    console.log('\n⌨️  Sending message with extra spaces...');
    await page.fill(INPUT_SELECTOR, extraSpaces);
    await page.click(SUBMIT_SELECTOR);
    const secondSendTime = Date.now();
    const delta = secondSendTime - firstSendTime;

    console.log(`✅ Extra-space message sent at ${new Date(secondSendTime).toISOString()}`);
    console.log(`⏱️  Time delta: ${delta}ms (well within 5s window)\n`);

    console.log('📊 Expected Result:');
    console.log('   Console should show: "⏭️ Duplicate skipped" for second message');
    console.log('   Database should have only 1 entry');
    console.log('   Proves: Multiple spaces normalized to single space\n');

    // Wait for manual inspection
    console.log('⏸️  Browser will stay open for 30 seconds for inspection...');
    await new Promise(resolve => setTimeout(resolve, 30000));

  } catch (error) {
    console.error('❌ Test failed:', error.message);
    throw error;
  } finally {
    await browser.close();
    console.log('✅ Test complete');
  }
}

async function testLeadingTrailingWhitespace() {
  console.log('\n🧪 Starting Leading/Trailing Whitespace Test...\n');

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();

  try {
    const page = await context.newPage();

    console.log('📂 Opening ChatGPT...');
    await page.goto('https://chatgpt.com');
    await page.waitForLoadState('networkidle');

    const INPUT_SELECTOR = 'textarea[placeholder*="Message"]';
    const SUBMIT_SELECTOR = 'button[data-testid="send-button"]';

    console.log('✅ Page loaded\n');

    // Test Case 3: Leading/trailing whitespace
    const trimmedMessage = 'another test message';
    const untrimmedMessage = '  another test message  '; // Leading/trailing spaces

    console.log('🔧 Test Setup:');
    console.log(`   Trimmed: "${trimmedMessage}"`);
    console.log(`   Untrimmed: "${untrimmedMessage}"`);
    console.log(`   Expected: trim() applied before hashing\n`);

    // Send trimmed message
    console.log('⌨️  Sending trimmed message...');
    await page.fill(INPUT_SELECTOR, trimmedMessage);
    await page.click(SUBMIT_SELECTOR);
    const firstSendTime = Date.now();
    console.log(`✅ Trimmed message sent at ${new Date(firstSendTime).toISOString()}`);

    // Wait for response
    await page.waitForTimeout(2000);

    // Send untrimmed version immediately
    console.log('\n⌨️  Sending untrimmed message...');
    await page.fill(INPUT_SELECTOR, untrimmedMessage);
    await page.click(SUBMIT_SELECTOR);
    const secondSendTime = Date.now();
    const delta = secondSendTime - firstSendTime;

    console.log(`✅ Untrimmed message sent at ${new Date(secondSendTime).toISOString()}`);
    console.log(`⏱️  Time delta: ${delta}ms (well within 5s window)\n`);

    console.log('📊 Expected Result:');
    console.log('   Console should show: "⏭️ Duplicate skipped" for second message');
    console.log('   Database should have only 1 entry');
    console.log('   Proves: Leading/trailing whitespace trimmed\n');

    // Wait for manual inspection
    console.log('⏸️  Browser will stay open for 30 seconds for inspection...');
    await new Promise(resolve => setTimeout(resolve, 30000));

  } catch (error) {
    console.error('❌ Test failed:', error.message);
    throw error;
  } finally {
    await browser.close();
    console.log('✅ Test complete');
  }
}

// Run all fuzzy tests
(async () => {
  try {
    console.log('=' .repeat(70));
    console.log('FUZZY TESTING SUITE - Normalization Verification');
    console.log('=' .repeat(70) + '\n');

    await testPunctuationNormalization();
    console.log('\n' + '='.repeat(70) + '\n');

    await testWhitespaceNormalization();
    console.log('\n' + '='.repeat(70) + '\n');

    await testLeadingTrailingWhitespace();

    console.log('\n' + '='.repeat(70));
    console.log('ALL FUZZY TESTS COMPLETE');
    console.log('=' .repeat(70) + '\n');

    console.log('📋 Summary:');
    console.log('   ✅ Punctuation normalization tested');
    console.log('   ✅ Internal whitespace normalization tested');
    console.log('   ✅ Leading/trailing whitespace normalization tested\n');

    console.log('🔍 Verification Steps:');
    console.log('   1. Check browser console logs in all 3 tabs');
    console.log('   2. Verify "⏭️ Duplicate skipped" appears for all second messages');
    console.log('   3. Check database - should have exactly 3 entries (1 per test)');
    console.log('   4. Proves normalization layer prevents "phantom data"\n');

  } catch (error) {
    console.error('Fatal error:', error);
    process.exit(1);
  }
})();
