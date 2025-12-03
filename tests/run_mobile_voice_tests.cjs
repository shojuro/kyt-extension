#!/usr/bin/env node
/**
 * Automated Mobile Voice Capture Test Runner
 *
 * Uses Playwright to load the extension and execute validation tests.
 * This script automates what was previously manual browser console testing.
 *
 * Usage:
 *   node tests/run_mobile_voice_tests.js
 *   npm run test:mobile-voice
 *
 * Requirements:
 *   - Playwright installed (npm install playwright)
 *   - Chrome/Chromium browser
 *   - Extension built and ready in current directory
 */

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

// ANSI color codes for terminal output
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m'
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function logSection(title) {
  console.log('\n' + '='.repeat(60));
  log(title, 'bright');
  console.log('='.repeat(60));
}

async function runTests() {
  logSection('🚀 Mobile Voice Capture - Automated Test Suite');

  const extensionPath = path.resolve(__dirname, '..');
  const testScriptPath = path.join(__dirname, '../scripts/test_mobile_voice_capture.js');

  // Verify extension files exist
  log('\n📂 Verifying extension files...', 'cyan');
  const requiredFiles = [
    'manifest.json',
    'background.js',
    'platforms/chatgpt/content.js',
    'platforms/chatgpt/dom-observer.js'
  ];

  for (const file of requiredFiles) {
    const filePath = path.join(extensionPath, file);
    if (!fs.existsSync(filePath)) {
      log(`❌ Missing required file: ${file}`, 'red');
      process.exit(1);
    }
    log(`  ✓ ${file}`, 'green');
  }

  // Verify test script exists
  if (!fs.existsSync(testScriptPath)) {
    log(`❌ Test script not found: ${testScriptPath}`, 'red');
    process.exit(1);
  }
  log(`  ✓ test_mobile_voice_capture.js`, 'green');

  log('\n🌐 Launching Chrome with extension...', 'cyan');

  let browser, context, page;

  try {
    // Launch browser with extension loaded
    // Note: Extensions require persistent context (user data dir)
    const userDataDir = path.join(__dirname, '../.test-profile');

    context = await chromium.launchPersistentContext(userDataDir, {
      headless: false, // Extensions don't work in headless mode
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
        '--no-sandbox',
        '--disable-setuid-sandbox'
      ],
      viewport: { width: 1280, height: 720 }
    });

    log('  ✓ Browser launched with extension', 'green');

    // Create new page
    page = await context.newPage();
    log('  ✓ New page created', 'green');

    // Navigate to ChatGPT
    log('\n🔗 Navigating to ChatGPT...', 'cyan');
    await page.goto('https://chatgpt.com', {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });
    log('  ✓ ChatGPT loaded', 'green');

    // Check for CAPTCHA or login requirement and wait for chat interface
    log('\n🔐 Checking authentication status...', 'cyan');
    await page.waitForTimeout(2000);
    
    // Check up to 6 times (120 seconds total) for chat interface
    let attempts = 0;
    let chatReady = false;
    
    while (attempts < 6 && !chatReady) {
      const status = await page.evaluate(() => {
        // Check for CAPTCHA/challenge
        const hasCaptcha = document.querySelector('iframe[src*="captcha"]') || 
                          document.querySelector('[class*="captcha"]') ||
                          document.querySelector('[id*="captcha"]') ||
                          document.querySelector('[class*="challenge"]') ||
                          document.body.textContent.includes('Verify you are human') ||
                          document.body.textContent.includes('Just a moment');
        
        // Check for login/auth pages
        const needsLogin = window.location.pathname.includes('/auth/') ||
                          Array.from(document.querySelectorAll('button')).some(btn => 
                            btn.textContent.includes('Log in') || btn.textContent.includes('Sign up')
                          );
        
        // Check for actual chat interface
        const chatTextarea = document.querySelector('textarea[placeholder*="Message"]') ||
                            document.querySelector('textarea[data-id*="prompt"]') ||
                            document.querySelector('#prompt-textarea');
        
        const chatMain = document.querySelector('main') || 
                        document.querySelector('[role="main"]');
        
        return {
          hasCaptcha,
          needsLogin,
          hasChatInterface: !!(chatTextarea && chatMain),
          currentPath: window.location.pathname,
          bodyText: document.body.textContent.substring(0, 200)
        };
      });
      
      if (status.hasChatInterface && !status.hasCaptcha && !status.needsLogin) {
        chatReady = true;
        log('  ✓ Chat interface ready', 'green');
        break;
      }
      
      // Need manual intervention
      if (attempts === 0) {
        log('', 'reset');
        if (status.hasCaptcha) {
          log('⚠️  CAPTCHA/Challenge detected!', 'yellow');
        } else if (status.needsLogin) {
          log('⚠️  Login required!', 'yellow');
        } else {
          log('⚠️  Chat interface not ready (page: ' + status.currentPath + ')', 'yellow');
        }
        log('', 'reset');
        log('📋 Action Required:', 'bright');
        log('  1. Solve any CAPTCHA in the browser window', 'cyan');
        log('  2. Log in to ChatGPT if prompted', 'cyan');
        log('  3. Wait for chat interface to load', 'cyan');
        log('  4. Tests will check again every 20 seconds (6 attempts, 2 minutes total)', 'cyan');
        log('', 'reset');
        
        // Take screenshot to debug what's on screen
        try {
          const screenshotPath = path.join(__dirname, '../test-results/captcha-screen.png');
          await page.screenshot({ path: screenshotPath, fullPage: false });
          log(`📸 Screenshot saved to: ${screenshotPath}`, 'cyan');
          log('   You can view this to see what the browser is showing', 'cyan');
          log('', 'reset');
        } catch (e) {
          log(`⚠️  Could not save screenshot: ${e.message}`, 'yellow');
        }
      }
      
      log(`⏳ Waiting 20 seconds (attempt ${attempts + 1}/6)...`, 'yellow');
      await page.waitForTimeout(20000);
      attempts++;
    }
    
    if (!chatReady) {
      log('', 'reset');
      log('⏸️  Automated wait expired. Browser will stay open for manual login.', 'yellow');
      log('', 'reset');
      log('📋 Next Steps:', 'bright');
      log('  1. Find the Chrome window (check taskbar/alt-tab)', 'cyan');
      log('  2. Click "Log in" button and complete login', 'cyan');
      log('  3. Once logged in, press ENTER in this terminal to continue', 'cyan');
      log('  4. Or press Ctrl+C to cancel tests', 'cyan');
      log('', 'reset');
      
      // Wait for user to press Enter
      const readline = require('readline');
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
      });
      
      await new Promise((resolve) => {
        rl.question('Press ENTER when logged in to continue tests...', () => {
          rl.close();
          resolve();
        });
      });
      
      log('\n✓ Continuing...', 'green');
      
      // Verify chat interface is now ready
      const finalCheck = await page.evaluate(() => {
        const chatTextarea = document.querySelector('textarea[placeholder*="Message"]') ||
                            document.querySelector('textarea[data-id*="prompt"]') ||
                            document.querySelector('#prompt-textarea');
        const chatMain = document.querySelector('main') || document.querySelector('[role="main"]');
        return !!(chatTextarea && chatMain);
      });
      
      if (!finalCheck) {
        throw new Error('Chat interface still not ready. Please ensure you are logged in and on chat.openai.com or chatgpt.com');
      }
      
      log('  ✓ Chat interface confirmed ready', 'green');
    }

    // Wait for extension to initialize
    log('\n⏳ Waiting for extension to initialize...', 'cyan');
    await page.waitForTimeout(3000);

    // Inject test script (bypass CSP by using evaluate instead of addScriptTag)
    log('\n💉 Injecting test script...', 'cyan');
    const testScript = fs.readFileSync(testScriptPath, 'utf8');

    // Execute script directly in page context to bypass CSP restrictions
    await page.evaluate((scriptContent) => {
      // Use indirect eval to execute in global scope
      (1, eval)(scriptContent);
    }, testScript);

    log('  ✓ Test script injected', 'green');

    // Wait for test script to load
    await page.waitForTimeout(1000);

    // Check if test function is available
    const testFunctionExists = await page.evaluate(() => {
      return typeof window.KYT_TEST_MOBILE_VOICE_CAPTURE === 'function';
    });

    if (!testFunctionExists) {
      log('❌ Test function not found in page context', 'red');
      log('   This may indicate the test script did not load correctly', 'yellow');
      throw new Error('KYT_TEST_MOBILE_VOICE_CAPTURE function not available');
    }

    log('  ✓ Test function available', 'green');

    // Set up console message capture
    log('\n🎯 Executing tests...', 'cyan');
    const consoleLogs = [];

    page.on('console', msg => {
      const text = msg.text();
      consoleLogs.push(text);

      // Echo important test output
      if (text.includes('✅ PASS:') || text.includes('PASSED')) {
        log(`  ${text}`, 'green');
      } else if (text.includes('❌ FAIL:')) {
        log(`  ${text}`, 'red');
      } else if (text.includes('⚠️  WARN:')) {
        log(`  ${text}`, 'yellow');
      } else if (text.includes('===') || text.includes('Test')) {
        log(`  ${text}`, 'cyan');
      }
    });

    // Run tests and capture results
    const testResults = await page.evaluate(async () => {
      try {
        // Disable auto-run since we're calling explicitly
        window.KYT_TEST_ALREADY_RUNNING = true;
        
        // Run the test suite
        const results = await window.KYT_TEST_MOBILE_VOICE_CAPTURE();
        return {
          success: true,
          results: results,
          error: null
        };
      } catch (error) {
        return {
          success: false,
          results: null,
          error: error.message
        };
      }
    });

    // Wait for all async operations to complete
    await page.waitForTimeout(2000);

    // Generate report
    logSection('📊 Test Results');

    if (!testResults.success) {
      log(`\n❌ Test suite execution failed: ${testResults.error}`, 'red');
      process.exit(1);
    }

    const results = testResults.results;

    if (!results) {
      log('\n⚠️  No test results returned', 'yellow');
      log('   This may indicate tests did not complete', 'yellow');
      process.exit(1);
    }

    console.log('\n' + '-'.repeat(60));
    log(`Total Passed: ${results.passed}`, results.passed > 0 ? 'green' : 'yellow');
    log(`Total Failed: ${results.failed}`, results.failed > 0 ? 'red' : 'green');
    log(`Total Warnings: ${results.warnings}`, results.warnings > 0 ? 'yellow' : 'green');
    log(`Pass Rate: ${results.passRate}%`, results.passRate === 100 ? 'green' : 'yellow');
    console.log('-'.repeat(60));

    // Save detailed logs
    const logFile = path.join(__dirname, '../test-results/mobile-voice-test-log.txt');
    const logDir = path.dirname(logFile);

    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }

    const timestamp = new Date().toISOString();
    const logContent = [
      `Mobile Voice Capture Test Results`,
      `Timestamp: ${timestamp}`,
      ``,
      `Summary:`,
      `  Passed: ${results.passed}`,
      `  Failed: ${results.failed}`,
      `  Warnings: ${results.warnings}`,
      `  Pass Rate: ${results.passRate}%`,
      ``,
      `Console Output:`,
      `${'='.repeat(60)}`,
      ...consoleLogs,
      `${'='.repeat(60)}`,
      ``
    ].join('\n');

    fs.writeFileSync(logFile, logContent);
    log(`\n💾 Detailed logs saved to: ${logFile}`, 'cyan');

    // Final verdict
    logSection('🎯 Final Verdict');

    if (results.failed === 0) {
      log('\n✅ ALL TESTS PASSED!', 'green');
      log('   Mobile voice capture feature is validated and ready.', 'green');
      return 0;
    } else {
      log('\n❌ SOME TESTS FAILED', 'red');
      log(`   ${results.failed} test(s) need attention.`, 'red');
      log('   Review the output above for details.', 'yellow');
      return 1;
    }

  } catch (error) {
    log(`\n❌ Test execution error: ${error.message}`, 'red');
    console.error(error);
    return 1;
  } finally {
    // Cleanup
    if (page) {
      log('\n🧹 Cleaning up...', 'cyan');
      await page.close();
      log('  ✓ Page closed', 'green');
    }

    if (context) {
      await context.close();
      log('  ✓ Browser closed', 'green');
    }
  }
}

// Execute tests
runTests()
  .then(exitCode => {
    process.exit(exitCode);
  })
  .catch(error => {
    log(`\n💥 Unhandled error: ${error.message}`, 'red');
    console.error(error);
    process.exit(1);
  });
