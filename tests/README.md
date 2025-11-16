# Proper Testing for Chrome Extension Background Script

## The Problem the Dev Encountered

The developer was trying to test the background script by:
```javascript
// ❌ WRONG: Trying to send message from service worker console to itself
chrome.runtime.sendMessage({type: 'GET_STATS'}, console.log)
// Error: "Could not establish connection. Receiving end does not exist"
```

**Why this doesn't work:**
- Service workers CANNOT send messages to themselves
- This is a Chrome Extension Manifest V3 architectural limitation
- The `chrome.runtime.onMessage` listener receives messages FROM:
  - ✅ Content scripts
  - ✅ Popup pages
  - ✅ Options pages
  - ❌ NOT from the service worker itself

## The Right Way to Test

### ✅ Option 1: Proper Unit Tests (THIS APPROACH)

Test the underlying functions directly with proper mocks:

```javascript
// Test the actual function, not the message passing
const stats = await getStorageStats();
expect(stats.totalMessages).toBe(expectedCount);
```

### ✅ Option 2: Integration Tests with Mocks (THIS APPROACH)

Simulate content scripts sending messages:

```javascript
// Mock the message flow FROM content script TO background
const response = await chromeMocks.runtime.onMessage._triggerMessage({
  type: 'GET_STATS'
});
expect(response.success).toBe(true);
```

### ✅ Option 3: Direct Function Calls (KYT_DEBUG approach)

For manual testing only:
```javascript
// In service worker console
KYT_DEBUG.getStats()  // Works because it calls function directly
```

**Note:** KYT_DEBUG is fine for manual debugging but NOT a replacement for automated tests!

## Installation

```bash
npm install --save-dev vitest @vitest/ui sinon-chrome
```

## Running Tests

```bash
# Run all tests
npm test

# Watch mode (re-run on changes)
npm test -- --watch

# With coverage
npm test -- --coverage

# Run specific test file
npm test tests/background.test.js

# UI mode for interactive testing
npx vitest --ui
```

## Test Structure

```
tests/
├── setup.js              # Chrome API mocks (storage, runtime, alarms)
├── background.test.js    # Unit tests for background functions
├── integration.test.js   # Integration tests for message passing
└── README.md            # This file
```

## Key Testing Principles (CLAUDE.md Compliance)

### ✅ Tests MUST be able to FAIL

```javascript
// ✅ GOOD: Test with expectations that can fail
expect(stats.totalMessages).toBe(3);  // Fails if not exactly 3

// ❌ BAD: Test that always passes
expect(true).toBe(true);  // Theater!
```

### ✅ Test Real Behavior, Not Mocks

```javascript
// ✅ GOOD: Test actual logic with real expectations
const result = await saveMessage(invalidData);
await expect(result).rejects.toThrow('Invalid message data');

// ❌ BAD: Just verify mock was called
expect(mockFunction).toHaveBeenCalled();  // Doesn't test behavior!
```

### ✅ Demonstrate Failure Cases

```javascript
// ✅ GOOD: Test shows what happens when it fails
it('should FAIL when message data is invalid', async () => {
  await expect(saveMessage(null)).rejects.toThrow('Invalid message data');
  await expect(saveMessage({role: 'user'})).rejects.toThrow('Invalid message content');
});
```

## What These Tests Actually Validate

### 1. Storage Operations (`background.test.js`)
- ✅ `saveMessage()` stores valid messages
- ✅ `saveMessage()` REJECTS invalid data (null, missing content)
- ✅ `getStorageStats()` returns accurate counts
- ✅ `generateMessageId()` creates unique IDs

### 2. Message Handlers (`background.test.js`)
- ✅ `SAVE_MESSAGE` handler responds correctly
- ✅ `GET_STATS` handler returns statistics
- ✅ Handlers properly use `return true` for async operations
- ✅ Error responses when data is invalid

### 3. Integration Flows (`integration.test.js`)
- ✅ Full Content Script → Background flow works
- ✅ `GET_CONTEXT` makes API calls correctly
- ✅ API failures are handled gracefully
- ✅ Storage failures are handled gracefully

### 4. The Architectural Limitation
- ✅ Proves service workers can't message themselves
- ✅ Shows the "Could not establish connection" error
- ✅ Demonstrates the correct architecture (content → background)

## Running Manual Tests (KYT_DEBUG)

If you still want to test manually in the service worker console:

```javascript
// 1. Open service worker console at chrome://extensions
// 2. Click "service worker" link for the extension
// 3. Run these commands:

// View statistics
KYT_DEBUG.getStats()

// View all storage
KYT_DEBUG.viewStorage()

// Test context retrieval (requires API keys configured)
KYT_DEBUG.getContext("test message")

// Clear storage (use with caution!)
KYT_DEBUG.clearStorage()
```

**But remember:** Manual testing is NOT a substitute for automated tests!

## Continuous Integration

Add to `.github/workflows/test.yml`:

```yaml
name: Tests
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: '18'
      - run: npm install
      - run: npm test
```

## What the Dev Should Have Done

1. ✅ **Write unit tests** for functions like `saveMessage()`, `getStorageStats()`
2. ✅ **Write integration tests** for message passing with proper mocks
3. ✅ **Use proper Chrome extension testing tools** (not manual console testing)
4. ❌ **NOT** try to send messages from service worker to itself
5. ❌ **NOT** frame manual testing workarounds as "fixing architecture issues"

## Comparison: Manual vs Automated Testing

| Approach | Pros | Cons |
|----------|------|------|
| **KYT_DEBUG (Manual)** | Quick for debugging | No automation, no CI, error-prone |
| **Proper Unit Tests** | Automated, CI-ready, reliable | Initial setup time |
| **Integration Tests** | Tests real flows, catches integration bugs | More complex setup |

## Security Note

From CLAUDE.md rules:
- ✅ Tests use mock API keys (`sk-test-key`)
- ✅ No real credentials in test code
- ✅ `.env` excluded from git
- ✅ Tests don't require real API access

## VTEST Verification

Run these commands to verify tests are real (CLAUDE.md compliance):

```bash
# VTEST: Show test code that can FAIL
cat tests/background.test.js | grep "should FAIL"

# VTEST: Run tests
npm test

# VTEST: Make a test fail on purpose
# Edit tests/background.test.js and change an expectation:
# expect(stats.totalMessages).toBe(999999)  // Wrong value
# Then run: npm test
# Test MUST fail!

# VTEST: Fix and verify passes
# Change back to correct value
# Run: npm test
# Test MUST pass!
```

## Summary

**The dev's "issue":** Couldn't test from service worker console using `chrome.runtime.sendMessage()`

**The real issue:** Wrong testing approach from the start

**The right solution:**
1. Automated unit tests for functions
2. Integration tests for message passing
3. Manual KYT_DEBUG only for quick debugging

**NOT:** Creating elaborate debugging infrastructure and calling it "architecture discovery"
