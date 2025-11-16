# Phase 1.5: Assistant Response Capture - Design Document

**Date**: 2025-11-14
**Priority**: CRITICAL - Blocks Phase 2
**Goal**: Capture assistant responses from both ChatGPT and Claude platforms

---

## Problem Statement

**Current State**: Only capturing user questions (sparse, 10-20 tokens)
**Missing**: Assistant responses (rich, 100-500 tokens with knowledge)
**Impact**: Semantic search finds questions, not answers/knowledge

**User's Insight**: "Like trying to learn a language with only 100 words"

---

## Architecture Design

### Current Flow (Incomplete)
```
User types → REQUEST intercepted ✅ → User message captured ✅
         ↓
      API call
         ↓
Assistant responds → RESPONSE not captured ❌ → Knowledge lost ❌
```

### Target Flow (Complete)
```
User types → REQUEST intercepted ✅ → User message captured ✅
         ↓
      API call
         ↓
Assistant responds → RESPONSE intercepted ✅ → Assistant message captured ✅
         ↓
    Both linked via conversation_id + timestamp
```

---

## Technical Approach

### 1. Response Interception Strategy

**ChatGPT Streaming Format** (SSE - Server-Sent Events):
```
data: {"choices":[{"delta":{"content":"TON"}}]}
data: {"choices":[{"delta":{"content":" 618"}}]}
data: {"choices":[{"delta":{"content":" is"}}]}
...
data: [DONE]
```

**Claude Streaming Format** (SSE):
```
data: {"type":"content_block_delta","delta":{"text":"TON"}}
data: {"type":"content_block_delta","delta":{"text":" 618"}}
data: {"type":"content_block_delta","delta":{"text":" is"}}
...
data: {"type":"message_stop"}
```

