# KYT Day 1 Debugging Playbook

**Purpose**: Systematic troubleshooting for common Day 1 validation failures

---

## 🔴 Failure Scenario 1: Extension Not Loading

### Symptoms
- No green "K" icon in Chrome extensions toolbar
- Extension doesn't appear in chrome://extensions
- Console shows no "KYT" messages

### Root Causes
1. Invalid manifest.json syntax
2. Wrong directory selected in "Load unpacked"
3. Chrome security restrictions

### Debug Steps

```bash
# Step 1: Validate manifest.json syntax
cd /home/penguinzyue/kyt-validation-sprint
cat manifest.json | python3 -m json.tool

# Expected: Valid JSON output
# If error: Fix JSON syntax (missing comma, bracket, etc.)
```

```bash
# Step 2: Check file permissions
ls -la manifest.json content.js background.js

# Expected: All files readable (-rw-r--r--)
# If not: chmod 644 manifest.json content.js background.js
```

### Solutions

**Solution A**: Reload extension
1. Go to chrome://extensions
2. Find "KYT Memory Extension - Day 1 Validation"
3. Click refresh icon (circular arrow)
4. Check for errors in red text

**Solution B**: Remove and re-add
1. chrome://extensions → Remove extension
2. Load unpacked → Select directory again
3. Check Errors button if load fails

---

## 🔴 Failure Scenario 2: Content Script Not Running

### Symptoms
- No "✅ KYT: Fetch override installed" in console
- window.KYT_HEALTH_CHECK is undefined
- No API interception happening

### Root Causes
1. Content script injection failed
2. CSP (Content Security Policy) blocking
3. manifest.json host_permissions incorrect

### Debug Steps

```javascript
// Step 1: Check if content script injected
// In ChatGPT page console:
console.log('Content script check:', typeof window.KYT_HEALTH_CHECK);

// Expected: "function"
// If "undefined": Content script didn't load
```

### Solutions

**Solution A**: Hard refresh page
1. Clear cache: Ctrl+Shift+Delete → Clear browsing data
2. Hard reload: Ctrl+Shift+R
3. Check console for "KYT" messages

**Solution B**: Test on different ChatGPT URL
- Try chat.openai.com if using chatgpt.com
- Try chatgpt.com if using chat.openai.com
- One domain might have tighter security

---

## 🔴 Failure Scenario 3: No API Interceptions

### Symptoms
- Console shows "Fetch override installed" ✅
- BUT no "Intercepted ChatGPT API call" messages
- window.KYT_HEALTH_CHECK() shows totalInterceptions: 0

### Root Causes
1. ChatGPT changed API endpoint
2. Fetch override race condition
3. Using ChatGPT feature that doesn't use /backend-api/conversation

### Debug Steps

```javascript
// Step 1: Check actual API endpoint
// In ChatGPT page, open Network tab (F12 → Network)
// Filter: "Fetch/XHR"
// Send a message in ChatGPT
// Look for POST requests

// Expected: /backend-api/conversation
// If different: API endpoint changed!
```

```javascript
// Step 2: Test manual interception
const testUrl = 'https://chatgpt.com/backend-api/conversation';
const testOptions = {
  method: 'POST',
  body: JSON.stringify({
    messages: [{
      content: {parts: ['test']},
      author: {role: 'user'}
    }]
  })
};

// This should trigger console log if interception works
fetch(testUrl, testOptions).catch(() => {}); // Ignore fetch error
```

### Solutions

**Solution A**: API endpoint changed
```javascript
// If Network tab shows different endpoint (e.g., /v1/chat):
// Edit content.js line 94:
// Change: url.includes('/backend-api/conversation')
// To: url.includes('/NEW_ENDPOINT_HERE')
```

**Solution C**: Check ChatGPT mode
- Interception works for chat mode
- May NOT work for: DALL-E, GPTs, Canvas
- Test with simple text conversation first

---

## 🔴 Failure Scenario 4: Extraction Errors

### Symptoms
- API intercepted ✅
- BUT console shows "Failed to extract message"
- error_log in storage shows EXTRACTION_ERROR

### Root Causes
1. ChatGPT changed request body structure
2. Unexpected message format
3. Edge case handling missing

### Debug Steps

```javascript
// Step 1: Inspect actual request body
// In Network tab, find POST to /backend-api/conversation
// Click request → Payload tab → View source
// Copy entire JSON

// Paste in console to format:
JSON.parse('PASTE_REQUEST_BODY_HERE')
```

```javascript
// Step 2: Check error log details
chrome.storage.local.get(['error_log'], (result) => {
  const errors = result.error_log || [];
  console.log('Recent extraction errors:');
  console.table(errors.slice(-5)); // Last 5 errors
});
```

### Solutions

**Solution A**: Update extraction path
```javascript
// If request structure changed from:
//   message.content.parts[0]
// To (example):
//   message.text

// Edit content.js extractUserMessage() function:
let content = null;
if (lastMessage?.text) {
  content = lastMessage.text; // NEW path
} else if (lastMessage?.content?.parts?.[0]) {
  content = lastMessage.content.parts[0]; // OLD path
}
```

---

## 🔴 Failure Scenario 5: Storage Quota Exceeded

### Symptoms
- Console: "QuotaExceededError"
- Messages stop saving after certain count
- chrome.storage.local.set() fails

### Debug Steps

```javascript
// Step 1: Check storage usage
chrome.runtime.sendMessage({type: 'GET_STATS'}, (response) => {
  console.log('Storage stats:', response.stats);
  console.log('Usage:', response.stats.usagePercent + '%');
});

// Expected: < 80%
// If > 80%: Storage cleanup needed
```

