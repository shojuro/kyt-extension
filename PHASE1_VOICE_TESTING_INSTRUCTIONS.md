# Phase 1: Voice Input Testing Instructions

**Status**: Ready to Execute
**Duration**: ~30 minutes
**Requirements**: ChatGPT Plus, Chrome Browser, KYT Extension Loaded

---

## ⚠️ IMPORTANT: DO THIS NOW

This is a **MANUAL TESTING PHASE** that requires YOU (the user) to interact with ChatGPT's voice input feature while I observe the results.

---

## Step-by-Step Testing Protocol

### Step 1: Environment Setup (2 minutes)

1. **Open ChatGPT** in Chrome: https://chat.openai.com
2. **Verify KYT extension is loaded:**
   - Open browser console (F12 or Ctrl+Shift+J)
   - Look for: `🚀 KYT ChatGPT Inject: Initializing in page context...`
   - If not found, reload the page

3. **Open Network Tab:**
   - DevTools → Network tab
   - Click "Preserve log" checkbox ✓
   - Clear existing logs (trash icon)

4. **Confirm voice feature available:**
   - Look for microphone icon in chat input area
   - If not visible, voice input may not be enabled

---

### Step 2: Baseline Text Input (Control Test - 3 minutes)

**Purpose**: Establish what "normal" text input looks like

1. **Type a text message** (keyboard): "This is a baseline text test"
2. **Press Enter** to submit
3. **In Network tab, find the request:**
   - Look for: `conversation` or `backend-api`
   - Click on it
   - Go to "Payload" or "Request" tab
   - **COPY the entire request body** (right-click → Copy)
4. **Paste request body here** (in console or save to file):
   ```
   [You will paste this in a moment]
   ```

5. **In Console tab, verify logs:**
   ```
   Expected logs:
   🎯 KYT ChatGPT: Intercepted API call
   ✅ KYT ChatGPT: Message extracted
   📝 Content: This is a baseline text test
   ```

6. **Take screenshot** of console logs

---

### Step 3: Voice Input Test #1 - Basic Capture (5 minutes)

**Purpose**: See if voice input is captured by existing code

1. **Clear console** (right-click → Clear console)
2. **Clear network log** (trash icon in Network tab)
3. **Click microphone icon** in ChatGPT
4. **Speak clearly**: "Hello world, this is a voice input test"
5. **Wait for transcription** to appear
6. **Observe transcription accuracy** (note any differences)
7. **Press Enter** or wait for auto-submit
8. **Immediately check console:**
   ```
   Look for:
   🎯 KYT ChatGPT: Intercepted API call
   ✅ KYT ChatGPT: Message extracted
   📝 Content: [should show your voice transcription]
   ```

9. **In Network tab, find the request:**
   - Look for: `conversation` or `backend-api` call
   - **IMPORTANT**: Note the URL (is it the SAME as text input?)
   - Click on request → Payload tab
   - **COPY the entire request body**

10. **Compare URLs:**
    - Text input URL: ______________________
    - Voice input URL: ______________________
    - **SAME or DIFFERENT?** _______________

11. **Take screenshots:**
    - Console logs
    - Network request details
    - Request payload

---

### Step 4: Voice Input Test #2 - Edit Before Submit (5 minutes)

**Purpose**: Test voice-then-edit scenario

1. **Clear console and network logs**
2. **Click microphone icon**
3. **Speak**: "Hello world"
4. **Wait for transcription** to appear in textarea
5. **IMPORTANT: Edit the text** (keyboard) to: "Hello world and how are you"
6. **Press Enter** to submit
7. **Check console logs:**
   ```
   Expected:
   🎯 Intercepted API call
   ✅ Message extracted
   📝 Content: Hello world and how are you  ← Should show EDITED text, not original
   ```

8. **Verify**: Does captured content include your edit?
   - [ ] YES - Captures edited text ✅
   - [ ] NO - Captures only transcription ❌

9. **Take screenshot** of console showing edited content

---

### Step 5: Voice Input Test #3 - Auto-Submit (if available - 5 minutes)

**Purpose**: Test voice auto-submit scenario

1. **Check ChatGPT settings** for auto-submit voice option
   - Settings → Voice → Auto-submit (if available)
   - Enable if found

2. **If auto-submit is available:**
   - Clear console and network logs
   - Click microphone
   - Speak: "What is the weather today"
   - **DO NOT manually submit** (should auto-send)
   - Check console logs
   - Verify capture