**Challenge**: Response is streamed in chunks, need to:
1. Clone response before consumption (don't break streaming to UI)
2. Read response body as it streams
3. Accumulate full text
4. Detect when complete
5. Extract assistant message
6. Store with proper metadata

### 2. Fetch Wrapper Modification

**Current Pattern**:
```javascript
window.fetch = async function(...args) {
  // 1. Intercept request
  // 2. Inject context into request body
  // 3. Capture user message
  // 4. Return originalFetch result
  return originalFetch.apply(this, args);
};
```

**New Pattern**:
```javascript
window.fetch = async function(...args) {
  // 1. Intercept request
  // 2. Inject context into request body
  // 3. Capture user message

  // 4. Call original fetch
  const response = await originalFetch.apply(this, args);

  // 5. Clone response (don't consume original)
  const clonedResponse = response.clone();

  // 6. Read cloned response stream asynchronously
  captureAssistantResponse(clonedResponse, metadata);

  // 7. Return original response (for UI)
  return response;
};
```

### 3. Response Reading Strategy

**Stream Reading**:
```javascript
async function captureAssistantResponse(response, metadata) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let fullText = '';

  while (true) {
    const {done, value} = await reader.read();
    if (done) break;

    const chunk = decoder.decode(value);
    // Parse SSE format: "data: {...}\n\n"
    const lines = chunk.split('\n');
    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const data = line.substring(6);
        if (data === '[DONE]') break;

        try {
          const json = JSON.parse(data);
          // Extract text based on platform
          const text = extractTextFromChunk(json, metadata.platform);
          fullText += text;
        } catch (e) {
          // Skip malformed JSON
        }
      }
    }
  }

  // Store complete response
  storeAssistantMessage(fullText, metadata);
}
```

### 4. Platform-Specific Extraction

**ChatGPT**:
```javascript
function extractTextFromChunk(json, platform) {
  if (platform === 'chatgpt') {
    return json.choices?.[0]?.delta?.content || '';
  }
  // ...
}
```

**Claude**:
```javascript
function extractTextFromChunk(json, platform) {
  if (platform === 'claude') {
    if (json.type === 'content_block_delta') {
      return json.delta?.text || '';
    }
  }
  // ...
}
```

### 5. Message Linking

**User Message**:
```javascript
{
  content: "What is TON 618?",
  role: 'user',
  conversationId: 'conv_123',
  timestamp: 1699999999000,
  messageId: 'msg_user_123_1699999999000',
  platform: 'chatgpt'
}
```

**Assistant Message**:
```javascript
{
  content: "TON 618 is a supermassive black hole...",
  role: 'assistant',
  conversationId: 'conv_123',  // SAME conversation_id
  timestamp: 1699999999500,     // ~500ms after user message
  messageId: 'msg_assistant_123_1699999999500',
  platform: 'chatgpt',
  inReplyTo: 'msg_user_123_1699999999000'  // Link to user message
}
```

---

## Implementation Plan

### Files to Modify

1. **`platforms/chatgpt/inject.js`**
   - Modify fetch wrapper to capture response
   - Implement ChatGPT SSE parsing
   - Accumulate streamed text
   - Dispatch assistant message event

2. **`platforms/claude/content_test.js`**
   - Modify fetch wrapper to capture response
   - Implement Claude SSE parsing
   - Accumulate streamed text
   - Dispatch assistant message event

3. **`background.js`** (may need updates)
   - Ensure handles `role='assistant'` messages
   - Verify storage logic works for both roles

4. **`src/browser-sync.js`** (may need updates)
   - Verify embedding generation for assistant messages
   - Ensure Supabase storage handles both roles

---

## Testing Strategy

### Test 1: Capture Verification
1. Send message on ChatGPT: "What is quantum entanglement?"
2. Check console for TWO captured messages:
   - User: "What is quantum entanglement?" (role='user')
   - Assistant: "Quantum entanglement is..." (role='assistant')
3. Verify both stored in chrome.storage.local
4. Verify both synced to Supabase

### Test 2: Semantic Search Quality
1. Ask same question again after 3 minutes
2. Context search should find ASSISTANT response (rich knowledge)
3. LLM should receive: "Quantum entanglement is [full explanation]"
4. Compare to before (would have found user question only)

### Test 3: ChatGPT Proactivity
1. Ask follow-up question that requires previous knowledge
2. ChatGPT should proactively use memory (like Claude does)
3. No "I don't know" when knowledge exists in database

### Test 4: Both Platforms
1. Ask question on ChatGPT, get detailed answer
2. Ask related question on Claude
3. Claude should find ChatGPT's ANSWER in memory
4. Cross-platform memory with complete conversations

---

## Expected Outcomes

### Database Contents (Before)
```sql
SELECT content, role FROM messages ORDER BY timestamp DESC LIMIT 5;

"What is TON 618?"           | user
"How massive is that?"        | user
"What is a quasar?"          | user
"Could it threaten Earth?"   | user
"Why is it important?"       | user
```

### Database Contents (After)
```sql
SELECT content, role FROM messages ORDER BY timestamp DESC LIMIT 10;

"Why is it important?"                           | user
"TON 618 is important because..."                | assistant
"Could it threaten Earth?"                       | user
"No, TON 618 is far too distant to pose..."     | assistant
"What is a quasar?"                              | user
"A quasar is an extremely luminous active..."   | assistant
"How massive is that?"                           | user
"TON 618 contains 66 billion solar masses..."   | assistant
"What is TON 618?"                               | user
"TON 618 is a supermassive black hole..."       | assistant
```

### Semantic Search Quality (Before)
```
Query: "Tell me about TON 618"
Results:
1. "What is TON 618?" (distance: 0.35) ← User question (sparse)
2. "How massive is that?" (distance: 0.42) ← User question (sparse)
3. "What is a quasar?" (distance: 0.48) ← User question (sparse)
```

### Semantic Search Quality (After)
```
Query: "Tell me about TON 618"
Results:
1. "TON 618 is a supermassive black hole containing 66 billion solar masses, located 18.2 billion light-years away..." (distance: 0.28) ← ANSWER (rich!)
2. "TON 618 contains 66 billion solar masses, making it one of the most massive..." (distance: 0.31) ← ANSWER (rich!)
3. "A quasar is an extremely luminous active galactic nucleus..." (distance: 0.45) ← ANSWER (rich!)
```

---

## Success Criteria

✅ Both user AND assistant messages captured
✅ Streaming responses handled correctly (don't break UI)
✅ Complete conversation stored (question + answer pairs)
✅ Semantic search finds KNOWLEDGE (answers), not just questions
✅ ChatGPT becomes as proactive as Claude (data quality equal)
✅ Cross-platform memory with complete conversations
✅ No regression in existing functionality

---

## Risks and Mitigations

**Risk 1**: Breaking streaming UI
- **Mitigation**: Clone response before reading, return original

**Risk 2**: Incomplete response capture (stream interrupted)
- **Mitigation**: Store partial responses, mark as incomplete

**Risk 3**: Platform API format changes
- **Mitigation**: Defensive parsing, graceful degradation

**Risk 4**: Performance impact (double reading stream)
- **Mitigation**: Async capture, don't block UI response

**Risk 5**: Storage quota (double the data)
- **Mitigation**: Already syncing to Supabase, chrome.storage is temporary

---

## Next Steps

1. ✅ Design document created
2. ⏳ Implement ChatGPT response capture
3. ⏳ Implement Claude response capture
4. ⏳ Test complete conversation capture
5. ⏳ Validate semantic search quality improvement
6. ⏳ Re-test ChatGPT proactivity vs Claude
7. ⏳ Commit Phase 1.5 implementation
8. ⏳ Resume Phase 2 with complete data
