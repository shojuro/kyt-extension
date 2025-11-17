# WebSocket & Deduplication Testing Procedures

**Created**: 2025-11-17
**Purpose**: Validate comprehensive hybrid capture approach (WebSocket + Fetch + DOM)
**Status**: Ready for manual testing

---

## Prerequisites

1. Chrome extension loaded in `chrome://extensions`
2. Extension reloaded after code changes
3. Supabase credentials configured in background.js
4. ChatGPT account (for voice testing)

---

## Test 1: WebSocket Voice Input Capture

**Objective**: Verify WebSocket interception captures voice transcripts

### Setup
1. Open ChatGPT: https://chatgpt.com
2. Open Chrome DevTools (F12) → Console tab
3. Filter console for "KYT" logs

### Test Procedure
1. **Start voice input**:
   - Click microphone icon in ChatGPT input box
   - Or use keyboard shortcut (if enabled)

2. **Speak a test message**:
   - Say: "Testing voice capture, one two three"
   - Wait for transcription to appear

3. **Check console logs**:
   ```
   Expected logs:
   🎤 KYT ChatGPT: WebSocket intercepted (likely voice): wss://...
   🎤 KYT ChatGPT: WebSocket opened
   🎤 KYT ChatGPT: Voice transcript captured: Testing voice capture...
   📨 KYT ChatGPT Content: Received message from page context
      Content preview: Testing voice capture, one two three...
      Capture method: websocket
   ✅ KYT ChatGPT Content: Message forwarded to background
   ```

4. **Verify in Supabase**:
   - Open Supabase SQL Editor
   - Run query:
     ```sql
     SELECT content, role, platform, created_at
     FROM messages
     WHERE platform = 'chatgpt'
     ORDER BY created_at DESC
     LIMIT 5;
     ```
   - Confirm voice message appears with content "Testing voice capture, one two three"

### Success Criteria
✅ WebSocket connection intercepted
✅ Voice transcript captured in console
✅ Message forwarded to background
✅ Message saved to Supabase database
✅ No duplicate entries in database

---

## Test 2: Fetch Text Input Capture (Baseline)

**Objective**: Verify existing fetch interception still works

### Test Procedure
1. **Type a test message**:
   - In ChatGPT input box, type: "Testing typed message capture"
   - Press Enter or click Send

2. **Check console logs**:
   ```
   Expected logs:
   🎯 KYT ChatGPT: Intercepted API call
   ✅ KYT ChatGPT: Message extracted: Testing typed message capture...
   📨 KYT ChatGPT Content: Received message from page context
      Content preview: Testing typed message capture...
      Capture method: fetch
   ✅ KYT ChatGPT Content: Message forwarded to background
   ```

3. **Verify in Supabase** (same query as above)

### Success Criteria
✅ Fetch interception active
✅ Message captured and saved
✅ No duplicate entries

---

## Test 3: Deduplication - Same Message from Multiple Sources

**Objective**: Verify deduplicator prevents duplicates when same message captured by multiple methods

### Test Procedure

#### Scenario A: Voice → Fetch Duplicate
1. **Send voice message**: "Test deduplication alpha"
2. **Immediately type same message**: "Test deduplication alpha"
3. **Check console logs**:
   ```
   Expected logs:
   🎤 KYT ChatGPT: Voice transcript captured: Test deduplication alpha...
   📨 KYT ChatGPT Content: Received message from page context
   🔄 KYT ChatGPT Content: Deduplication layer active
   ✅ KYT ChatGPT Content: Message forwarded to background

   (30 seconds later, typed message)
   🎯 KYT ChatGPT: Intercepted API call
   ✅ KYT ChatGPT: Message extracted: Test deduplication alpha...
   📨 KYT ChatGPT Content: Received message from page context
   ⏭️ KYT ChatGPT Content: Duplicate message skipped by deduplicator
   ```

4. **Verify in Supabase**: Only ONE entry for "Test deduplication alpha"

#### Scenario B: Fetch → Voice Duplicate
1. **Type message first**: "Test deduplication beta"
2. **Then send same via voice**: "Test deduplication beta"
3. **Check for deduplication logs** (same as Scenario A)
4. **Verify in Supabase**: Only ONE entry

