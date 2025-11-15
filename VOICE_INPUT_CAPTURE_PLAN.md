# Voice Input Capture Implementation Plan

**Date**: 2025-11-15
**Status**: Research Complete, Ready for Testing
**Priority**: Medium

---

## Executive Summary

This plan outlines how to capture voice input from ChatGPT after voice-to-text conversion but before model submission. Based on comprehensive research, **the existing message capture system likely already handles voice input** with no code changes needed.

---

## 1. Research Findings

### 1.1 Current Architecture Analysis

**Existing Capabilities:**
- ✅ Text message capture via fetch interception (`/backend-api/conversation`)
- ✅ Assistant response capture via SSE stream parsing
- ✅ Dual-role capture (user questions + assistant answers)
- ✅ Cross-platform memory (ChatGPT ↔ Claude)
- ✅ Temporal filtering (prevents context pollution)

**Key Insight:** The fetch wrapper intercepts **ALL** POST requests to ChatGPT's conversation API, regardless of input method (keyboard or voice).

### 1.2 Voice Input Flow Hypothesis

Based on research and architectural analysis:

```
USER SPEAKS → MICROPHONE
       ↓
BROWSER CAPTURES AUDIO (Web Audio API)
       ↓
AUDIO SENT TO BACKEND (Whisper API or similar)
       ↓
TRANSCRIPTION RETURNED (text string)
       ↓
TEXT INJECTED INTO TEXTAREA (same as keyboard input)
       ↓
[OPTIONAL] USER EDITS TRANSCRIPTION
       ↓
TEXT SENT TO MODEL (POST /backend-api/conversation)
       ↓
🎯 **EXISTING FETCH WRAPPER INTERCEPTS HERE** ✅
```

**Critical Capture Point:** The final API call (`/backend-api/conversation`) contains the transcribed text, making it indistinguishable from keyboard input at the network level.

### 1.3 Confidence Assessment

**70% Confidence:** Voice uses SAME endpoint and format
- **Evidence**: All text messages use `/backend-api/conversation`
- **Implication**: Existing code already captures voice input
- **Action**: Test first, no code changes needed

**20% Confidence:** Voice uses DIFFERENT endpoint (e.g., `/backend-api/audio`)
- **Evidence**: Possible separate transcription API
- **Implication**: Add endpoint pattern to `detectAPICall()`
- **Action**: Minor code change (~10 lines)

**10% Confidence:** Voice has DIFFERENT request format
- **Evidence**: Unlikely, but possible voice-specific metadata
- **Implication**: Add parsing logic to `extractMessage()`
- **Action**: Medium code change (~50 lines)

---

## 2. Implementation Phases

### Phase 1: Research & Validation (2 hours)

**Goal:** Determine if existing code already captures voice input

**Steps:**

1. **Prerequisites Check**
   - [ ] ChatGPT Plus/Pro subscription (voice input enabled)
   - [ ] KYT extension loaded and working
   - [ ] Browser console accessible

2. **Network Traffic Analysis**
   - [ ] Open ChatGPT
   - [ ] Open DevTools → Network tab
   - [ ] Clear network log, enable "Preserve log"
   - [ ] Click voice input button (microphone icon)
   - [ ] Speak test message: "Hello, this is a voice input test"
   - [ ] Document endpoints called:
     - [ ] During recording
     - [ ] During transcription
     - [ ] During submission
   - [ ] Compare with keyboard input endpoints

3. **Request Body Inspection**
   - [ ] Locate final submission request
   - [ ] Copy request payload (JSON)
   - [ ] Compare voice vs keyboard payloads
   - [ ] Document differences (if any):
     - [ ] Same structure?
     - [ ] Additional fields?
     - [ ] Voice-specific metadata?

4. **Existing Code Test**
   - [ ] Keep browser console open
   - [ ] Voice input test message
   - [ ] **Expected console logs:**
     - `🎯 KYT ChatGPT: Intercepted API call`
     - `✅ KYT ChatGPT: Message extracted`
     - `📨 Content: Received message from page context`
   - [ ] **Verify in Supabase:**
     - [ ] Query: `SELECT * FROM captured_messages ORDER BY timestamp DESC LIMIT 5`
     - [ ] Check if voice message appears
     - [ ] Verify content matches transcription

