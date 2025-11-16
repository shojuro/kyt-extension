# How to Test Chrome Extension Background Scripts Correctly

## The Dev's Mistake: A Case Study

### What the Dev Tried to Do

```javascript
// In service worker DevTools console at chrome://extensions
chrome.runtime.sendMessage({type: 'GET_STATS'}, console.log)
```

**Result:**
```
Error: Could not establish connection. Receiving end does not exist.
```

### The Dev's Interpretation

> "This is a Chrome Extension Manifest V3 architecture limitation!
> Service workers CANNOT send messages to themselves!
> I need to create KYT_DEBUG as a workaround!"

### The Reality

**✅ The architectural claim is TRUE**
- Service workers indeed cannot message themselves
- This IS how Chrome extensions work

**❌ But the framing is MISLEADING**
- Production code was NEVER trying to self-message
- Content scripts → Background worked perfectly
- This was a **testing methodology error**, not a production bug
- KYT_DEBUG is a **debugging convenience**, not an architectural fix

---

## Understanding Chrome Extension Message Flow

### ✅ CORRECT Architecture (Production Code)

```
┌─────────────┐      ┌──────────────┐      ┌──────────────┐
│ Page        │      │ Content      │      │ Background   │
│ Context     │─────▶│ Script       │─────▶│ Worker       │
│             │      │              │      │              │
│ (inject.js) │      │ (content.js) │      │(background.js│
└─────────────┘      └──────────────┘      └──────────────┘
   CustomEvent      chrome.runtime.sendMessage()  ✅ WORKS!
```

**Why this works:**
- Different contexts (page → content → background)
- Each has distinct scope
- Message passing designed for cross-context communication

### ❌ INCORRECT Approach (What Dev Tried)

```
┌──────────────┐
│ Background   │────┐
│ Worker       │    │
│              │◀───┘  chrome.runtime.sendMessage()
│(background.js)    │  to itself
└──────────────┘    │
                    │
                    ▼
                ❌ FAILS
     "Could not establish connection"
```

**Why this fails:**
- Same context trying to message itself
- Not the intended use case
- Message channel closes immediately

---

## The Right Way to Test

## Option 1: Automated Unit Tests ⭐ RECOMMENDED

### Setup (One Time)

```bash
npm install --save-dev vitest @vitest/ui
```

### Create Test File: `tests/background.test.js`

```javascript
import { describe, it, expect, beforeEach } from 'vitest';
import { setupChromeMocks } from './setup.js';

describe('Background Script', () => {
  let chromeMocks;

  beforeEach(() => {
    chromeMocks = setupChromeMocks();
  });

  it('should save messages correctly', async () => {
    // Test the ACTUAL function, not message passing
    const messageData = {
      content: 'Test message',
      role: 'user',
      timestamp: Date.now()
    };

    const saveMessage = async (data) => {
      const result = await chrome.storage.local.get(['captured_messages']);
      const messages = result.captured_messages || [];
      messages.push({
        ...data,
        capturedAt: Date.now(),
        messageId: `msg_${Date.now()}_test`
      });
      await chrome.storage.local.set({ captured_messages: messages });
      return true;
    };

    // Execute
    const result = await saveMessage(messageData);

    // Verify - THIS CAN FAIL!
    expect(result).toBe(true);
    expect(chromeMocks.storage._getInternalStorage().captured_messages)
      .toHaveLength(1);
  });
});
```

### Run Tests

```bash
npm test                # Run once
npm run test:watch      # Re-run on changes
npm run test:ui         # Interactive UI
```

**Benefits:**
- ✅ Automated (no manual steps)
- ✅ Fast feedback
- ✅ CI/CD ready
- ✅ Can prove tests work by showing failures
- ✅ Regression protection

---

## Option 2: Integration Tests with Proper Mocks

### Test Message Passing Flow

```javascript
describe('Message Flow Integration', () => {
  it('should handle Content Script → Background flow', async () => {
    // Setup background handler
    const backgroundHandler = (message, sender, sendResponse) => {
      if (message.type === 'SAVE_MESSAGE') {
        chrome.storage.local.get(['captured_messages']).then(result => {
          const messages = result.captured_messages || [];
          messages.push(message.data);
          return chrome.storage.local.set({ captured_messages: messages });
        }).then(() => {
          sendResponse({ success: true });
        });
        return true; // Keep channel open for async
      }
    };

    chromeMocks.runtime.onMessage.addListener(backgroundHandler);

    // Simulate content script sending message
    const response = await chromeMocks.runtime.onMessage._triggerMessage(
      {
        type: 'SAVE_MESSAGE',
        data: { content: 'Test from content script' }
      },
      { tab: { id: 123 } } // Sender context
    );

    // Verify complete flow
    expect(response.success).toBe(true);
    expect(chromeMocks.storage._getInternalStorage().captured_messages)
      .toHaveLength(1);
  });
});
```

**Benefits:**
- ✅ Tests actual message flow
- ✅ Catches integration bugs
- ✅ Documents how system works
- ✅ Still automated

---

## Option 3: Manual Testing with KYT_DEBUG

### When to Use
- Quick spot checks
- Debugging specific issues
- Exploring behavior interactively

### How to Use

```javascript
// 1. Open chrome://extensions
// 2. Find your extension
// 3. Click "service worker" link
// 4. In DevTools console:

KYT_DEBUG.getStats()      // View statistics
KYT_DEBUG.viewStorage()   // View all storage
KYT_DEBUG.getContext("test")  // Test context retrieval
```

