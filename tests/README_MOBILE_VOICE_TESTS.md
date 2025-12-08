# Mobile Voice Capture - Automated Testing

## Overview

Automated test suite for the mobile voice capture feature using Playwright to load the Chrome extension and execute validation tests.

## Prerequisites

- ✅ Playwright installed (already in devDependencies)
- ✅ Chrome/Chromium browser
- ✅ Extension files present in project root

### First-Time Setup (Linux/WSL)

If running on Linux or WSL, install Playwright system dependencies:

```bash
# Install browser dependencies (one-time setup)
sudo npx playwright install-deps

# Download Chromium browser binary
npx playwright install chromium
```

**Note:** Windows and macOS users can skip this step - dependencies are bundled.

## Quick Start

### Run Automated Tests

```bash
npm run test:mobile-voice
```

This will:
1. Verify all required extension files exist
2. Launch Chrome with the extension loaded
3. Navigate to ChatGPT
4. Inject and execute the test suite
5. Capture and report results
6. Save detailed logs to `test-results/`

### Expected Output

```
============================================================
🚀 Mobile Voice Capture - Automated Test Suite
============================================================

📂 Verifying extension files...
  ✓ manifest.json
  ✓ background.js
  ✓ platforms/chatgpt/content.js
  ✓ platforms/chatgpt/dom-observer.js
  ✓ test_mobile_voice_capture.js

🌐 Launching Chrome with extension...
  ✓ Browser launched with extension
  ✓ New page created

🔗 Navigating to ChatGPT...
  ✓ ChatGPT loaded

⏳ Waiting for extension to initialize...

💉 Injecting test script...
  ✓ Test script injected
  ✓ Test function available

🎯 Executing tests...
  === Test 1: DOM Observer Initialization ===
  ✅ PASS: DOM Observer Script Loaded
  ✅ PASS: Observer Health Check Response

  === Test 2: Content-Only Hash Deduplication ===
  ✅ PASS: Duplicate Message Blocked
  ✅ PASS: Different Content Allowed

  [... more tests ...]

============================================================
📊 Test Results
============================================================

------------------------------------------------------------
Total Passed: 13
Total Failed: 0
Total Warnings: 2
Pass Rate: 100.0%
------------------------------------------------------------

💾 Detailed logs saved to: test-results/mobile-voice-test-log.txt

============================================================
🎯 Final Verdict
============================================================

✅ ALL TESTS PASSED!
   Mobile voice capture feature is validated and ready.
```

## Test Categories

The automated suite runs 7 test categories:

1. **DOM Observer Initialization**
   - Verifies observer script loads
   - Checks health status
   - Validates restart counter

2. **Content-Only Hash Deduplication**
   - Tests duplicate detection
   - Verifies cross-source dedup
   - Validates hash generation

3. **Storage Quota Management**
   - Tests quota threshold detection
   - Verifies LRU eviction
   - Validates storage cleanup

4. **Dual-Source Capture Statistics**
   - Checks API source counting
   - Verifies DOM source counting
   - Validates stats persistence

5. **Error Handling and Auto-Restart**
   - Tests observer restart mechanism
   - Verifies exponential backoff
   - Validates error recovery

6. **Debug Mode Integration**
   - Tests debug toggle
   - Verifies logging control
   - Validates UI updates

7. **Queue Manager Integration**
   - Tests queue persistence
   - Verifies encrypted storage
   - Validates sync retry logic

## Test Results

### Logs

Detailed test logs are saved to:
```
test-results/mobile-voice-test-log.txt
```

This file contains:
- Timestamp
- Summary statistics
- All console output from tests
- Pass/fail details for each assertion

### Test Profile

Browser profile data is stored in:
```
.test-profile/
```

This directory contains:
- Extension state
- LocalStorage data
- Session cookies (for ChatGPT login)

**Note:** Add `.test-profile/` to `.gitignore` to avoid committing browser data.

## Manual Verification

If automated tests fail or you need to verify behavior manually:

1. **Open Extension in Chrome**
   ```bash
   # Load unpacked extension from project root
   chrome://extensions/ → Load unpacked → Select project directory
   ```

2. **Navigate to ChatGPT**
   ```
   https://chatgpt.com
   ```

3. **Open Browser Console**
   ```
   Press F12 → Console tab
   ```

4. **Run Tests Manually**
   ```javascript
   window.KYT_TEST_MOBILE_VOICE_CAPTURE()
   ```

## Troubleshooting

### Missing System Dependencies (Linux/WSL)

**Symptom:** Error message about missing browser dependencies:
```
Host system is missing dependencies to run browsers.
Please install them with the following command:
    sudo npx playwright install-deps
```

**Solutions:**
```bash
# Option 1: Automatic installation (recommended)
sudo npx playwright install-deps

# Option 2: Manual installation
sudo apt-get install libnspr4 libnss3 libatk1.0-0 libatk-bridge2.0-0 \
  libcups2 libxkbcommon0 libatspi2.0-0 libxcomposite1 libxdamage1 \
  libxfixes3 libxrandr2 libgbm1 libcairo2 libpango-1.0-0 libasound2

# Then download Chromium
npx playwright install chromium

# Try again
npm run test:mobile-voice
```

**Note:** This is a one-time setup required on Linux systems.

### CAPTCHA Blocking Tests

**Symptom:** ChatGPT shows CAPTCHA or requires login