3. **If auto-submit NOT available:**
   - Note: "Auto-submit not found in settings"
   - Skip this test

---

### Step 6: Request Payload Comparison (5 minutes)

**Purpose**: Identify any differences between text and voice requests

**You should now have 2 request payloads copied:**
1. Baseline text input request
2. Voice input request

**Compare them side-by-side:**

**Questions to answer:**

1. **Same endpoint URL?**
   - [ ] YES - Both use `/backend-api/conversation`
   - [ ] NO - Voice uses: _______________________

2. **Same JSON structure?**
   - [ ] YES - Identical structure
   - [ ] NO - Differences noted below

3. **Voice-specific fields detected?**
   - [ ] `inputMethod: "voice"`
   - [ ] `source: "whisper"`
   - [ ] `audioTranscription: {...}`
   - [ ] `transcriptionConfidence: X.XX`
   - [ ] `wasEdited: true/false`
   - [ ] Other: _______________________
   - [ ] NONE - Completely identical

4. **Content extraction path same?**
   - Text: `body.messages[last].content.parts[0]`
   - Voice: `body._______________` (fill in if different)

---

### Step 7: Supabase Verification (5 minutes)

**Purpose**: Confirm voice messages are stored in database

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
   ORDER BY timestamp DESC
   LIMIT 10;
   ```

4. **Verify:**
   - [ ] Voice test message appears
   - [ ] Content matches transcription
   - [ ] Timestamp is recent
   - [ ] Platform = 'chatgpt'

5. **Take screenshot** of query results

---

## 📝 Research Results Summary

After completing all tests, fill out these key findings:

### Finding #1: Does Existing Code Capture Voice Input?

☐ **YES** - Existing code works perfectly, no changes needed
☐ **NO** - Changes required (specify below)

**Evidence:**
- Console logs showed interception: ☐ YES ☐ NO
- Message extracted correctly: ☐ YES ☐ NO
- Supabase contains voice message: ☐ YES ☐ NO

---

### Finding #2: Endpoint Analysis

**Text input endpoint:**
```
[Paste URL]
```

**Voice input endpoint:**
```
[Paste URL]
```

**Conclusion:**
- ☐ SAME - No code changes needed
- ☐ DIFFERENT - Endpoint addition required

---

### Finding #3: Request Format Analysis

**Text input format:**
```json
[Paste relevant fields]
```

**Voice input format:**
```json
[Paste relevant fields]
```

**Differences found:**
- ☐ NONE - Identical format
- ☐ Additional fields (list): _____________
- ☐ Different structure (describe): _____________

---

### Finding #4: Edge Case Testing

**Voice-then-edit scenario:**
- Edited text captured correctly: ☐ YES ☐ NO

**Auto-submit scenario:**
- Feature available: ☐ YES ☐ NO
- Capture worked: ☐ YES ☐ NO ☐ N/A

---

## 🎯 Implementation Recommendation

Based on your findings above, recommend:

☐ **Phase 2A** - No changes needed (existing code works)
☐ **Phase 2B** - Endpoint addition required (minor change)
☐ **Phase 2C** - Format parsing required (moderate change)

**Estimated effort:** _____ hours

---

## 📎 Deliverables to Provide

After completing testing, provide:

1. **Console log screenshots** (at least 3):
   - Baseline text input
   - Voice input basic
   - Voice input with edit

2. **Network request payloads** (at least 2):
   - Text input request body (JSON)
   - Voice input request body (JSON)

3. **Supabase query screenshot**:
   - Showing voice message in database

4. **Filled out findings** (from summary above)

---

## ⏭️ What Happens Next

Based on your test results, I will:

1. **Analyze findings** (5 minutes)
2. **Update VOICE_RESEARCH_RESULTS.md** with actual data
3. **Determine implementation path** (2A, 2B, or 2C)
4. **Implement required changes** (if any)
5. **Run comprehensive test suite**
6. **Commit with proper CHANGELOG** (following CLAUDE.md)

---

## ❓ Questions During Testing?

If you encounter any issues:
- Can't find microphone icon → Voice may not be enabled
- No console logs → Extension may not be loaded (reload page)
- Network tab empty → "Preserve log" may not be checked
- Transcription errors → That's OK, we're testing capture, not accuracy

---

**Ready to start testing? Let me know when you've completed the tests and have the data to share!**