5. **Document Findings**
   - [ ] Create `VOICE_RESEARCH_RESULTS.md`
   - [ ] Include network traffic screenshots
   - [ ] Include request/response payloads
   - [ ] Include console logs
   - [ ] Include Supabase query results
   - [ ] Answer: Does existing code work? YES/NO

**Deliverable:** Research results document with clear YES/NO on existing code functionality

---

### Phase 2A: No Changes Needed (if Phase 1 = YES)

**Duration:** 1 hour

**Steps:**

1. **Metadata Enrichment (Optional)**
   - Add `isVoiceInput` flag detection
   - Detect voice-specific request fields
   - Store metadata for analytics

2. **Documentation**
   - Update README with voice input support
   - Document voice capture behavior
   - Note any voice-specific edge cases

3. **Test Protocol Creation**
   - Create `VOICE_INPUT_TEST_PROTOCOL.md`
   - Document test cases
   - Include validation criteria

**Deliverable:** Documentation confirming voice capture works with existing code

---

### Phase 2B: Endpoint Addition (if Phase 1 = Different Endpoint)

**Duration:** 4 hours

**Files to Modify:**
- `platforms/chatgpt/inject.js` (lines 31-38)

**Changes:**

```javascript
// BEFORE (current code)
detectAPICall: function(url, options) {
  const isChatGPTAPI = (
    typeof url === 'string' &&
    (url.includes('/backend-api/conversation') ||
     url.includes('/backend-api/f/conversation'))
  );
  const isPostRequest = options?.method === 'POST' || options?.body;
  return isChatGPTAPI && isPostRequest;
}

// AFTER (with voice endpoint)
detectAPICall: function(url, options) {
  const isChatGPTAPI = (
    typeof url === 'string' &&
    (url.includes('/backend-api/conversation') ||
     url.includes('/backend-api/f/conversation') ||
     url.includes('/backend-api/audio') ||          // Voice transcription
     url.includes('/backend-api/voice'))            // Voice input
  );
  const isPostRequest = options?.method === 'POST' || options?.body;
  return isChatGPTAPI && isPostRequest;
}
```

**Testing:**
- [ ] Voice input interception works
- [ ] Keyboard input still works (no regression)
- [ ] Console logs appear for voice input
- [ ] Supabase receives voice messages

**Deliverable:** Updated code with voice endpoint detection

---

### Phase 2C: Format Changes (if Phase 1 = Different Format)

**Duration:** 6 hours

**Files to Modify:**
- `platforms/chatgpt/inject.js` (lines 40-76)

**Changes:**

```javascript
extractMessage: function(bodyString) {
  try {
    const body = JSON.parse(bodyString);

    // Detect voice input metadata
    const isVoiceInput = body.inputMethod === 'voice' ||
                         body.audioTranscription !== undefined ||
                         body.source === 'whisper';

    // Extract content (handle both text and voice formats)
    let content = null;

    // Voice-specific format (example)
    if (body.audioTranscription?.text) {
      content = body.audioTranscription.text;
    }
    // Standard text format (existing logic)
    else if (body.messages?.length > 0) {
      const lastMessage = body.messages[body.messages.length - 1];
      if (lastMessage?.content?.parts) {
        content = lastMessage.content.parts[0];
      } else if (typeof lastMessage?.content === 'string') {
        content = lastMessage.content;
      }
    }

    if (!content) {
      throw new Error('No valid content found');
    }

    return {
      content: content.trim(),
      role: body.role || 'user',
      conversationId: body.conversation_id || 'unknown',
      model: body.model || 'unknown',
      timestamp: Date.now(),
      messageId: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      platform: 'chatgpt',

      // Voice-specific metadata
      isVoiceInput: isVoiceInput,
      transcriptionConfidence: body.audioTranscription?.confidence,
      wasEdited: body.audioTranscription?.wasEdited
    };
  } catch (error) {
    console.error('❌ KYT ChatGPT: Extraction error:', error.message);
    return null;
  }
}
```

**Testing:**
- [ ] Voice format parsing works
- [ ] Text format parsing still works (no regression)
- [ ] Voice metadata captured correctly
- [ ] Edge cases handled (malformed JSON, missing fields)

**Deliverable:** Updated code with voice format parsing

---

### Phase 3: Comprehensive Testing (2 hours)

