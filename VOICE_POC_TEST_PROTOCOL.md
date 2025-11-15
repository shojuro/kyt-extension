# Voice Capture PoC - Test Protocol

**Date**: 2025-11-15
**Implementation**: DOM-Based Observer (Fragile PoC)
**Status**: Ready for Testing

---

## 🎯 What Was Implemented

### Root Cause Discovery
- **Voice input uses WebSocket**: `wss://ws.chatgpt.com/ws/user/...`
- **NOT HTTP fetch/XHR**: Existing fetch wrapper cannot intercept WebSocket traffic
- **Solution**: DOM-based MutationObserver watches for text nodes added to page

### Implementation Details (`platforms/chatgpt/inject.js` lines 499-638)

**Key Features:**
- ✅ Watches entire document for DOM mutations
- ✅ Extracts text from new nodes
- ✅ Infers message role (user/assistant) from:
  - Aria labels (most stable)
  - Data attributes
  - Content patterns
- ✅ Filters out UI noise (buttons, timestamps, bullets)
- ✅ Uses same event mechanism as fetch interception
- ✅ Reuses existing Supabase upload pipeline (no changes needed)

**Fragility Warnings:**
- ⚠️ DOM structure dependent
- ⚠️ May capture duplicate text during streaming
- ⚠️ Role inference can be uncertain (marked with confidence level)
- ⚠️ Breaks if ChatGPT changes HTML structure

---

## 🧪 Test Protocol

### Test #1: Extension Loading
**Goal**: Verify DOM observer initializes correctly

