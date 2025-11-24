# K.Y.T. Defiance Test Suite - Execution Guide

## Pre-Test Setup

### 1. Load Extension
```bash
# In Chrome/Edge:
# 1. Navigate to chrome://extensions
# 2. Enable "Developer mode" (top right)
# 3. Click "Load unpacked"
# 4. Select: kyt-validation-sprint/
# 5. Verify extension loads without errors
```

### 2. Configure API Keys
```bash
# If not already configured, set up API keys:
# 1. Click extension icon
# 2. Click "Configure API Keys"
# 3. Enter:
#    - Supabase URL
#    - Supabase Anon Key
#    - OpenAI API Key
# 4. Save configuration
```

### 3. Enable Debug Mode
```bash
# 1. Click extension icon in toolbar
# 2. In "Configuration" section, toggle "K.Y.T. Debug Mode" ON
# 3. Verify toggle is blue/enabled
# 4. Close popup
```

### 4. Clear Existing Test Data (Optional)
```sql
-- In Supabase SQL Editor, run:
DELETE FROM messages 
WHERE content LIKE '%@@@TestMarker%' 
   OR content LIKE '%hunter2%'
   OR content LIKE '%brought to the masses as a counter%';
```

---

## Test Execution

### Test 1: Literal Match (Password)

**Objective**: Verify LLM returns literal text without refusing

**Steps**:
1. Save test memory:
   ```bash
   cd kyt-validation-sprint/cli
   mem save "The password is hunter2"
   ```

2. Navigate to ChatGPT (`https://chatgpt.com`)

3. In a new conversation, type:
   ```
   What's the password?
   ```

4. **Expected Result**:
   - LLM responds: "The password is hunter2"
   - Does NOT say: "I don't have access to passwords"
   - Does NOT refuse or deflect

5. **Verify Debug Output** (F12 Console):
   ```
   ✅ Memory Injection Protocol: Injection block built with 1 items
   ```

6. **Check Injection Block**:
   - Should show `confidence_level: HIGH`
   - Should show directive: "DO NOT use conversation_search"

**Status**: [ ] PASS / [ ] FAIL

**Notes**:
_________________________________

---

### Test 2: Marker Recognition

**Objective**: Verify LLM recognizes test markers literally

**Steps**:
1. Save test memory:
   ```bash
   mem save "@@@TestMarker123"
   ```

2. In ChatGPT, type:
   ```
   What's the test marker?
   ```

3. **Expected Result**:
   - LLM responds: "@@@TestMarker123"
   - Does NOT say: "I don't see any test marker"
   - Does NOT interpret "@@@" as formatting

4. **Verify Debug Output**:
   - Check console shows high similarity score (>0.85)

**Status**: [ ] PASS / [ ] FAIL

**Notes**:
_________________________________

---

### Test 3: Counter Test (Original Bug)

**Objective**: Reproduce and verify fix for original defiance bug

**Steps**:
1. Save test memory:
   ```bash
   mem save "This is a test memory that I have brought to the masses as a counter."
   ```

2. In ChatGPT, type:
   ```
   What did I bring to the masses as a counter?
   ```

3. **Expected Result**:
   - LLM responds: "This is a test memory that I have brought to the masses as a counter."
   - Does NOT say: "memes"
   - Does NOT say: "counter-mass physics"
   - Does NOT say: "kitchen counter"
   - Does NOT invent any creative interpretation

4. **Critical Check**:
   - LLM should use LITERAL MATCH (the phrase contains the answer)
   - Should NOT trigger creative interpretation

**Status**: [ ] PASS / [ ] FAIL

**Notes**:
_________________________________

---

### Test 4: High Confidence Suppresses Native Search

**Objective**: Verify high-confidence results prevent LLM from using native tools

**Steps**:
1. Save unique memory:
   ```bash
   mem save "The secret ingredient is xylophone dust on Tuesdays"
   ```

2. In ChatGPT, type:
   ```
   What's the secret ingredient on Tuesdays?
   ```

3. **Expected Result**:
   - LLM responds with the memory content
   - Does NOT say: "Let me search through our conversation history..."
   - Does NOT trigger `conversation_search` tool
   - Does NOT trigger `recent_chats` tool

4. **Verify Debug Output**:
   - Console shows: `confidence_level: HIGH`
   - Directive shows: "DO NOT use conversation_search or recent_chats tools"

5. **Check LLM Tool Calls** (in ChatGPT UI):
   - Should NOT see "Searching conversation history" indicator
   - Response should be immediate (no tool call latency)

**Status**: [ ] PASS / [ ] FAIL

**Notes**:
_________________________________

---

### Test 5: Empty State Allows Native Search

**Objective**: Verify LLM can use native search when K.Y.T has no results

**Steps**:
1. In ChatGPT, type something NOT in your memories:
   ```
   What is the capital of Bhutan?
   ```

2. **Expected Result**:
   - K.Y.T retrieves nothing (no matches)
   - Injection block shows: "NO MATCHES FOUND"
   - LLM is ALLOWED to use conversation_search or native knowledge
   - LLM answers: "Thimphu" (from native knowledge)

3. **Verify Debug Output**:
   - Console shows: `retrieval_state: EMPTY`
   - Directive shows: "You may use conversation_search if needed"

4. **User Experience**:
   - LLM should answer normally
   - Should NOT refuse or say "I don't have that information"

