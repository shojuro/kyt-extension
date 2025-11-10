# KYT Memory Extension - Day 1 Validation Sprint

**Goal**: Prove automatic ChatGPT conversation capture via API interception works reliably.

**Status**: ✅ Code complete, ready for testing

---

## 🎯 Success Criteria

Day 1 is successful if:
- ✅ Extension intercepts 100% of ChatGPT API calls automatically
- ✅ Extracts structured JSON from request payloads
- ✅ Stores 10+ messages in chrome.storage.local
- ✅ All 8 validation tests pass (see validation/verify_capture.js)

---

## 📦 What's Included

```
kyt-validation-sprint/
├── manifest.json           # Chrome extension config (Manifest V3)
├── content.js              # Fetch override for API interception
├── background.js           # Service worker for storage management
├── validation/
│   └── verify_capture.js   # VTEST-compliant validation script (8 tests)
├── docs/
│   └── DEBUGGING.md        # Troubleshooting guide (failure scenarios)
├── .gitignore              # Security (CLAUDE.md compliant)
└── .env.example            # Template for Day 2+ credentials
```

---

## 🚀 Quick Start (3 Steps)

### Step 1: Load Extension in Chrome

```bash
# 1. Open Chrome
# 2. Navigate to: chrome://extensions
# 3. Enable "Developer mode" (top right toggle)
# 4. Click "Load unpacked"
# 5. Select this directory: /home/penguinzyue/kyt-validation-sprint
```

**Expected result**: Extension should appear with green "K" icon, status "Enabled"

---

### Step 2: Have 10 Conversations in ChatGPT

```bash
# 1. Open: https://chat.openai.com (or https://chatgpt.com)
# 2. Open DevTools: F12 or Ctrl+Shift+I
# 3. Go to Console tab
# 4. Look for: "✅ KYT: Fetch override installed successfully"
```

**Have at least 10 conversations with ChatGPT**. Example prompts:
1. "What is the capital of France?"
2. "Explain quantum computing in simple terms"
3. "Write a haiku about code"
4. "What's the best way to learn Python?"
5. "Tell me a joke"
6. "Summarize the history of the internet"
7. "What is machine learning?"
8. "Give me a recipe for chocolate chip cookies"
9. "Explain the difference between SQL and NoSQL"
10. "What are the benefits of exercise?"

**Watch for**:
- `🎯 KYT: Intercepted ChatGPT API call` (appears for each message)
- `✅ KYT: Message sent to background for storage`

---

### Step 3: Run Validation Tests

```bash
# In ChatGPT page's DevTools console:
# 1. Open the file: validation/verify_capture.js
# 2. Copy entire contents
# 3. Paste into Console
# 4. Press Enter
```

**Expected output**:
```
🔍 KYT Day 1 Validation: Starting...

--- TEST 1: Storage Access ---
✅ PASS: Storage accessible
   Found 10 messages in storage

--- TEST 2: Minimum Message Count (10+ required) ---
✅ PASS: At least 10 messages captured (found: 10)

... (8 total tests)

═════════════════════════════════════════
📊 DAY 1 VALIDATION SUMMARY
═════════════════════════════════════════
Total Tests: 8
✅ Passed: 8
❌ Failed: 0

🎉 ALL TESTS PASSED! DAY 1 VALIDATION SUCCESSFUL! 🎉

✅ API interception: WORKING
✅ Message extraction: WORKING
✅ Storage: WORKING
✅ Data integrity: VERIFIED

🚀 Ready to proceed to Day 2: Semantic Search with pgvector
```

---

## 🐛 Troubleshooting

### No "Fetch override installed" message

**Problem**: Content script not running

**Solutions**:
1. Refresh ChatGPT page (Ctrl+R)
2. Check extension is enabled: chrome://extensions
3. Check manifest.json has correct host_permissions
4. Hard reload: Ctrl+Shift+R

---

### No "Intercepted ChatGPT API call" messages

**Problem**: API endpoint changed or fetch override failed

**Solutions**:
1. Check ChatGPT API endpoint in Network tab (should be /backend-api/conversation)
2. Run health check: `window.KYT_HEALTH_CHECK()` in console
3. Check for errors in console (red messages)
4. See docs/DEBUGGING.md for detailed diagnostics

---

### Validation test fails

**Problem**: Data extraction or storage issues

**Solutions**:
1. Check which specific test failed (validation script shows details)
2. Inspect storage manually:
   ```javascript
   chrome.storage.local.get(['captured_messages'], console.log)
   ```
3. Check error log:
   ```javascript
   chrome.storage.local.get(['error_log'], console.log)
   ```
4. See docs/DEBUGGING.md for test-specific solutions

---

## 📊 Debug Commands

### Content Script Health Check

