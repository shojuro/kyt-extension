/**
 * KYT Deduplication - Cross-Platform Race Condition Test
 *
 * Tests concurrent message submission across ChatGPT and Claude tabs
 * to verify deduplication handles cross-platform collisions correctly.
 *
 * Run: node tests/playwright/race-condition.spec.js
 * Or: npx playwright test tests/playwright/race-condition.spec.js
 */

const { chromium } = require('playwright');

async function testCrossPlatformRaceCondition() {
  console.log('🧪 Starting Cross-Platform Race Condition Test...\n');

  const browser = await chromium.launch({ headless: false }); // Visible for debugging
  const context = await browser.newContext();

  try {
    // Open ChatGPT and Claude in separate tabs
    const chatgptPage = await context.newPage();
    const claudePage = await context.newPage();

    console.log('📂 Opening ChatGPT tab...');
    await chatgptPage.goto('https://chatgpt.com');

    console.log('📂 Opening Claude tab...');
    await claudePage.goto('https://claude.ai');

    // Wait for pages to load fully
    await chatgptPage.waitForLoadState('networkidle');
    await claudePage.waitForLoadState('networkidle');

    console.log('✅ Both pages loaded\n');

    // CRITICAL: Get selectors for message input and submit button
    // These will be detected by Playwright's accessibility tree
    // Use Playwright Codegen to find these if they fail: npx playwright codegen https://chatgpt.com

    const CHATGPT_INPUT_SELECTOR = 'textarea[placeholder*="Message"]'; // Adjust as needed
    const CHATGPT_SUBMIT_SELECTOR = 'button[data-testid="send-button"]'; // Adjust as needed

    const CLAUDE_INPUT_SELECTOR = 'div[contenteditable="true"]'; // Adjust as needed
    const CLAUDE_SUBMIT_SELECTOR = 'button[aria-label*="Send"]'; // Adjust as needed

    const testMessage = 'Cross-platform race condition test message';

    console.log('🔧 Test Setup:');
    console.log(`   Message: "${testMessage}"`);
    console.log(`   Target: Send to both platforms within <100ms\n`);

    // Type message in both tabs (sequential, but fast)
    console.log('⌨️  Typing message in ChatGPT...');
    await chatgptPage.fill(CHATGPT_INPUT_SELECTOR, testMessage);

    console.log('⌨️  Typing message in Claude...');
    await claudePage.fill(CLAUDE_INPUT_SELECTOR, testMessage);

    console.log('\n🚀 Executing simultaneous submit (Promise.all)...');
    const startTime = Date.now();

    // THE CRITICAL PART: Promise.all ensures <10ms delta
    await Promise.all([
      chatgptPage.click(CHATGPT_SUBMIT_SELECTOR),
      claudePage.click(CLAUDE_SUBMIT_SELECTOR)
    ]);

    const endTime = Date.now();
    const delta = endTime - startTime;

    console.log(`✅ Both submits executed in ${delta}ms\n`);

    // Wait for responses to appear
    console.log('⏳ Waiting for AI responses...');
    await Promise.all([
      chatgptPage.waitForTimeout(3000), // Wait for response
      claudePage.waitForTimeout(3000)
    ]);

    console.log('\n📊 Test Results:');
    console.log('   Next step: Check browser console logs in both tabs');
    console.log('   Expected: ONE capture log + ONE skip/duplicate log');
    console.log('   Database: Verify only 1 entry for this message\n');

    console.log('🔍 Instructions for Manual Verification:');
    console.log('   1. Open DevTools (F12) in both tabs');
    console.log('   2. Look for deduplication logs:');
    console.log('      ✅ Tab 1: "🟢 Message captured"');
    console.log('      ⏭️  Tab 2: "⏭️ Duplicate skipped"');
    console.log('   3. Check database for exactly 1 entry\n');

    // Keep browser open for inspection
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

async function testTemporalBoundary() {
  console.log('\n🧪 Starting Temporal Boundary Test (5-second window)...\n');

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();

  try {
    const page = await context.newPage();

    console.log('📂 Opening ChatGPT...');
    await page.goto('https://chatgpt.com');
    await page.waitForLoadState('networkidle');

    const INPUT_SELECTOR = 'textarea[placeholder*="Message"]';
    const SUBMIT_SELECTOR = 'button[data-testid="send-button"]';

    const testMessage = 'Temporal boundary test message';

    console.log('🔧 Test Setup:');
    console.log(`   Message: "${testMessage}"`);
    console.log(`   Plan: Send at T=0s and T=5.01s\n`);

    // Send first message at T=0
    console.log('⌨️  Sending first message (T=0s)...');
    await page.fill(INPUT_SELECTOR, testMessage);
    await page.click(SUBMIT_SELECTOR);

    const firstSendTime = Date.now();
    console.log(`✅ First message sent at ${new Date(firstSendTime).toISOString()}`);

    // Wait for response
    await page.waitForTimeout(3000);

    // Wait exactly 5010ms from first send
    const waitTime = 5010 - (Date.now() - firstSendTime);
    console.log(`⏳ Waiting ${waitTime}ms to reach T=5.01s...`);
    await page.waitForTimeout(waitTime);

    // Send second message at T=5.01s
    console.log('⌨️  Sending second message (T=5.01s)...');
    await page.fill(INPUT_SELECTOR, testMessage);
    await page.click(SUBMIT_SELECTOR);

    const secondSendTime = Date.now();
    const actualDelta = secondSendTime - firstSendTime;

    console.log(`✅ Second message sent at ${new Date(secondSendTime).toISOString()}`);
    console.log(`📊 Actual time delta: ${actualDelta}ms (target: 5010ms)\n`);

    console.log('📊 Expected Result:');
    console.log('   Second message should be CAPTURED (new entry)');
    console.log('   Console should show: "🟢 Message captured" (not skip)');
    console.log('   Database should have 2 separate entries\n');

    // Keep browser open for inspection
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

// Run both tests
(async () => {
  try {
    await testCrossPlatformRaceCondition();
    console.log('\n' + '='.repeat(60) + '\n');
    await testTemporalBoundary();
  } catch (error) {
    console.error('Fatal error:', error);
    process.exit(1);
  }
})();
