# Quick Test Guide - WebSocket & Deduplication

**5-Minute Validation** | Created: 2025-11-17

---

## 🚀 Prerequisites (30 seconds)

1. **Reload Extension**:
   - Open `chrome://extensions`
   - Find "KYT Memory - Multi-Platform"
   - Click **Reload** button

2. **Open ChatGPT**:
   - Navigate to https://chatgpt.com
   - Open Chrome DevTools (F12)
   - Go to **Console** tab
   - Filter for "KYT" messages

---

## ✅ Test 1: Verify Extension Loaded (10 seconds)

**In Console, type**:
```javascript
window.KYT_HEALTH_CHECK()
```

**Expected Output**:
```javascript
{
  platform: "chatgpt",
  context: "PAGE_CONTEXT",
  totalInterceptions: 0,
  totalErrors: 0,
  lastInterceptionTime: [timestamp],
  timeSinceLastIntercept: [ms],
  errorRate: "N/A",
  domCaptureCount: 0
}
```

**✅ PASS**: Health check returns object
**❌ FAIL**: Undefined or error → Reload page and extension

---

## ✅ Test 2: Fetch Interception (Typed Messages) - 30 seconds

**Action**: Type and send a message in ChatGPT
- Example: "Testing typed message capture"

**Watch Console For**:
```
🎯 KYT ChatGPT: Intercepted API call
✅ KYT ChatGPT: Message extracted: Testing typed message capture...
📨 KYT ChatGPT Content: Received message from page context
   Content preview: Testing typed message capture...
   Capture method: fetch
🔄 KYT ChatGPT Content: Deduplication layer active
✅ KYT ChatGPT Content: Message forwarded to background
```

**✅ PASS**: All 5 log messages appear
**❌ FAIL**: Missing "Intercepted API call" → Fetch wrapper not loaded

---

## ✅ Test 3: WebSocket Interception (Voice Input) - 1 minute

**Action**: Use voice input in ChatGPT
1. Click microphone icon (or keyboard shortcut)
2. Say: "Testing voice capture one two three"
3. Wait for transcription to appear
4. Send the message

**Watch Console For**:
```
🎤 KYT ChatGPT: WebSocket intercepted (likely voice): wss://...
🎤 KYT ChatGPT: WebSocket opened
🎤 KYT ChatGPT: Voice transcript captured: Testing voice capture...
📨 KYT ChatGPT Content: Received message from page context
   Content preview: Testing voice capture one two three...
   Capture method: websocket
✅ KYT ChatGPT Content: Message forwarded to background
```

**✅ PASS**: WebSocket logs appear, captureMethod = "websocket"
**❌ FAIL**: No WebSocket logs → Voice endpoint pattern may have changed

**Note**: If you don't see WebSocket logs, voice might not be using WebSocket in your ChatGPT version. This is okay - fetch will still capture it.

---

## ✅ Test 4: Deduplication Check (30 seconds)

**Action**: Check deduplication statistics

**In Console, type**:
```javascript
window.KYT_Deduplicator.getStats()
```

**Expected Output**:
```javascript
{
  totalAttempts: 2,        // Number of capture attempts
  captured: 2,             // Unique messages captured
  duplicatesSkipped: 0,    // Duplicates prevented
  upgradeCaptures: 0,      // Higher-confidence upgrades
  mapSize: 2,              // Cache size (within 5s window)
  duplicateRate: "0.0%"    // Percentage of duplicates
}
```

**✅ PASS**: Stats object returned
**❌ FAIL**: Undefined → Deduplication layer not loaded

---

## ✅ Test 5: Database Verification (1 minute)

**Action**: Check Supabase for captured messages

1. Open Supabase SQL Editor
2. Run query:
   ```sql
   SELECT
     content,
     role,
     platform,
     created_at,
     TO_CHAR(created_at, 'HH24:MI:SS') as time
   FROM messages
   WHERE platform = 'chatgpt'
     AND created_at > NOW() - INTERVAL '5 minutes'
   ORDER BY created_at DESC
   LIMIT 10;
   ```

