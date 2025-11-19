/**
 * Phase 2.5: Diagnostic Popup Test
 * 
 * Tests the diagnostic popup on ChatGPT to identify if there's a bypass issue
 * 
 * Expected behavior:
 * - Popup should show fetch/WebSocket/DOM observer status
 * - If ChatGPT is being bypassed, popup will show inactive status
 * - This test will expose the bypass for manual investigation
 */

import { test, expect, chromium } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Path to extension directory
const extensionPath = path.join(__dirname, '..');

test.describe('Phase 2.5: ChatGPT Diagnostic Test', () => {
  let browser;
  let extensionId;

  test.beforeEach(async () => {
    console.log('🧪 Loading extension for ChatGPT diagnostic test...');
    
    // Launch Chrome with extension
    browser = await chromium.launchPersistentContext('', {
      headless: false,
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
        '--no-sandbox',
        '--disable-dev-shm-usage'
      ]
    });

    // Wait for extension to load
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Get extension ID
    const backgroundPage = browser.backgroundPages()[0];
    if (backgroundPage) {
      extensionId = backgroundPage.url().split('/')[2];
      console.log(`✅ Extension loaded: ${extensionId}`);
    }
  });

  test.afterEach(async () => {
    if (browser) {
      await browser.close();
    }
  });

  test('Test 1: Open diagnostic popup and check status', async () => {
    console.log('\n📋 Test 1: Diagnostic Popup Status');
    console.log('──────────────────────────────────');

    // Navigate to ChatGPT
    const page = await browser.newPage();
    await page.goto('https://chatgpt.com');
    
    // Wait for page to load
    await page.waitForLoadState('domcontentloaded');
    console.log('   ✅ ChatGPT page loaded');

    // Wait a bit for extension to inject
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Open popup in new page
    const popupPage = await browser.newPage();
    await popupPage.goto(`chrome-extension://${extensionId}/popup/popup.html`);

    // Wait for popup to load stats
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Check fetch status
    const fetchStatus = await popupPage.locator('#fetchStatus').textContent();
    const websocketStatus = await popupPage.locator('#websocketStatus').textContent();
    const domStatus = await popupPage.locator('#domStatus').textContent();

    console.log('   Interception Status:');
    console.log(`     Fetch:     ${fetchStatus}`);
    console.log(`     WebSocket: ${websocketStatus}`);
    console.log(`     DOM:       ${domStatus}`);

    // Check message counts
    const totalMessages = await popupPage.locator('#totalMessages').textContent();
    const sessionMessages = await popupPage.locator('#sessionMessages').textContent();

    console.log('   Message Counts:');
    console.log(`     Total:   ${totalMessages}`);
    console.log(`     Session: ${sessionMessages}`);

    // Analyze results
    const isActive = fetchStatus.includes('Active') || 
                    websocketStatus.includes('Active') || 
                    domStatus.includes('Active');

    if (isActive) {
      console.log('\n   ✅ ChatGPT interception is ACTIVE');
      console.log('   ℹ️  No bypass detected');
    } else {
      console.log('\n   ⚠️  ChatGPT interception is INACTIVE');
      console.log('   ⚠️  BYPASS DETECTED - unified pipeline may not be working');
      console.log('   → Proceed to Phase 2.5 fix');
    }

    // Take screenshot for manual review
    await popupPage.screenshot({ 
      path: 'validation/diagnostic_popup_screenshot.png',
      fullPage: true 
    });
    console.log('   📸 Screenshot saved: validation/diagnostic_popup_screenshot.png');
  });

  test('Test 2: Send test message and verify capture', async () => {
    console.log('\n📋 Test 2: Test Message Capture');
    console.log('────────────────────────────────');

    // Navigate to ChatGPT
    const page = await browser.newPage();
    await page.goto('https://chatgpt.com');
    await page.waitForLoadState('domcontentloaded');

    // Wait for ChatGPT to fully load
    await new Promise(resolve => setTimeout(resolve, 5000));

    // Get initial message count
    const backgroundPage = browser.backgroundPages()[0];
    const initialCount = await backgroundPage.evaluate(async () => {
      const result = await chrome.storage.local.get(['captured_messages']);
      return (result.captured_messages || []).length;
    });

    console.log(`   Initial message count: ${initialCount}`);

    // Try to send a test message (this may require manual interaction)
    console.log('   ℹ️  Note: Automated message sending to ChatGPT requires authentication');
    console.log('   ℹ️  This test validates the popup shows correct status');
    console.log('   ℹ️  For full E2E validation, manually send a message and check storage');

    // Open popup to check status
    const popupPage = await browser.newPage();
    await popupPage.goto(`chrome-extension://${extensionId}/popup/popup.html`);
    await new Promise(resolve => setTimeout(resolve, 2000));

    const platform = await popupPage.locator('#platform').textContent();
    console.log(`   Detected platform: ${platform}`);

    if (platform.includes('ChatGPT') || platform.includes('chatgpt')) {
      console.log('   ✅ Platform detection working');
    } else {
      console.log('   ⚠️  Platform not detected - may need to be on chatgpt.com');
    }
  });
});

test.describe('Phase 2.5: Summary', () => {
  test('Print diagnostic results', async () => {
    console.log('\n\n📊 Phase 2.5 Diagnostic Summary');
    console.log('═══════════════════════════════');
    console.log('🔍 Check the diagnostic popup screenshot');
    console.log('🔍 Review console output above for bypass detection');
    console.log('');
    console.log('Next steps:');
    console.log('1. If bypass detected → Fix unified pipeline in inject.js');
    console.log('2. If active → Skip to Phase 3 (BM25 + semantic hybrid)');
    console.log('');
    console.log('Screenshot location: validation/diagnostic_popup_screenshot.png');
  });
});