**Test Cases:**

#### Test #1: Basic Voice Capture
- **Action:** Voice input "Hello world"
- **Expected:** Message captured with content="Hello world"
- **Validation:**
  - [ ] Console log: `🎯 Intercepted API call`
  - [ ] Console log: `✅ Message extracted`
  - [ ] Supabase query shows message
  - [ ] Content matches transcription

#### Test #2: Voice-Then-Edit
- **Action:** Voice "Hello" → Edit to "Hello world" → Submit
- **Expected:** Captured content="Hello world" (edited version)
- **Validation:**
  - [ ] Final text includes edit
  - [ ] Not just raw transcription
  - [ ] User edit preserved

#### Test #3: Voice Auto-Submit
- **Action:** Enable auto-submit → Voice "Hello"
- **Expected:** Immediate capture after transcription
- **Validation:**
  - [ ] No manual submit needed
  - [ ] Capture timing < 2 seconds
  - [ ] Message synced to Supabase

#### Test #4: Voice Response Capture
- **Action:** Voice question → Receive assistant answer
- **Expected:** BOTH captured (question + answer)
- **Validation:**
  - [ ] User message captured
  - [ ] Assistant response captured
  - [ ] Database has pair
  - [ ] Role='user' and role='assistant'

#### Test #5: Cross-Platform Memory
- **Action:** Voice input on ChatGPT → Query on Claude
- **Expected:** Claude retrieves ChatGPT voice context
- **Validation:**
  - [ ] Semantic search finds voice message
  - [ ] Context injected into Claude
  - [ ] Claude uses context in response

#### Test #6: Rapid Voice Input
- **Action:** 3 voice inputs in quick succession
- **Expected:** All 3 captured independently
- **Validation:**
  - [ ] 3 separate messages in database
  - [ ] No dropped captures
  - [ ] Temporal filtering works (120s exclusion)

#### Test #7: Mixed Input (Voice + Keyboard)
- **Action:** Voice input → Keyboard input → Voice input
- **Expected:** All captured correctly
- **Validation:**
  - [ ] No interference between methods
  - [ ] Both types captured
  - [ ] No regression on keyboard input

**Deliverable:** Test protocol document with results

---

## 3. Edge Cases & User Scenarios

### 3.1 Voice-Then-Edit Scenario

**User Flow:**
1. User speaks: "What is quantum computing"
2. Whisper transcribes: "What is quantum computing"
3. User sees transcription in textarea
4. User edits: "What is quantum computing and how does it work?"
5. User submits

**Capture Behavior:**
- Transcription appears in DOM (step 2) - DON'T capture here
- User edits (step 3)
- Submit triggers API call (step 5) - **CAPTURE HERE** ✅
- Captured text = edited version (not raw transcription)

**Existing Code Support:** YES ✅
- We intercept final POST request
- Body contains edited text

---

### 3.2 Voice Auto-Submit Scenario

**User Flow:**
1. User speaks: "What is quantum computing"
2. Whisper transcribes: "What is quantum computing"
3. Auto-submit enabled → Immediately sends

**Capture Behavior:**
- No textarea interaction
- Direct API call after transcription
- **CAPTURE HERE** ✅

**Existing Code Support:** YES ✅
- We intercept all POST requests
- Doesn't matter if auto-submitted

---

### 3.3 Interrupted Voice Input

**User Flow:**
1. User starts speaking
2. User clicks microphone to cancel
3. Partial transcription appears
4. User doesn't submit

**Capture Behavior:**
- No API call made (no submission)
- **NO CAPTURE** (correct behavior)

**Existing Code Support:** YES ✅
- Only captures completed submissions

---

### 3.4 Voice Input Errors

**User Flow:**
1. User speaks (inaudible/unclear)
2. Transcription fails or is gibberish
3. User submits anyway

**Capture Behavior:**
- Captures whatever was transcribed (garbage text)
- **CAPTURE OCCURS** (expected)

**Existing Code Support:** YES ✅
- We capture content regardless of quality
- Validation is LLM's responsibility

---

## 4. Risk Assessment

### High Confidence Scenarios

**Risk: Existing code already works**
- **Probability:** 70%
- **Impact:** Positive (no work needed)
- **Mitigation:** Test first to confirm