```javascript
// Run in ChatGPT page console
window.KYT_HEALTH_CHECK()

// Expected output:
{
  totalInterceptions: 10,
  totalErrors: 0,
  lastInterceptionTime: 1699564892123,
  timeSinceLastIntercept: 1234,
  errorRate: "0%"
}
```

---

### Background Worker Stats

```javascript
// Run in ChatGPT page console
chrome.runtime.sendMessage({type: 'GET_STATS'}, console.log)

// Expected output:
{
  success: true,
  stats: {
    totalMessages: 10,
    totalErrors: 0,
    storageSize: 4567,
    storageSizeKB: "4.46",
    storageLimitKB: "10240",
    usagePercent: "0.04",
    lastSaveTime: 1699564892123,
    timeSinceLastSave: 2345
  }
}
```

---

### Manual Storage Inspection

```javascript
// View all captured messages
chrome.storage.local.get(['captured_messages'], (result) => {
  console.log('Total messages:', result.captured_messages.length);
  console.table(result.captured_messages.slice(0, 5)); // Show first 5
});

// View error log
chrome.storage.local.get(['error_log'], (result) => {
  console.log('Total errors:', result.error_log?.length || 0);
  console.table(result.error_log);
});

// Clear storage (if needed)
chrome.storage.local.clear(() => {
  console.log('Storage cleared');
});
```

---

## ⚙️ Technical Architecture

### API Interception Flow

```
User types in ChatGPT
    ↓
ChatGPT web app calls fetch('/backend-api/conversation', {...})
    ↓
[content.js] Intercepts via window.fetch override
    ↓
Extracts: message.content.parts[0]
Extracts: message.author.role
Extracts: conversation_id, model, timestamp
    ↓
chrome.runtime.sendMessage({type: 'SAVE_MESSAGE', data: {...}})
    ↓
[background.js] Receives message
    ↓
Validates message structure
    ↓
Appends to chrome.storage.local['captured_messages']
    ↓
✅ Message saved, original fetch() continues to ChatGPT
```

---

### Key Design Decisions

1. **Fetch Override (not webRequest API)**
   - Manifest V3 compliant
   - Can modify request body dynamically
   - No permission warnings for users

2. **Content Script at document_start**
   - Runs BEFORE page JavaScript
   - Ensures fetch override installed early
   - Prevents race conditions

3. **Background Service Worker**
   - Centralizes storage operations
   - Avoids content script quota limits
   - Enables health monitoring via alarms

4. **Error Logging (not swallowing)**
   - Captures extraction failures
   - Tracks storage errors
   - Enables debugging in production

---

## 🔒 Security Compliance

✅ **CLAUDE.md Rule 5**: Security First
- .gitignore created FIRST
- No API keys in code (Day 1 doesn't use external APIs)
- .env.example template for Day 2+

✅ **CLAUDE.md Rule 1**: Show, Don't Tell
- Real validation tests (can actually fail)
- Error handling with actual error tracking
- No console.log theater

---

## 📅 Next Steps

After Day 1 validation passes:

**Day 2: Semantic Search with Supabase pgvector**
- Create Supabase schema with pgvector extension
- Implement embedding via text-embedding-3-small
- Test HNSW index retrieval (<500ms latency)

**Day 3: Invisible Context Injection**
- Modify fetch() payload before sending to ChatGPT
- Inject retrieved context into user message
- Verify ChatGPT receives enhanced prompt invisibly

---

## 📝 Git Workflow

```bash
# Current branch: main (production-ready)
git log --oneline -3

# Expected commits:
# 1792712 feat: Add Chrome extension core (API interception + storage)
# 2b8f78e Initial commit: Security foundation (.gitignore + .env.example)
```

**Branching strategy**:
- `main` = Always deployable, clean history
- Day 2 work will use: `git checkout -b feat/day2-semantic-search`

---

## 🎓 Learning Resources

- [Chrome Extensions Manifest V3](https://developer.chrome.com/docs/extensions/mv3/)
- [Fetch API Override Pattern](https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API)
- [chrome.storage API](https://developer.chrome.com/docs/extensions/reference/storage/)
- [Content Scripts](https://developer.chrome.com/docs/extensions/mv3/content_scripts/)

---

## 📞 Support

**Validation failing?** Check docs/DEBUGGING.md for detailed troubleshooting.

**API changed?** See "API Interception Fragility" section in docs/DEBUGGING.md.

**Questions?** Run debug commands above and inspect output.

---

**Project**: KYT Memory Extension Validation Sprint
**Goal**: Prove RAG (Retrieval-Augmented Generation) for ChatGPT memory
**Status**: Day 1 - Code complete, ready for testing
**Next**: Run validation, then proceed to Day 2