**Important:**
- ❌ NOT a replacement for automated tests
- ❌ NOT a "fix" for architecture limitations
- ✅ Just a debugging convenience

---

## Common Mistakes and Solutions

### Mistake 1: Testing in Wrong Context

```javascript
// ❌ WRONG: In ChatGPT page console
chrome.runtime.sendMessage({type: 'TEST'})
// Error: chrome.runtime is undefined

// ✅ RIGHT: Either:
// 1. Automated test with mocks
// 2. Service worker console with KYT_DEBUG
// 3. Content script context (for actual use)
```

### Mistake 2: Trying to Self-Message

```javascript
// ❌ WRONG: From service worker to itself
chrome.runtime.sendMessage({type: 'GET_STATS'}, console.log)
// Error: Could not establish connection

// ✅ RIGHT: Test the function directly
await getStorageStats().then(console.log)
// or use KYT_DEBUG.getStats()
```

### Mistake 3: Forgetting Async `return true`

```javascript
// ❌ WRONG: No return true for async
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'ASYNC_ACTION') {
    setTimeout(() => {
      sendResponse({ done: true });
    }, 100);
    // MISSING: return true;
  }
});
// Result: "Could not establish connection"

// ✅ RIGHT: Return true to keep channel open
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'ASYNC_ACTION') {
    setTimeout(() => {
      sendResponse({ done: true });
    }, 100);
    return true; // ✅ Keeps channel open
  }
});
```

### Mistake 4: No Automated Tests

```javascript
// ❌ WRONG: Only manual console testing
// - Slow
// - Error-prone
// - Can't automate
// - No regression protection

// ✅ RIGHT: Automated test suite
describe('Background Script', () => {
  it('tests all functionality', async () => {
    // Tests run automatically
    // Can be CI/CD integrated
    // Provides regression protection
  });
});
```

---

## Testing Checklist

Before considering testing "complete":

- [ ] Unit tests for core functions
- [ ] Integration tests for message passing
- [ ] Tests can ACTUALLY FAIL (not theater)
- [ ] Tests run automatically (`npm test`)
- [ ] Coverage report available
- [ ] CI/CD integration (GitHub Actions, etc.)
- [ ] Tests document expected behavior
- [ ] Error cases tested (not just happy path)

---

## Example: Complete Test Suite

See the `tests/` directory for:

1. **setup.js** - Chrome API mocks
   - Mock `chrome.storage.local`
   - Mock `chrome.runtime` (sendMessage, onMessage)
   - Mock `chrome.alarms`
   - Helpers to trigger events

2. **background.test.js** - Unit tests (11 tests)
   - Storage operations
   - Message ID generation
   - Stats calculation
   - Error handling

3. **integration.test.js** - Integration tests (7 tests)
   - Full message flow
   - API call integration
   - Error propagation
   - Async patterns

4. **README.md** - Testing guide
   - How to run tests
   - What each test validates
   - VTEST verification steps

---

## VTEST: Prove Tests Work

Following CLAUDE.md anti-theater rules:

```bash
# 1. VEXIST: Verify test files exist
ls -la tests/
# ✅ setup.js, background.test.js, integration.test.js

# 2. VRUN: Run tests
npm test
# ✅ 18 tests passing

# 3. VTEST: Prove tests can fail
# Edit tests/background.test.js line 172
# Change: expect(stats.totalMessages).toBe(3);
# To:     expect(stats.totalMessages).toBe(999);

npm test
# ❌ Test FAILS with clear error:
# "expected 3 to be 999"

# Fix and verify
# Change back to correct value
npm test
# ✅ Test PASSES

# This proves tests are REAL, not theater!
```

---

## Key Takeaways

### What the Dev Learned (Eventually)
1. ✅ Service workers can't self-message (architectural fact)
2. ❌ But framed it as fixing a "production bug" (misleading)
3. ❌ Created manual debugging helper as "solution" (incomplete)

### What the Dev SHOULD Have Done
1. ✅ Recognize this is a testing approach issue
2. ✅ Write proper automated tests
3. ✅ Test functions directly, not via message passing
4. ✅ Keep manual helpers as optional debugging aid
5. ✅ Don't confuse debugging convenience with proper testing

### The Right Mental Model

**Manual debugging helpers (KYT_DEBUG):**
- For: Quick spot checks, interactive exploration
- Not for: Regression protection, CI/CD, documentation

**Automated tests:**
- For: Regression protection, CI/CD, documentation, reliability
- Not for: Quick interactive debugging

**Use BOTH, but know which is which!**

---

## Resources

- [Chrome Extension Message Passing Docs](https://developer.chrome.com/docs/extensions/develop/concepts/messaging)
- [Vitest Testing Framework](https://vitest.dev/)
- [This Project's Test Suite](./tests/)
- [CLAUDE.md Anti-Theater Rules](./CLAUDE.md)

---

## Summary

**The Question:** How do you test Chrome extension background scripts correctly?

**The Answer:**
1. **Automated unit tests** for functions
2. **Integration tests** for message flows with proper mocks
3. **Manual KYT_DEBUG** for occasional debugging only

**The Wrong Answer:**
- Trying to test via self-messaging from service worker console
- Framing architectural limitations as "bugs" that need "fixing"
- Creating manual debugging helpers and calling it "proper testing"

**Remember:**
- Production code was always correct
- Testing methodology was the issue
- Automated tests > Manual console testing
- Debugging helpers ≠ Test suite