### Solutions

**Solution A**: Clear old messages
```javascript
// Keep only last 100 messages
chrome.storage.local.get(['captured_messages'], (result) => {
  const messages = result.captured_messages || [];
  const trimmed = messages.slice(-100); // Last 100 only

  chrome.storage.local.set({captured_messages: trimmed}, () => {
    console.log(`Trimmed from ${messages.length} to ${trimmed.length} messages`);
  });
});
```

**Solution B**: Archive to file
```javascript
// Download messages as JSON, then clear storage
chrome.storage.local.get(['captured_messages'], (result) => {
  const messages = result.captured_messages || [];
  const json = JSON.stringify(messages, null, 2);
  const blob = new Blob([json], {type: 'application/json'});
  const url = URL.createObjectURL(blob);

  const a = document.createElement('a');
  a.href = url;
  a.download = `kyt_messages_${Date.now()}.json`;
  a.click();

  // Then clear storage
  chrome.storage.local.set({captured_messages: []});
});
```

---

## 🔴 Failure Scenario 6: Validation Tests Fail

### Per-Test Debugging

#### TEST 1: Storage Access FAILS
```javascript
// Error: "Cannot access chrome.storage"
// Solution: Run validation on ChatGPT page, NOT background page
// Validation script needs content script context
```

#### TEST 2: Minimum Message Count FAILS
```javascript
// Error: "Only 3/10 messages"
// Solution: Have more conversations!
// Or reduce threshold temporarily for testing:
// Edit verify_capture.js line 76: Change >= 10 to >= 3
```

#### TEST 3: Required Fields FAILS
```javascript
// Error: "Message X missing fields"
// Debug which field is missing:
chrome.storage.local.get(['captured_messages'], (result) => {
  const msg = result.captured_messages[0];
  console.log('First message structure:', Object.keys(msg));
});

// If missing 'role': Update extraction in content.js
// If missing 'timestamp': Update message creation
```

#### TEST 5: Sequential Timestamps FAILS
```javascript
// Error: "Timestamp out of order"
// This indicates race condition in storage

// Check if messages saved in wrong order:
chrome.storage.local.get(['captured_messages'], (result) => {
  const timestamps = result.captured_messages.map(m => m.timestamp);
  console.log('Timestamps:', timestamps);
  console.log('Sorted:', [...timestamps].sort((a,b) => a-b));
});

// Solution: Ensure background.js uses await on storage operations
```

#### TEST 6: Conversation IDs FAILS
```javascript
// Error: "Only 20% have conversation IDs"
// This means extraction is getting partial data

// Check if ChatGPT API structure changed:
// Network tab → Conversation request → Check for conversation_id field

// If field name changed: Update content.js extraction
```

---

## 📋 Full Diagnostic Checklist

Run this full diagnostic if multiple failures occur:

```javascript
// === KYT FULL DIAGNOSTIC ===

console.log('=== KYT FULL DIAGNOSTIC ===\n');

// 1. Extension loaded?
console.log('1. Extension loaded:', chrome.runtime?.id || 'NO');

// 2. Content script active?
console.log('2. Content script:', typeof window.KYT_HEALTH_CHECK);

// 3. Interception working?
const health = window.KYT_HEALTH_CHECK?.() || {};
console.log('3. Interceptions:', health.totalInterceptions || 0);
console.log('   Errors:', health.totalErrors || 0);
console.log('   Error rate:', health.errorRate || 'N/A');

// 4. Storage populated?
chrome.storage.local.get(['captured_messages', 'error_log'], (result) => {
  console.log('4. Messages in storage:', result.captured_messages?.length || 0);
  console.log('   Errors in log:', result.error_log?.length || 0);

  if (result.error_log?.length > 0) {
    console.log('   Recent errors:');
    console.table(result.error_log.slice(-3));
  }
});

// 5. Background worker responsive?
chrome.runtime.sendMessage({type: 'GET_STATS'}, (response) => {
  console.log('5. Background worker:', response?.success ? 'RESPONSIVE' : 'NOT RESPONDING');
  if (response?.stats) {
    console.log('   Storage usage:', response.stats.usagePercent + '%');
  }
});

console.log('\n=== END DIAGNOSTIC ===');
```

**Expected Output**:
```
1. Extension loaded: <extension-id>
2. Content script: function
3. Interceptions: 10
   Errors: 0
   Error rate: 0%
4. Messages in storage: 10
   Errors in log: 0
5. Background worker: RESPONSIVE
   Storage usage: 0.05%
```

---

## 🔧 Emergency Recovery

If all else fails, **nuclear option**:

```bash
# 1. Remove extension completely
# chrome://extensions → Remove "KYT Memory Extension"

# 2. Clear all extension data
# DevTools → Application → Storage → Clear site data

# 3. Restart Chrome completely
# Close ALL Chrome windows, reopen

# 4. Re-load extension fresh
cd /home/penguinzyue/kyt-validation-sprint
# chrome://extensions → Load unpacked → select directory

# 5. Re-run validation
# Open ChatGPT, have 10 conversations, run verify_capture.js
```

---

## 📞 When to Pivot

If after ALL debugging:
- ❌ ChatGPT changed API structure completely (requires rewrite)
- ❌ Chrome updated and broke Manifest V3 (requires Chrome downgrade)
- ❌ ChatGPT added anti-extension measures (requires fallback architecture)

**Pivot to Plan B**: Manual conversation export button

**Remember**: The goal is to prove the concept, not build a perfect extension. If API interception is fundamentally broken, the fallback (manual mode) is still a viable product.