**This is expected!** ChatGPT detects automated browser sessions and may show CAPTCHA protection.

**One-Time Solution:**

1. **When CAPTCHA appears:** Solve it manually in the browser window (it stays open)
2. **Log in to ChatGPT** if prompted
3. **The session is saved** in `.test-profile/` directory
4. **Subsequent test runs** will reuse the authenticated session

**To clear session and start fresh:**
```bash
rm -rf .test-profile/
npm run test:mobile-voice
```

**Why this works:**
- Test runner uses persistent browser context (`launchPersistentContext`)
- Login session cookies are saved to `.test-profile/Default/`
- Future tests reuse the same profile, avoiding CAPTCHA

**Important:** 
- You may need to re-authenticate periodically (ChatGPT sessions expire)
- If tests fail with "not logged in" errors, clear the profile and re-authenticate

### Tests Not Running

**Symptom:** Browser launches but tests don't execute

**Solutions:**
- Check that extension loaded correctly (chrome://extensions)
- Verify test script injected (look for console messages)
- Check for JavaScript errors in console

### Extension Not Loading

**Symptom:** Extension icon not visible in Chrome

**Solutions:**
- Verify manifest.json is valid: `jq . manifest.json`
- Check background.js has no syntax errors: `node -c background.js`
- Review Chrome extension console for errors

### ChatGPT Page Issues

**Symptom:** Tests fail because ChatGPT didn't load

**Solutions:**
- Check internet connection
- Verify you're logged into ChatGPT
- Try increasing timeout in test script (line 95)

### Browser Crashes

**Symptom:** Chrome crashes during test execution

**Solutions:**
- Close other Chrome instances
- Clear test profile: `rm -rf .test-profile`
- Reduce viewport size in test script

## Advanced Usage

### Running Tests in Headless Mode (Not Recommended)

Chrome extensions don't work reliably in headless mode, but you can try:

```javascript
// In run_mobile_voice_tests.js, line 90:
context = await chromium.launchPersistentContext(userDataDir, {
  headless: true,  // Change to true
  // ... rest of config
});
```

**Warning:** Many tests will fail because extension APIs are limited in headless mode.

### Custom Test Configuration

Edit `tests/run_mobile_voice_tests.cjs` to customize:

- **Viewport Size** (line 97): Change `{ width: 1280, height: 720 }`
- **Navigation Timeout** (line 107): Adjust `timeout: 30000`
- **Extension Wait Time** (line 112): Modify `waitForTimeout(3000)`
- **Test Wait Time** (line 121): Change final wait duration

### Debugging Test Failures

To debug a specific test:

1. Add `debugger;` statement in test script:
   ```javascript
   // In scripts/test_mobile_voice_capture.js
   async function testDOMObserverInit() {
     debugger;  // Browser will pause here
     // ... test code
   }
   ```

2. Run with browser DevTools open:
   ```javascript
   // In run_mobile_voice_tests.js, line 90:
   context = await chromium.launchPersistentContext(userDataDir, {
     devtools: true,  // Add this line
     // ... rest of config
   });
   ```

## Integration with CI/CD

### GitHub Actions Example

```yaml
name: Mobile Voice Capture Tests

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v2

      - name: Setup Node.js
        uses: actions/setup-node@v2
        with:
          node-version: '18'

      - name: Install dependencies
        run: npm ci

      - name: Install Playwright browsers
        run: npx playwright install chromium

      - name: Run mobile voice tests
        run: npm run test:mobile-voice

      - name: Upload test results
        if: always()
        uses: actions/upload-artifact@v2
        with:
          name: test-results
          path: test-results/
```

**Note:** CI/CD automation has limitations:
- ChatGPT may show CAPTCHA for automated sessions (requires manual solving)
- Consider using authenticated session cookies pre-configured in CI environment
- Alternatively, use mock/stub ChatGPT responses for CI tests

## Test Maintenance

### Updating Tests

When modifying the mobile voice capture feature:

1. Update test assertions in `scripts/test_mobile_voice_capture.js`
2. Verify tests fail when feature is broken (fail-first principle)
3. Fix feature and confirm tests pass
4. Update test documentation if needed

### Adding New Tests

To add a new test category:

```javascript
// In scripts/test_mobile_voice_capture.js

async function testNewFeature() {
  console.log('\n=== Test 8: New Feature ===');

  // Your test logic here
  const result = await someTestFunction();

  assert(
    result === expectedValue,
    'New Feature Works',
    'Feature did not produce expected result'
  );
}

// Add to runAllTests():
async function runAllTests() {
  // ... existing tests
  await testNewFeature();  // Add here
  // ... rest of code
}
```

## Performance Metrics

Expected test execution times:

- File verification: < 1s
- Browser launch: 3-5s
- ChatGPT navigation: 2-4s
- Extension initialization: 3s
- Test execution: 5-10s
- Cleanup: 1-2s

**Total: ~15-25 seconds**

## Security Considerations

- Test profile may contain ChatGPT session cookies
- Add `.test-profile/` to `.gitignore`
- Never commit browser profile data
- Use test accounts for automated testing
- Rotate test credentials regularly

## Support

For issues or questions:

1. Check troubleshooting section above
2. Review test logs in `test-results/`
3. Run manual verification steps
4. Check extension console for errors
5. Report bugs with full console output

---

**Last Updated:** 2025-11-23
**Test Suite Version:** 1.0.0
**Automation Status:** ✅ Fully Automated