1. **Reload ChatGPT** (https://chat.openai.com)
2. **Open Console** (F12)
3. **Wait 3+ seconds** (observer has delayed start to avoid capturing conversation history)
4. **Look for initialization logs:**
   ```
   🚀 KYT ChatGPT Inject: Initializing in page context...
   ✅ KYT ChatGPT: Fetch override installed in PAGE CONTEXT
   ✅ KYT ChatGPT: DOM observer active for voice input
   👁️ KYT ChatGPT: DOM observer initialized for voice capture (delayed start to avoid history)
   ```

**Expected:**
- ✅ All 4 logs appear
- ✅ Observer initialization happens ~3 seconds after page load (delayed to filter noise)
- ✅ No errors

**If Failed:**
- Extension may not be loaded
- Check chrome://extensions
- Reload extension

---

### Test #2: Text Input Baseline (Still Works)
**Goal**: Verify existing text capture isn't broken by DOM observer

1. **Type a message**: "Test text input"
2. **Press Enter**
3. **Check console:**
   ```
   🎯 KYT ChatGPT: Intercepted API call
   ✅ KYT ChatGPT: Message extracted
   📝 Content: Test text input
   ```

**Expected:**
- ✅ Fetch interception logs appear
- ✅ Message sent to Supabase
- ✅ No regression on existing functionality

**If Failed:**
- Critical regression - fetch wrapper broken
- Investigate inject.js syntax errors

---

### Test #3: Voice Input Capture (NEW)
**Goal**: Verify voice input is captured via DOM observer

1. **Click microphone icon** 🎤
2. **Speak clearly**: "Hello world, this is a voice test"
3. **Wait for transcription** to appear
4. **Submit** (or auto-submit if enabled)
5. **Check console immediately:**
   ```
   🧠 KYT ChatGPT DOM: USER message captured (34 chars)
   📝 Preview: Hello world, this is a voice test
   ```

**Expected:**
- ✅ DOM capture log appears
- ✅ Message length matches transcription
- ✅ Preview shows correct text
- ✅ Role detected as "USER"

**If Failed:**
- DOM observer may not be catching the right nodes
- Check: Does text appear in UI?
- Try voice input again (sometimes first message is missed)

---

### Test #4: Assistant Response Capture
**Goal**: Verify assistant responses are captured

1. **Wait for ChatGPT response** to voice input
2. **Watch console as response streams:**
   ```
   🧠 KYT ChatGPT DOM: ASSISTANT message captured (156 chars)
   📝 Preview: Hello! I'm here and ready to help...
   ```

**Expected:**
- ✅ Assistant message captured
- ✅ Role detected as "ASSISTANT"
- ✅ Full response text captured (not truncated)

**If Failed:**
- DOM observer may be missing assistant nodes
- May capture in chunks (streaming) - this is OK for PoC
- Check if text appears in UI

---

### Test #5: Supabase Verification
**Goal**: Verify voice messages stored in database

1. **Open Supabase** (your project dashboard)
2. **Go to SQL Editor**
3. **Run query:**
   ```sql
   SELECT
     content,
     role,
     platform,
     timestamp,
     created_at
   FROM captured_messages
   WHERE platform = 'chatgpt'
   ORDER BY timestamp DESC
   LIMIT 10;
   ```

**Expected:**
- ✅ Voice test message appears
- ✅ Content matches transcription
- ✅ Role = 'user' or 'assistant'
- ✅ Timestamp is recent

**If Failed:**
- Content script may not be forwarding events
- Check background service worker logs
- Verify Supabase credentials in .env

---

### Test #6: Health Check
**Goal**: Verify DOM capture statistics tracking

1. **In console, run:**
   ```javascript
   window.KYT_HEALTH_CHECK()
   ```

2. **Check output:**
   ```javascript
   {
     platform: 'chatgpt',
     context: 'PAGE_CONTEXT',
     totalInterceptions: 1,  // Fetch-based captures
     domCaptureCount: 2,     // DOM-based captures (NEW)
     ...
   }
   ```

**Expected:**
- ✅ `domCaptureCount` increases with each voice message
- ✅ `totalInterceptions` still tracks fetch-based captures
- ✅ Both methods working in parallel

---

### Test #7: Voice-Then-Edit Scenario
**Goal**: Verify edited transcriptions are captured correctly

1. **Voice input**: "Hello world"
2. **Edit transcription**: "Hello world and how are you"
3. **Submit**
4. **Check console:**
   ```
   🧠 KYT ChatGPT DOM: USER message captured (28 chars)
   📝 Preview: Hello world and how are you
   ```

**Expected:**
- ✅ Captures EDITED text (not original transcription)
- ✅ Full edit preserved

**If Failed:**
- May be capturing mid-edit
- This is expected PoC limitation - note for brainstorming

---

### Test #8: Duplicate Detection
**Goal**: Verify same node isn't captured multiple times

1. **Send voice message**
2. **Wait for response**
3. **Scroll up/down** (may trigger re-renders)
4. **Check console:**
   - Should NOT see duplicate captures of same text

**Expected:**
- ✅ `seenNodes` WeakSet prevents duplicates
- ✅ Each message captured only once

**If Failed:**
- Check if `seenNodes.add()` is being called
- May need to strengthen duplicate detection

---

## 📊 Success Criteria

### Minimum Viable PoC (Must Pass All):
- ✅ Extension loads without errors
- ✅ Text input still works (no regression)
- ✅ Voice input captured via DOM observer
- ✅ Assistant responses captured
- ✅ Messages appear in Supabase
- ✅ Health check shows `domCaptureCount > 0`

### Known Limitations (Expected):
- ⚠️ May capture in multiple chunks during streaming
- ⚠️ Role inference may be "unknown" sometimes
- ⚠️ DOM structure changes will break capture
- ⚠️ No WebSocket interception (future enhancement)

---

## 🐛 Troubleshooting

### No DOM Capture Logs
**Symptoms**: No `🧠 KYT ChatGPT DOM:` logs appear

**Possible Causes:**
1. DOM observer not initialized
   - Check: `👁️ KYT ChatGPT: DOM observer initialized` log
   - Fix: Reload page
2. Text nodes not matching filters
   - Check: Does text appear in UI?
   - Debug: Temporarily lower `text.length < 10` threshold
3. Voice input using different mechanism
   - Investigate: What HTML elements are added during voice input?

**Debug Steps:**
```javascript
// In console, check if observer is running:
window.KYT_HEALTH_CHECK()

// Should show domCaptureCount
```

---

### Capturing Too Much Noise
**Symptoms**: Every UI update triggers capture

**Possible Causes:**
- `ignorePatterns` not filtering enough
- `text.length < 10` threshold too low

**Fix:**
- Increase minimum length: `text.length < 20`
- Add more ignore patterns

---

### Role Inference Wrong
**Symptoms**: User messages marked as "assistant" or vice versa

**Possible Causes:**
- Aria labels changed
- Data attributes missing
- Content heuristics failing

**Debug:**
```javascript
// Check what attributes are available:
document.querySelector('[aria-label*="user"]')
document.querySelector('[data-author="user"]')
```

**Fix:**
- Update `inferMessageRole()` patterns
- This is expected limitation of DOM-based approach

---

### Messages Not in Supabase
**Symptoms**: Console shows capture but database is empty

**Possible Causes:**
1. Content script not receiving events
   - Check: Background service worker logs
2. Supabase credentials missing
   - Check: `.env` file has `SUPABASE_URL` and `SUPABASE_ANON_KEY`
3. Network error
   - Check: Browser console "Network" tab for Supabase API errors

**Debug:**
```javascript
// In background service worker console:
// Should show messages being forwarded to Supabase
```

---

## 📝 Test Results Template

After completing tests, fill out:

### Test Results Summary

**Date**: ____________
**Tester**: ____________
**ChatGPT Account**: ____________

#### Test #1: Extension Loading
- [ ] PASS - All initialization logs appeared
- [ ] FAIL - Missing logs: ___________

#### Test #2: Text Input Baseline
- [ ] PASS - Text input still works
- [ ] FAIL - Regression detected: ___________

#### Test #3: Voice Input Capture
- [ ] PASS - Voice captured via DOM
- [ ] FAIL - No DOM capture logs

#### Test #4: Assistant Response Capture
- [ ] PASS - Assistant responses captured
- [ ] FAIL - Responses not captured

#### Test #5: Supabase Verification
- [ ] PASS - Messages in database
- [ ] FAIL - Database empty

#### Test #6: Health Check
- [ ] PASS - `domCaptureCount` tracking works
- [ ] FAIL - Health check broken

#### Test #7: Voice-Then-Edit
- [ ] PASS - Edited text captured
- [ ] FAIL - Original transcription captured

#### Test #8: Duplicate Detection
- [ ] PASS - No duplicates
- [ ] FAIL - Same message captured multiple times

---

### Issues Encountered

1. ___________________________________________
2. ___________________________________________
3. ___________________________________________

---

### Screenshots

Attach:
1. Console logs showing DOM capture
2. Supabase query results
3. Health check output

---

## ⏭️ Next Steps After Testing

Based on test results:

### If ALL Tests Pass:
1. ✅ PoC validated - DOM capture works
2. Move to brainstorming robust solutions
3. Document fragility concerns
4. Plan migration to WebSocket interception

### If Tests Fail:
1. Document failure mode
2. Debug specific issue
3. Adjust implementation
4. Retest

---

**Ready to test? Load the extension and follow the protocol above.**
