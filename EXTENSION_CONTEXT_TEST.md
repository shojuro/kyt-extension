# Extension Context Invalidation Fix - Testing Guide

**Date**: 2025-11-15
**Commit**: b4307a5
**Status**: Ready for User Testing

---

## What Was Fixed

### Problem
- "Extension context invalidated" error on second message
- Service worker goes inactive after ~30s of inactivity
- Calling `chrome.runtime.sendMessage()` on dead context threw unhelpful errors

### Solution
- Added `chrome.runtime?.id` validation before ALL `sendMessage()` calls
- Early return with clear warning messages
- User-friendly guidance: "Please reload the page to restore functionality"
- Applied to both ChatGPT and Claude platforms

---

## Testing Instructions

### Prerequisites
1. Load extension in Chrome: `chrome://extensions`
2. Ensure "Developer mode" is enabled
3. Click "Reload" button on KYT Memory Extension

### Test Case 1: Normal Operation (No Context Invalidation)

**Steps**:
1. Open ChatGPT: https://chatgpt.com
2. Open browser console (F12)
3. Send message: "What is quantum entanglement?"
4. Check console logs

**Expected Results**:
```
🚀 KYT ChatGPT: Initializing inject.js...
✅ KYT ChatGPT: Fetch wrapper installed
🎯 KYT ChatGPT: Intercepted API call
📨 KYT ChatGPT Content: Received message from page context
✅ KYT ChatGPT Content: Message forwarded to background
🤖 KYT ChatGPT: Assistant response captured
📨 KYT ChatGPT Content: Received message from page context
✅ KYT ChatGPT Content: Message forwarded to background
```

**Success Criteria**:
- ✅ No errors in console
- ✅ Both user and assistant messages captured
- ✅ "Message forwarded to background" appears twice

### Test Case 2: Context Invalidation (Extension Reload)

**Steps**:
1. Keep ChatGPT tab open with console visible
2. Go to `chrome://extensions`
3. Click "Reload" button on KYT Memory Extension
4. Return to ChatGPT tab (DO NOT reload page)
5. Send message: "Explain black holes"
6. Check console logs

**Expected Results (NEW - After Fix)**:
```
⚠️ KYT ChatGPT Content: Extension context invalidated - message not saved
   Please reload the page to restore functionality
```

**Success Criteria**:
- ✅ Clear warning message appears
- ✅ No cryptic "Extension context invalidated" error
- ✅ User guidance provided: "Please reload the page"
- ✅ No JavaScript errors or crashes
- ✅ Extension doesn't break the page

**Old Behavior (Before Fix)**:
```
❌ Error: Extension context invalidated
❌ Uncaught (in promise): Error: Extension context invalidated
```

### Test Case 3: Recovery After Reload

**Steps**:
1. After Test Case 2, reload the ChatGPT page (F5)
2. Open console again
3. Send message: "What is dark matter?"
4. Check console logs

**Expected Results**:
```
🚀 KYT ChatGPT: Initializing inject.js...
✅ KYT ChatGPT: Fetch wrapper installed
🎯 KYT ChatGPT: Intercepted API call
📨 KYT ChatGPT Content: Received message from page context
✅ KYT ChatGPT Content: Message forwarded to background
🤖 KYT ChatGPT: Assistant response captured
```

**Success Criteria**:
- ✅ Extension functionality restored
- ✅ Messages captured successfully
- ✅ No errors in console

### Test Case 4: Context Request During Invalidation