**Risk: Minor endpoint addition needed**
- **Probability:** 20%
- **Impact:** Low (10-line code change)
- **Mitigation:** Clear implementation pattern exists

### Medium Confidence Scenarios

**Risk: Different request format**
- **Probability:** 10%
- **Impact:** Medium (50-line code change)
- **Mitigation:** Reuse existing parsing patterns

### Low Risk Scenarios

**Risk: Client-side transcription (no API)**
- **Probability:** 5%
- **Impact:** High (requires DOM observation)
- **Mitigation:** Fall back to textarea monitoring

**Risk: Real-time WebSocket API**
- **Probability:** 5%
- **Impact:** High (requires WebSocket interception)
- **Mitigation:** Research Realtime API patterns

---

## 5. Success Criteria

### Functional Requirements

- ✅ Voice input captured AFTER transcription (text, not audio)
- ✅ Voice input captured BEFORE model submission
- ✅ User edits to transcription captured
- ✅ Auto-submit voice input captured
- ✅ Voice responses captured (assistant messages)
- ✅ Cross-platform memory works

### Technical Requirements

- ✅ No regression on keyboard input
- ✅ Reuses existing fetch interception
- ✅ Reuses existing SSE parsing
- ✅ Graceful error handling
- ✅ Defensive coding (null checks)

### Documentation Requirements

- ✅ Voice architecture documented
- ✅ Test protocol created
- ✅ Edge cases documented
- ✅ Research findings published

---

## 6. Timeline Estimates

### Best Case Scenario (Existing Code Works)
- **Research & Testing:** 2 hours
- **Documentation:** 1 hour
- **Total:** 3 hours

### Most Likely Scenario (Minor Modifications)
- **Research:** 2 hours
- **Implementation:** 2 hours
- **Testing:** 2 hours
- **Documentation:** 1 hour
- **Total:** 7 hours

### Worst Case Scenario (Format Changes)
- **Research:** 2 hours
- **Implementation:** 4 hours
- **Testing:** 2 hours
- **Documentation:** 1 hour
- **Total:** 9 hours

---

## 7. Next Steps

### Immediate Actions

1. **Confirm Prerequisites**
   - [ ] ChatGPT Plus/Pro access
   - [ ] Voice input feature available
   - [ ] Browser console access

2. **Execute Phase 1 Research**
   - [ ] Network traffic analysis
   - [ ] Request body inspection
   - [ ] Existing code test
   - [ ] Document findings

3. **Determine Implementation Path**
   - [ ] Phase 2A (no changes)
   - [ ] Phase 2B (endpoint addition)
   - [ ] Phase 2C (format changes)

4. **Proceed with Implementation**
   - [ ] Based on research findings
   - [ ] Follow appropriate phase plan
   - [ ] Test thoroughly

### Questions Before Starting

1. **Do you have ChatGPT Plus/Pro?** (Required for voice input)
2. **Which browser?** (Chrome recommended for DevTools)
3. **Voice settings?** (Auto-submit enabled/disabled?)
4. **Priority scenario?** (Voice-then-edit vs auto-submit)
5. **Timeline?** (When do you need this working?)

---

## 8. Related Documentation

**Existing Docs:**
- `platforms/chatgpt/inject.js` - Main interception code
- `PHASE_1.5_DESIGN.md` - Assistant response capture
- `CHANGELOG.md` - Historical implementation notes

**To Be Created:**
- `VOICE_RESEARCH_RESULTS.md` - Phase 1 findings
- `VOICE_INPUT_TEST_PROTOCOL.md` - Testing procedures
- `VOICE_INPUT_EDGE_CASES.md` - Known issues and solutions

---

## 9. Conclusion

**Key Insight:** The existing KYT Memory Extension architecture is **perfectly positioned** to capture voice input with minimal or no code changes.

**Recommendation:** **Test first, implement only if needed.**

The fetch wrapper already intercepts all ChatGPT API calls. If voice input uses the same `/backend-api/conversation` endpoint (70% likely), existing code already captures it. Research phase will confirm this hypothesis.

**Estimated Outcome:**
- 70% chance: Works out of the box
- 20% chance: Minor endpoint addition
- 10% chance: Format parsing changes

All scenarios are manageable with clear implementation paths.

---

**Status**: Ready to begin Phase 1 Research
**Next Action**: Execute research protocol and document findings