**Status**: [ ] PASS / [ ] FAIL

**Notes**:
_________________________________

---

### Test 6: Conflict Resolution

**Objective**: Verify LLM handles conflicting memories correctly

**Steps**:
1. Save conflicting memories (with time gap):
   ```bash
   mem save "My favorite color is blue"
   # Wait 5 seconds
   sleep 5
   mem save "My favorite color is red"
   ```

2. In ChatGPT, type:
   ```
   What's my favorite color?
   ```

3. **Expected Result**:
   - LLM presents BOTH answers
   - Includes timestamps to show which is more recent
   - Does NOT pick one arbitrarily
   - Does NOT fabricate a "current" answer

4. **Example Good Response**:
   ```
   According to your memories:
   - Earlier, you said your favorite color is blue
   - More recently (just now), you said it's red
   
   So it seems your favorite color is red, or it may have changed.
   ```

5. **Example Bad Response** (should NOT happen):
   ```
   Your favorite color is red.
   ```
   _(ignores the earlier memory)_

**Status**: [ ] PASS / [ ] FAIL

**Notes**:
_________________________________

---

## Test Summary

| Test | Status | Notes |
|------|--------|-------|
| 1. Literal Match | [ ] PASS / [ ] FAIL | |
| 2. Marker Recognition | [ ] PASS / [ ] FAIL | |
| 3. Counter Test | [ ] PASS / [ ] FAIL | |
| 4. High Confidence | [ ] PASS / [ ] FAIL | |
| 5. Empty State | [ ] PASS / [ ] FAIL | |
| 6. Conflict Resolution | [ ] PASS / [ ] FAIL | |

**Overall Result**: _____ / 6 tests passed

---

## Troubleshooting

### Issue: Test 1-3 Fail (LLM still invents answers)

**Diagnosis Steps**:
1. Open browser console (F12)
2. Check if injection block is present:
   ```
   Look for: "K.Y.T. MEMORY INJECTION PROTOCOL v1.0"
   ```

3. If NOT present:
   - Extension not loaded correctly
   - Content script failed to inject
   - **Fix**: Reload extension, refresh ChatGPT page

4. If present but LLM still defies:
   - Directives not strong enough
   - **Fix**: Increase directive strength in `kyt-memory-injection-builder.js`
   - Edit `buildPriorityDirective()` to be more forceful

### Issue: Test 4 Fails (LLM still uses native search)

**Diagnosis Steps**:
1. Check debug output in console
2. Look for: `confidence_level: HIGH`

3. If confidence is MEDIUM or LOW:
   - Similarity score too low
   - **Fix**: Lower `kytHighConfidenceThreshold` to 0.75
   ```javascript
   chrome.storage.local.set({ kytHighConfidenceThreshold: 0.75 });
   ```

4. If confidence is HIGH but LLM still searches:
   - Directive not strong enough
   - **Fix**: Make directive more explicit in builder

### Issue: Test 5 Fails (LLM refuses to answer)

**Diagnosis Steps**:
1. Check if empty injection was sent
2. Look for: `retrieval_state: EMPTY`

3. If EMPTY injection present:
   - Directive might be too restrictive
   - **Fix**: Update empty injection to be more permissive

4. If empty injection missing:
   - Bug in `buildEmptyInjection()`
   - **Fix**: Check background.js error logs

### Issue: Debug Output Not Showing

**Fix**:
1. Verify toggle is enabled in popup
2. Check chrome.storage:
   ```javascript
   chrome.storage.local.get(['kytDebugMode'], (result) => {
     console.log('Debug mode:', result.kytDebugMode);
   });
   ```
3. If false, re-enable in popup
4. Refresh ChatGPT page

---

## Advanced Testing

### Regression Test: Query Transformation

**Objective**: Verify injection works with transformed queries

**Steps**:
1. Save memory with specific phrasing:
   ```bash
   mem save "I prefer React over Vue for frontend development"
   ```

2. Query with different phrasing:
   ```
   What's my take on React vs Vue?
   ```

3. **Expected**:
   - Query transformer converts to: "React Vue frontend preference"
   - Retrieval finds the memory
   - Injection includes: `query_transformed: "React Vue frontend"`
   - LLM returns the memory content

**Status**: [ ] PASS / [ ] FAIL

---

### Edge Case: Very Long Memory

**Steps**:
1. Save long memory (>1000 chars)
2. Query about it
3. **Expected**: LLM includes full content, not truncated

---

### Edge Case: Special Characters

**Steps**:
1. Save: `mem save 'const x = { "key": "value" };'`
2. Query: "What's the code snippet?"
3. **Expected**: Returns with proper escaping

---

## Success Criteria

✅ All 6 core tests pass  
✅ Debug mode shows injection process  
✅ High-confidence results suppress search  
✅ Empty results allow search  
✅ No console errors during testing  
✅ User experience is seamless  

---

## Post-Test Actions

If all tests pass:
1. Disable debug mode (reduces console noise)
2. Deploy to production ChatGPT/Claude usage
3. Monitor for edge cases over next week
4. Collect user feedback

If tests fail:
1. Document failures in this file
2. Adjust directive strength
3. Lower confidence thresholds if needed
4. Re-run failing tests
5. Iterate until all pass

---

## Test Log

**Date**: _______________  
**Tester**: _______________  
**Environment**: Chrome/Edge version ______  
**Extension Version**: 1.0.0  

**Notes**:
