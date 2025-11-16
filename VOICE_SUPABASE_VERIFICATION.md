# Voice Capture → Supabase Verification Guide

**Date**: 2025-11-15
**Status**: Noise filters implemented, ready for Supabase connectivity test
**Goal**: Verify DOM-captured voice messages are stored in database

---

## 🎯 Quick Test (5 minutes)

### 1. Reload Extension with New Filters
1. **Open ChatGPT**: https://chat.openai.com
2. **Open Console** (F12)
3. **Wait 5 seconds** (observer has 3-second delay + page load)
4. **Verify initialization**:
   ```
   👁️ KYT ChatGPT: DOM observer initialized for voice capture (delayed start to avoid history)
   ```

### 2. Perform Voice Input
1. **Click microphone** 🎤
2. **Speak clearly**: "This is a test of the voice capture system with noise filtering enabled"
3. **Wait for transcription**
4. **Submit** (or auto-submit)

### 3. Check Console for Capture
**Expected** (with NEW filters):
```
🧠 KYT ChatGPT DOM: USER message captured (75 chars)
📝 Preview: This is a test of the voice capture system with noise filtering enabled
```

**NOT Expected** (filtered out):
- ❌ No "DictateDictate" (too short, 15 chars)
- ❌ No JavaScript code snippets
- ❌ No 104,918 char conversation history blobs
- ❌ No tiny UI fragments

### 4. Verify Supabase Storage
1. **Open Supabase Dashboard**: https://supabase.com/dashboard
2. **Go to SQL Editor**
3. **Run query**:
```sql
SELECT
  content,
  role,
  platform,
  capture_method,
  timestamp,
  created_at
FROM captured_messages
WHERE platform = 'chatgpt'
  AND created_at > NOW() - INTERVAL '10 minutes'
ORDER BY timestamp DESC
LIMIT 10;
```

**Expected Results**:
- ✅ Voice message appears: "This is a test of the voice capture..."
- ✅ `role` = 'user' or 'assistant'
- ✅ `platform` = 'chatgpt'
- ✅ `capture_method` = 'dom_observer' (NEW field showing how it was captured)
- ✅ `timestamp` is recent (within last 10 minutes)

**If NOT in Database**:
- Check background service worker console (F12 → Service Workers)
- Look for: `📤 KYT: Sending message to Supabase`
- Check for errors: `❌ KYT: Failed to upload`

---

## 📊 Expected Improvements from Noise Filtering

### Before Filtering (User's Test)
```
🧠 KYT ChatGPT DOM: UNKNOWN message captured (17 chars)
📝 Preview: OriginalWebSocket...

🧠 KYT ChatGPT DOM: UNKNOWN message captured (104918 chars)
📝 Preview: You said:Hello, world.ChatGPT said:Hello, world...

🧠 KYT ChatGPT DOM: UNKNOWN message captured (15 chars)
📝 Preview: DictateDictate...
```

### After Filtering (Expected Now)
```
🧠 KYT ChatGPT DOM: USER message captured (75 chars)
📝 Preview: This is a test of the voice capture system with noise filtering enabled

⚠️ KYT ChatGPT DOM: Skipping oversized text (104918 chars) - likely conversation history
```

**Key Differences**:
- ✅ Only substantial messages (100+ chars) captured
- ✅ Code blocks filtered out
- ✅ Oversized blobs explicitly skipped with warning
- ✅ No UI noise ("DictateDictate", JavaScript snippets)

---

## 🔍 Health Check Verification

After voice input, run in console:
```javascript
window.KYT_HEALTH_CHECK()
```

**Expected Output**:
```javascript
{
  platform: 'chatgpt',
  context: 'PAGE_CONTEXT',
  totalInterceptions: 1,      // Fetch-based captures (text input)
  domCaptureCount: 2,         // DOM-based captures (voice input)
  totalErrors: 0,
  errorRate: '0.0%'
}
```

**What This Tells You**:
- `domCaptureCount > 0` → Voice capture is working
- `totalInterceptions > 0` → Text capture still works (no regression)
- Both methods working in parallel ✓

---

## ✅ Success Criteria

**Voice Capture Working**:
- ✅ Console shows `🧠 KYT ChatGPT DOM:` log for voice message
- ✅ Message length is 100+ chars (filters working)
- ✅ NO noise captures (no code snippets, no "DictateDictate")
- ✅ `domCaptureCount` increases in health check

**Supabase Connectivity Working**:
- ✅ Message appears in database within 10 seconds
- ✅ `capture_method` = 'dom_observer'
- ✅ Content matches what was spoken
- ✅ No errors in background service worker

**Both Working** = PoC Validated ✓

---

## 🐛 Troubleshooting

### Voice Captured BUT Not in Supabase

**Check Background Service Worker**:
1. Open Extensions page (chrome://extensions)
2. Find "KYT Memory Extension"
3. Click "Service worker" link
4. Look for logs:
   ```
   📤 KYT: Sending message to Supabase
   ✅ KYT: Message uploaded successfully
   ```

**If No Logs**:
- Content script may not be forwarding events
- Check: `platforms/chatgpt/content.js` listeners

**If Error Logs**:
- Check Supabase credentials in `.env`
- Verify `SUPABASE_URL` and `SUPABASE_ANON_KEY`
- Test Supabase connection manually

### Still Seeing Noise Captures

**If "DictateDictate" Still Appears**:
- Check: Extension was reloaded after code changes
- Verify: Console shows "(delayed start to avoid history)" message
- Test: Wait 5+ seconds after page load before speaking

**If Oversized Blobs Still Captured**:
- Check: `text.length > 10000` filter is active
- Look for: Warning log "Skipping oversized text"
- If missing: Syntax error in inject.js

### Messages Too Short Being Filtered

**If Real Messages Missing**:
- Check message length (must be 100+ chars for PoC)
- Short test like "Hello" won't be captured (by design)
- Use longer messages: "Testing, testing, one, two, three, four, five, six, seven, eight, nine, ten"

---

## 📝 Test Results Template

**Date**: ___________
**Tester**: ___________

### Noise Filtering
- [ ] PASS - No "DictateDictate" noise
- [ ] PASS - No JavaScript snippets
- [ ] PASS - No 100k+ char history blobs
- [ ] FAIL - Still seeing: ___________

### Voice Capture
- [ ] PASS - Voice message captured (100+ chars)
- [ ] PASS - Console shows DOM capture log
- [ ] PASS - Health check shows domCaptureCount > 0
- [ ] FAIL - Issue: ___________

### Supabase Connectivity
- [ ] PASS - Message in database within 10 seconds
- [ ] PASS - capture_method = 'dom_observer'
- [ ] PASS - Content matches transcription
- [ ] FAIL - Issue: ___________

---

## ⏭️ Next Steps

### If ALL Tests Pass
✅ **PoC Validated** - Voice capture + Supabase connectivity working
✅ **Noise filters effective** - Signal-to-noise ratio acceptable
→ Move to brainstorming robust solutions (WebSocket interception)

### If Supabase Issues
❌ Debug background service worker
❌ Verify credentials
❌ Test content script event forwarding
→ Fix before moving to Phase 2

---

**Ready to test? Reload the extension and follow the steps above.**