### Success Criteria
✅ First capture (higher confidence) saved
✅ Duplicate capture (lower/equal confidence) skipped
✅ Deduplication logs visible in console
✅ Only 1 database entry per unique message
✅ No data loss (first capture preserved)

---

## Test 4: Deduplication Window Expiry

**Objective**: Verify deduplication window (5 seconds) allows same message after expiry

### Test Procedure
1. **Send message**: "Window test message"
2. **Wait 6 seconds** (beyond 5-second window)
3. **Send same message again**: "Window test message"
4. **Check console logs**: Both messages should be captured
5. **Verify in Supabase**: TWO entries (5+ seconds apart)

### Success Criteria
✅ First message captured
✅ Second message captured after window expiry
✅ TWO database entries with different timestamps
✅ Timestamps differ by ~6 seconds

---

## Test 5: Deduplication Statistics

**Objective**: Verify deduplication statistics tracking

### Test Procedure
1. **Open console**
2. **Run health check**:
   ```javascript
   window.KYT_Deduplicator.getStats()
   ```

3. **Expected output**:
   ```javascript
   {
     totalAttempts: 15,
     captured: 12,
     duplicatesSkipped: 3,
     upgradeCaptures: 0,
     mapSize: 8,
     duplicateRate: "20.0%"
   }
   ```

4. **Interpret results**:
   - `totalAttempts`: Total capture attempts across all methods
   - `captured`: Unique messages captured
   - `duplicatesSkipped`: Duplicates prevented
   - `upgradeCaptures`: Higher-confidence upgrades
   - `mapSize`: Current deduplication cache size
   - `duplicateRate`: Percentage of duplicates

### Success Criteria
✅ Statistics available via console
✅ Numbers accurate (manual count vs reported)
✅ Duplicate rate < 30% (indicates effective deduplication)

---

## Test 6: Multi-Method Stress Test

**Objective**: Verify system stability under rapid multi-method captures

### Test Procedure
1. **Rapid-fire messages** (10 messages in 30 seconds):
   - Mix: 3 voice, 5 typed, 2 voice
   - Use different content for each

2. **Check console logs**: All messages captured, no errors

3. **Verify in Supabase**:
   ```sql
   SELECT COUNT(*) as total_messages
   FROM messages
   WHERE created_at > NOW() - INTERVAL '1 minute';
   ```
   - Should return: 10 (no duplicates)

4. **Check deduplication stats**:
   ```javascript
   window.KYT_Deduplicator.getStats()
   ```
   - `mapSize` should be ~10 (within window)
   - `duplicatesSkipped` should be 0 (all unique content)

### Success Criteria
✅ All 10 messages captured
✅ No duplicates in database
✅ No console errors
✅ Deduplication cache size reasonable (~10)
✅ System responsive (no lag)

---

## Common Issues & Troubleshooting

### Issue: No WebSocket logs
**Cause**: Voice feature not enabled in ChatGPT
**Fix**: Ensure ChatGPT account has voice access, check microphone permissions

### Issue: Duplicates in database
**Cause**: Deduplication layer not loaded
**Fix**:
1. Check manifest.json: deduplication.js loads BEFORE content.js
2. Reload extension
3. Clear browser cache

### Issue: "Extension context invalidated"
**Cause**: Extension was reloaded during active page session
**Fix**: Reload ChatGPT page to restore connection

### Issue: Messages not in Supabase
**Cause**: Background script error or Supabase credentials missing
**Fix**:
1. Check background.js console for errors
2. Verify Supabase URL and anon key
3. Check database permissions

---

## Validation Checklist

After running all tests, confirm:

- [ ] WebSocket interception works (Test 1)
- [ ] Fetch interception works (Test 2)
- [ ] Deduplication prevents duplicates (Test 3)
- [ ] Deduplication window expires correctly (Test 4)
- [ ] Statistics tracking accurate (Test 5)
- [ ] System stable under load (Test 6)

**Testing Complete**: ✅ All tests passed
**Issues Found**: [Document any failures here]
**Next Steps**: Update documentation, commit to git