**Expected Results**:
- ✅ Both test messages appear (typed + voice)
- ✅ **NO DUPLICATES** (each message appears once)
- ✅ Timestamps within last 5 minutes
- ✅ Role = 'user' for both

**✅ PASS**: 2 unique messages in database
**❌ FAIL**: Duplicates or missing messages → Check background.js errors

---

## ✅ Test 6: Deduplication Prevention (2 minutes)

**Test Scenario**: Send same message twice quickly

**Action**:
1. Type message: "Duplicate test alpha"
2. Send it
3. **Immediately** type same message again: "Duplicate test alpha"
4. Send it (within 5 seconds of first)

**Watch Console For Second Message**:
```
🎯 KYT ChatGPT: Intercepted API call
✅ KYT ChatGPT: Message extracted: Duplicate test alpha...
📨 KYT ChatGPT Content: Received message from page context
⏭️ KYT ChatGPT Content: Duplicate message skipped by deduplicator
```

**Key Indicator**: "Duplicate message skipped" appears

**Verify in Supabase**:
```sql
SELECT content, COUNT(*) as count
FROM messages
WHERE content LIKE '%Duplicate test alpha%'
  AND created_at > NOW() - INTERVAL '5 minutes'
GROUP BY content;
```

**Expected**: COUNT = 1 (only first message saved)

**✅ PASS**: Only 1 database entry, second skipped
**❌ FAIL**: 2 entries in database → Deduplication not working

---

## 🎯 Quick Results Summary

| Test | Status | Time |
|------|--------|------|
| 1. Extension Loaded | ☐ PASS / ☐ FAIL | 10s |
| 2. Fetch Interception | ☐ PASS / ☐ FAIL | 30s |
| 3. WebSocket Interception | ☐ PASS / ☐ FAIL / ☐ SKIP | 1m |
| 4. Deduplication Stats | ☐ PASS / ☐ FAIL | 30s |
| 5. Database Verification | ☐ PASS / ☐ FAIL | 1m |
| 6. Deduplication Prevention | ☐ PASS / ☐ FAIL | 2m |

**Total Time**: ~5 minutes

---

## 🚨 Troubleshooting

### No "KYT" logs in console
**Fix**:
1. Reload ChatGPT page
2. Reload extension
3. Hard refresh (Ctrl+Shift+R)

### "Extension context invalidated" warning
**Fix**: Reload ChatGPT page (extension was reloaded while page open)

### Deduplicator undefined
**Fix**:
1. Check manifest.json: deduplication.js before content.js
2. Reload extension
3. Clear browser cache

### No WebSocket logs for voice
**Possible**: ChatGPT may not use WebSocket in your version/region. Fetch will still capture the message after transcription completes. This is okay.

### Messages not in Supabase
**Fix**:
1. Check background.js console (right-click extension → Inspect)
2. Verify Supabase credentials in background.js
3. Check database permissions

---

## ✅ Success Criteria

**All systems working if**:
- ✅ Health check returns object
- ✅ Typed messages captured (fetch)
- ✅ Voice messages captured (WebSocket or fetch)
- ✅ Deduplication stats available
- ✅ Messages in Supabase (no duplicates)
- ✅ Duplicate messages skipped within 5s window

**Ready for beta if all 6 tests pass!**

---

## 📝 Report Template

```
Test Date: [Date]
Chrome Version: [Version]
ChatGPT Voice Available: Yes / No

Test 1 (Extension Loaded): PASS / FAIL
Test 2 (Fetch): PASS / FAIL
Test 3 (WebSocket): PASS / FAIL / SKIP
Test 4 (Dedupe Stats): PASS / FAIL
Test 5 (Database): PASS / FAIL
Test 6 (Dedupe Prevention): PASS / FAIL

Issues Found:
- [Issue 1]
- [Issue 2]

Overall: PASS / FAIL
```

---

**Next**: Run these 6 tests, then proceed to comprehensive validation in `TEST_WEBSOCKET_DEDUPLICATION.md`