**Steps**:
1. Open ChatGPT with extension loaded
2. Reload extension at `chrome://extensions`
3. Return to ChatGPT (don't reload page)
4. Send message that would trigger context retrieval
5. Check console logs

**Expected Results**:
```
🔍 KYT ChatGPT: Requesting context for: [your message]
⚠️ KYT ChatGPT Content: Extension context invalidated - cannot get context
   Please reload the page to restore functionality
```

**Success Criteria**:
- ✅ Context request fails gracefully
- ✅ Clear error message with guidance
- ✅ No crashes or hanging promises
- ✅ Page remains functional

### Test Case 5: Claude Platform (Same Tests)

**Steps**:
1. Open Claude: https://claude.ai
2. Repeat Test Cases 1-4
3. Check for similar console messages with "🔵 BRIDGE" prefix

**Expected Results**:
- Same behavior as ChatGPT platform
- Bridge-specific log prefixes
- Graceful error handling

---

## Console Log Reference

### ✅ SUCCESS Messages (Normal Operation)

**ChatGPT**:
- `🚀 KYT ChatGPT: Initializing inject.js...`
- `✅ KYT ChatGPT: Fetch wrapper installed`
- `🎯 KYT ChatGPT: Intercepted API call`
- `📨 KYT ChatGPT Content: Received message from page context`
- `✅ KYT ChatGPT Content: Message forwarded to background`
- `🤖 KYT ChatGPT: Assistant response captured`

**Claude**:
- `🟢 KYT Claude: Content script loaded in MAIN world`
- `🔵 BRIDGE: Content bridge loaded in ISOLATED world`
- `🟢 KYT Claude: Intercepted completion request`
- `🔵 BRIDGE: Received KYT_MESSAGE_CAPTURED event`
- `🔵 BRIDGE: ✅ Background confirmed receipt`

### ⚠️ WARNING Messages (Context Invalidated - NEW)

**ChatGPT**:
```
⚠️ KYT ChatGPT Content: Extension context invalidated - message not saved
   Please reload the page to restore functionality
```

**Claude**:
```
⚠️ BRIDGE: Extension context invalidated - message not saved
   Please reload the page to restore functionality
```

### ⚠️ WARNING Messages (Context Request Failed - NEW)

**ChatGPT**:
```
⚠️ KYT ChatGPT Content: Extension context invalidated - cannot get context
   Please reload the page to restore functionality
```

**Claude**:
```
⚠️ BRIDGE: Extension context invalidated - cannot get context
   Please reload the page to restore functionality
```

### ❌ ERROR Messages (OLD - Should NOT See These)

**Before Fix (Should NOT Appear)**:
- `❌ Error: Extension context invalidated` (without guidance)
- `Uncaught (in promise): Error: Extension context invalidated`
- Silent failures with no user notification

---

## Validation Checklist

Run through ALL test cases and verify:

- [ ] Test Case 1: Normal operation works (messages captured)
- [ ] Test Case 2: Context invalidation shows clear warning
- [ ] Test Case 3: Page reload restores functionality
- [ ] Test Case 4: Context requests fail gracefully
- [ ] Test Case 5: Claude platform has same behavior
- [ ] No cryptic error messages
- [ ] User guidance always provided
- [ ] No JavaScript errors or crashes
- [ ] Extension doesn't break page functionality

---

## Code References

### ChatGPT Platform

**File**: `platforms/chatgpt/content.js`

**Message Forwarding (Lines 25-51)**:
```javascript
window.addEventListener('KYT_MESSAGE_CAPTURED', function(event) {
  const messageData = event.detail;
  console.log('📨 KYT ChatGPT Content: Received message from page context');

  // Check if extension context is still valid
  if (!chrome.runtime?.id) {
    console.warn('⚠️ KYT ChatGPT Content: Extension context invalidated - message not saved');
    console.warn('   Please reload the page to restore functionality');
    return;
  }

  chrome.runtime.sendMessage({
    type: 'SAVE_MESSAGE',
    data: messageData
  }).then(() => {
    console.log('✅ KYT ChatGPT Content: Message forwarded to background');
  }).catch(error => {
    if (error.message && error.message.includes('Extension context invalidated')) {
      console.warn('⚠️ KYT ChatGPT Content: Extension was reloaded - please refresh page');
    } else {
      console.error('❌ KYT ChatGPT Content: Failed to forward message:', error);
    }
  });
});
```

**Context Request Handling (Lines 56-118)**: Similar pattern with runtime validation

### Claude Platform

**File**: `platforms/claude/content_bridge.js`

**Lines 15-52**: Message forwarding with runtime validation
**Lines 55-119**: Context request handling with runtime validation

---

## Expected Behavior Summary

### Before Fix (OLD)
- ❌ Cryptic "Extension context invalidated" errors
- ❌ No user guidance on recovery
- ❌ Errors appear in console without explanation
- ❌ Users confused about what went wrong

### After Fix (NEW - Commit b4307a5)
- ✅ Clear warning: "Extension context invalidated - message not saved"
- ✅ User guidance: "Please reload the page to restore functionality"
- ✅ Graceful degradation (no crashes)
- ✅ Consistent behavior across both platforms
- ✅ Better developer experience during debugging

---

## Troubleshooting

### If Test Case 2 Shows Old Behavior

**Problem**: Still seeing cryptic errors after extension reload

**Solution**:
1. Hard reload ChatGPT page: `Ctrl+Shift+R` (Windows) or `Cmd+Shift+R` (Mac)
2. Clear browser cache
3. Reload extension again
4. Verify commit b4307a5 is actually loaded

### If Messages Not Forwarding

**Problem**: No messages captured at all

**Possible Causes**:
1. Extension not loaded properly
2. Content scripts not injected
3. Background script not running

**Solution**:
1. Check `chrome://extensions` - extension enabled?
2. Check extension service worker - is it active?
3. Check console for initialization logs
4. Try reloading extension and page

### If Context Requests Timeout

**Problem**: Context requests hang without response

**Check**:
1. Background script running? (check service worker)
2. API keys configured? (check background.js logs)
3. Network requests succeeding? (check Network tab)

---

## Reporting Results

When reporting test results, please include:

1. **Test Case Results**: Pass/Fail for each test case
2. **Console Logs**: Full console output (especially for Test Case 2)
3. **Browser Info**: Chrome version
4. **Extension Status**: Service worker state during tests
5. **Any Unexpected Behavior**: Errors, warnings, or crashes

**Format**:
```
## Test Results

**Environment**:
- Browser: Chrome 120.x
- Extension Version: [from manifest.json]
- Date: 2025-11-15

**Test Case 1**: ✅ PASS
- Normal operation works
- Messages captured: User + Assistant
- Console logs: [paste logs]

**Test Case 2**: ✅ PASS / ❌ FAIL
- Extension reloaded during session
- Warning message appeared: [paste message]
- Console logs: [paste logs]

**Test Case 3**: ✅ PASS
- Page reload restored functionality
- Messages captured after reload

**Test Case 4**: ✅ PASS
- Context request failed gracefully
- Clear error message shown

**Test Case 5**: ✅ PASS
- Claude platform same behavior
- Consistent error handling

**Overall**: ✅ ALL TESTS PASSED / ❌ SOME FAILURES
```

---

## Success Criteria

Fix is considered **COMPLETE** when:

- ✅ All 5 test cases pass
- ✅ No cryptic error messages appear
- ✅ User guidance always provided on context invalidation
- ✅ Both platforms handle errors consistently
- ✅ Extension doesn't crash or break page functionality
- ✅ Recovery via page reload works 100%

---

## Next Steps After Testing

### If Tests Pass
1. Mark test as complete in todo list
2. Update CHANGELOG with test results
3. Move to Phase 2: Robustness improvements

### If Tests Fail
1. Document specific failure scenarios
2. Analyze console logs for root cause
3. Implement additional fixes
4. Re-test until all tests pass
