# Voice Capture - Robust Solutions Brainstorming

**Date**: 2025-11-15
**Context**: After PoC DOM-based implementation
**Goal**: Identify more robust, maintainable approaches to voice input capture

---

## 🎯 Problem Statement

### Current PoC Implementation
**Method**: DOM MutationObserver watching for text nodes
**Location**: `platforms/chatgpt/inject.js` lines 499-638

**Fragility Issues:**
- ⚠️ **DOM Structure Dependent**: Breaks if ChatGPT changes HTML/CSS
- ⚠️ **Selector Brittleness**: Relies on aria-labels, data attributes that can change
- ⚠️ **Role Inference Uncertainty**: Heuristic-based role detection not 100% reliable
- ⚠️ **Streaming Duplicates**: May capture same message in chunks during streaming
- ⚠️ **Noise Filtering**: Hard-coded patterns for UI elements may miss new UI additions

### Root Cause
Voice input uses **WebSocket** (`wss://ws.chatgpt.com/ws/user/...`) instead of HTTP fetch, which our existing fetch wrapper cannot intercept.

---

## 💡 Solution Space

### 🥇 Solution 1: WebSocket Interception (MOST ROBUST)

**Concept**: Wrap native `window.WebSocket` to intercept WebSocket messages

**Implementation Pattern:**
```javascript
const OriginalWebSocket = window.WebSocket;
window.WebSocket = function(...args) {
  const socket = new OriginalWebSocket(...args);

  // Only intercept ChatGPT voice WebSocket
  if (args[0]?.includes('ws.chatgpt.com/ws/user/')) {
    socket.addEventListener('message', (event) => {
      try {
        // Check for binary (audio) vs text (transcript)
        if (typeof event.data === 'string') {
          const data = JSON.parse(event.data);

          // Look for transcript field
          if (data?.type === 'transcript' || data?.text) {
            console.log('🎤 Voice Transcript:', data.text || data);

            // Dispatch to existing message capture pipeline
            window.dispatchEvent(new CustomEvent('KYT_MESSAGE_CAPTURED', {
              detail: {
                content: data.text || data.transcript,
                role: 'user',
                platform: 'chatgpt',
                captureMethod: 'websocket',
                confidence: 'high'  // WebSocket capture more reliable than DOM
              }
            }));
          }
        }
      } catch (e) {
        // Not JSON or error parsing
      }
    });
  }

  return socket;
};
```

**Advantages:**
- ✅ **Most Robust**: Intercepts at protocol level, not presentation layer
- ✅ **Upstream Capture**: Gets transcript before DOM rendering
- ✅ **No DOM Dependency**: Independent of HTML structure
- ✅ **High Confidence**: Direct access to voice-to-text result
- ✅ **No Duplicates**: Captures once at source
- ✅ **Future-Proof**: WebSocket protocol less likely to change than DOM

**Challenges:**
- ⚠️ **Message Format Unknown**: Need to reverse-engineer WebSocket message structure
- ⚠️ **Binary Protocol**: Audio frames are binary (but we only need text transcripts)
- ⚠️ **Authentication**: WebSocket may have auth handshake to preserve
- ⚠️ **State Management**: Must not break existing WebSocket functionality

**Implementation Effort:** 4-6 hours
**Maintenance Risk:** LOW
**Reliability:** HIGH

**Next Steps:**
1. Capture WebSocket traffic in DevTools → WS → Messages tab
2. Identify transcript message format
3. Test WebSocket wrapper doesn't break voice input
4. Implement message parsing

---

### 🥈 Solution 2: Hybrid Approach (BALANCED)

**Concept**: Use WebSocket for voice transcripts + fetch for final submission + DOM as fallback

**Architecture:**
```
Voice Input Flow:
1. Audio → WebSocket → Transcript (CAPTURE HERE - highest confidence)
2. Transcript → Textarea → User Edit (if any)
3. Submission → Fetch API (CAPTURE HERE - medium confidence)
4. Fallback → DOM Observer (CAPTURE HERE - low confidence)
```

**Implementation:**
```javascript
// Priority cascade
const captureStrategies = [
  {
    name: 'websocket',
    confidence: 'high',
    method: interceptWebSocket()  // Primary
  },
  {
    name: 'fetch',
    confidence: 'medium',
    method: interceptFetch()       // Already implemented
  },
  {
    name: 'dom',
    confidence: 'low',
    method: observeDOM()           // Fallback (current PoC)
  }
];

// Deduplication logic
const recentCaptures = new Map();  // messageId → {text, timestamp, method}

function captureWithDedup(message, method, confidence) {
  const hash = simpleHash(message.content);
  const recent = recentCaptures.get(hash);

  // If captured recently by higher-confidence method, skip
  if (recent && recent.confidence >= confidence &&
      Date.now() - recent.timestamp < 5000) {
    console.log(`⏭️ Skipping duplicate (${method}, lower confidence)`);
    return;
  }

  // Store this capture
  recentCaptures.set(hash, {
    text: message.content,
    timestamp: Date.now(),
    method: method,
    confidence: confidence
  });

  // Clean old entries (keep last 1 minute)
  for (const [k, v] of recentCaptures.entries()) {
    if (Date.now() - v.timestamp > 60000) {
      recentCaptures.delete(k);
    }
  }

  // Dispatch message
  window.dispatchEvent(new CustomEvent('KYT_MESSAGE_CAPTURED', {
    detail: message
  }));
}
```

**Advantages:**
- ✅ **Defense in Depth**: Multiple capture points
- ✅ **Graceful Degradation**: If WebSocket fails, fetch catches it; if both fail, DOM catches it
- ✅ **Confidence Tracking**: Each capture tagged with reliability level
- ✅ **Deduplication**: Prevents same message captured 3 times
- ✅ **Evolutionary**: Can migrate from DOM → Fetch → WebSocket incrementally

**Challenges:**
- ⚠️ **Complexity**: 3x the code to maintain
- ⚠️ **Dedup Logic**: Hash collisions possible, timing-sensitive
- ⚠️ **Debugging**: Hard to trace which method captured what

**Implementation Effort:** 6-8 hours
**Maintenance Risk:** MEDIUM
**Reliability:** VERY HIGH

---

### 🥉 Solution 3: Improved DOM Observer (INCREMENTAL)

**Concept**: Make current DOM approach more robust without changing architecture

**Improvements:**

#### 3A. Accessibility-First Selectors
```javascript
// Instead of class names, use ARIA attributes (more stable)
function findMessageNodes() {
  return [
    ...document.querySelectorAll('[role="article"]'),           // Message containers
    ...document.querySelectorAll('[aria-label*="message"]'),    // Labeled messages
    ...document.querySelectorAll('[data-message-role]')         // Role attributes
  ];
}
```

#### 3B. Content-Based Role Detection
```javascript
function inferRoleFromContent(element) {
  // Check position in DOM tree
  const messageContainer = element.closest('[role="article"]');
  const prevSibling = messageContainer?.previousElementSibling;

  // If previous message was assistant, this is likely user
  if (prevSibling?.querySelector('[aria-label*="assistant"]')) {
    return 'user';
  }

  // Check text patterns
  const text = element.textContent;
  const userPatterns = [/^(you said|i asked|my question)/i];
  const assistantPatterns = [/^(chatgpt|i can|let me|here)/i];

  if (userPatterns.some(p => p.test(text))) return 'user';
  if (assistantPatterns.some(p => p.test(text))) return 'assistant';

  return 'unknown';
}
```

#### 3C. Streaming Deduplication
```javascript
const streamingMessages = new Map();  // conversationId → {chunks, lastUpdate}

function handleStreamingMessage(text, conversationId) {
  const stream = streamingMessages.get(conversationId);
  const now = Date.now();

  if (!stream || now - stream.lastUpdate > 2000) {
    // New message or stream ended
    streamingMessages.set(conversationId, {
      chunks: [text],
      lastUpdate: now
    });
  } else {
    // Continuing stream
    stream.chunks.push(text);
    stream.lastUpdate = now;
  }

  // Only dispatch when stream is complete (no updates for 2s)
  setTimeout(() => {
    if (streamingMessages.get(conversationId)?.lastUpdate === now) {
      const fullText = stream.chunks.join('');
      dispatchMessage(fullText);
      streamingMessages.delete(conversationId);
    }
  }, 2500);
}
```

#### 3D. Multi-Strategy Node Detection
```javascript
const nodeStrategies = [
  // Strategy 1: Aria labels
  (node) => node.querySelector('[aria-label*="user"]') ||
            node.querySelector('[aria-label*="assistant"]'),

  // Strategy 2: Data attributes
  (node) => node.querySelector('[data-author]') ||
            node.querySelector('[data-message-role]'),

  // Strategy 3: Class patterns (last resort)
  (node) => node.querySelector('.prose, .markdown') ||
            node.querySelector('[class*="message"]'),

  // Strategy 4: Structural heuristics
  (node) => {
    // User messages typically have avatar on right, assistant on left
    const hasAvatar = node.querySelector('img[alt*="avatar"]');
    const isRightAligned = window.getComputedStyle(node).textAlign === 'right';
    return hasAvatar && isRightAligned ? 'user' : 'assistant';
  }
];

function extractWithStrategies(node) {
  for (const strategy of nodeStrategies) {
    try {
      const result = strategy(node);
      if (result) return result;
    } catch (e) {
      // Strategy failed, try next
    }
  }
  return null;  // All strategies failed
}
```

**Advantages:**
- ✅ **Incremental**: Build on existing PoC
- ✅ **No Architecture Change**: Stays in DOM layer
- ✅ **Lower Risk**: Smaller changes, easier to test
- ✅ **Faster Implementation**: 2-3 hours vs 6-8 hours

**Challenges:**
- ⚠️ **Still DOM-Dependent**: Fundamental fragility remains
- ⚠️ **Complexity Creep**: More strategies = more to maintain
- ⚠️ **Diminishing Returns**: Only delays inevitable breakage

**Implementation Effort:** 2-3 hours
**Maintenance Risk:** MEDIUM-HIGH
**Reliability:** MEDIUM

---

### 🔬 Solution 4: Machine Learning Approach (EXPERIMENTAL)

**Concept**: Train a simple classifier to identify message nodes

**Architecture:**
```javascript
// Collect features from DOM nodes
function extractFeatures(node) {
  return {
    hasAvatar: !!node.querySelector('img'),
    wordCount: node.textContent.split(/\s+/).length,
    position: getRelativePosition(node),
    hasCodeBlock: !!node.querySelector('code, pre'),
    textLength: node.textContent.length,
    depth: getDOMDepth(node),
    siblings: node.parentElement?.children.length,
    ariaRole: node.getAttribute('role') || '',
    className: node.className || ''
  };
}

// Lightweight decision tree (hand-coded, not ML training needed)
function classifyNode(features) {
  if (features.hasAvatar && features.wordCount > 5) {
    // Likely a message
    if (features.position === 'right' || features.ariaRole.includes('user')) {
      return 'user';
    } else {
      return 'assistant';
    }
  }
  return null;  // Not a message
}
```

**Advantages:**
- ✅ **Adaptive**: Can learn from DOM structure changes
- ✅ **Multi-Signal**: Combines many weak signals for strong prediction
- ✅ **Testable**: Can measure precision/recall

**Challenges:**
- ⚠️ **Overkill**: Too complex for this use case
- ⚠️ **Training Data**: Need labeled examples
- ⚠️ **Model Drift**: DOM changes invalidate training

**Implementation Effort:** 10-12 hours
**Maintenance Risk:** HIGH
**Reliability:** UNKNOWN

**Verdict:** Interesting but impractical. Stick to simpler solutions.

---

## 📊 Solution Comparison Matrix

| Solution | Robustness | Maintenance | Effort | Reliability | Recommendation |
|----------|------------|-------------|--------|-------------|----------------|
| **WebSocket Interception** | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | 4-6h | 95% | **Best Long-Term** |
| **Hybrid Approach** | ⭐⭐⭐⭐⭐ | ⭐⭐⭐ | 6-8h | 99% | **Best Overall** |
| **Improved DOM** | ⭐⭐⭐ | ⭐⭐ | 2-3h | 70% | **Quick Win** |
| **ML Approach** | ⭐⭐ | ⭐ | 10-12h | 60% | **Not Recommended** |
| **Current PoC** | ⭐⭐ | ⭐ | 0h | 50% | **Proof of Concept** |

---

## 🎯 Recommended Path Forward

### Phase 1: Validate PoC (Current)
- [x] Implement DOM observer
- [ ] Test with real voice input
- [ ] Verify Supabase integration
- [ ] Document fragility

**Decision Point**: Does PoC work at all?

---

### Phase 2: Quick Improvements (2-3 hours)
**If PoC works but fragile:**

1. **Strengthen Role Detection**
   - Add aria-label priority
   - Add data-attribute fallback
   - Add position-based heuristics

2. **Add Streaming Deduplication**
   - Detect and merge streaming chunks
   - Wait 2s after last update before dispatching

3. **Improve Noise Filtering**
   - Expand `ignorePatterns`
   - Raise minimum length to 15 chars
   - Filter by word count (< 3 words = likely UI)

**Deliverable**: More stable DOM capture (70% → 85% reliability)

---

### Phase 3: WebSocket Interception (4-6 hours)
**After PoC validated:**

1. **Reverse Engineer WebSocket Protocol**
   - Capture traffic in DevTools
   - Identify transcript message format
   - Document authentication mechanism

2. **Implement WebSocket Wrapper**
   - Intercept only `ws.chatgpt.com/ws/user/` connections
   - Parse transcript messages
   - Dispatch to existing pipeline

3. **Testing**
   - Verify voice input still works
   - Confirm transcripts captured
   - Test edge cases (network errors, reconnections)

**Deliverable**: Robust WebSocket-based capture (95% reliability)

---

### Phase 4: Hybrid Fallback (2-3 hours)
**After WebSocket working:**

1. **Keep Both Methods**
   - WebSocket as primary
   - DOM observer as fallback

2. **Add Deduplication**
   - Hash-based duplicate detection
   - Timestamp-based expiry
   - Confidence-based priority

3. **Monitoring**
   - Track which method captures what
   - Log fallback usage
   - Alert if WebSocket consistently fails

**Deliverable**: Bulletproof hybrid system (99% reliability)

---

## 🔍 Research Tasks

Before implementing WebSocket interception, investigate:

### WebSocket Message Format
**How to Research:**
1. Open ChatGPT with DevTools
2. Go to Network → WS
3. Click on `wss://ws.chatgpt.com/ws/user/...`
4. Go to "Messages" tab
5. Perform voice input
6. Document:
   - Binary frames (audio upload)
   - Text frames (transcript response)
   - JSON structure

**Questions to Answer:**
- What does a transcript message look like?
- Is it `{type: 'transcript', text: '...'}` or different?
- Are there metadata fields (confidence, language, etc.)?
- How are errors handled?

### WebSocket Lifecycle
**Questions to Answer:**
- Does WebSocket open once per session or per voice input?
- Is there an auth handshake?
- Can we intercept without breaking connection?
- What happens on reconnection?

### Alternative Endpoints
**Questions to Answer:**
- Does voice use any HTTP endpoints after WebSocket?
- Is transcript stored in local state before submission?
- Can we intercept at `postMessage` level?

---

## 🚀 Implementation Checklist

### WebSocket Interception Implementation

#### Phase A: Research (1 hour)
- [ ] Capture WebSocket traffic in DevTools
- [ ] Identify transcript message format
- [ ] Document authentication mechanism
- [ ] Test WebSocket connection stability

#### Phase B: Wrapper Implementation (2 hours)
- [ ] Create WebSocket wrapper in inject.js
- [ ] Filter only ChatGPT voice WebSocket
- [ ] Add message event listener
- [ ] Parse transcript JSON
- [ ] Dispatch to `KYT_MESSAGE_CAPTURED`

#### Phase C: Testing (1-2 hours)
- [ ] Test voice input still works
- [ ] Verify transcripts captured
- [ ] Test with poor network (disconnections)
- [ ] Test with rapid voice inputs
- [ ] Verify assistant responses still captured (fetch)

#### Phase D: Integration (1 hour)
- [ ] Add health check statistics
- [ ] Add error handling
- [ ] Add debug logging
- [ ] Update documentation

---

## 🎓 Lessons Learned

### What Worked in PoC
- ✅ DOM observer captures visible content reliably
- ✅ Event dispatch mechanism reuses existing infrastructure
- ✅ WeakSet prevents duplicate captures
- ✅ Filtering UI noise mostly effective

### What Needs Improvement
- ⚠️ Role inference unreliable without aria-labels
- ⚠️ Streaming messages create duplicates
- ⚠️ DOM structure dependency too fragile
- ⚠️ No confidence scoring for captures

### Key Insights
1. **Intercept at source, not presentation**: WebSocket > DOM
2. **Defense in depth**: Multiple capture methods better than one
3. **Confidence matters**: Tag each capture with reliability
4. **Test early**: PoC validation prevents wasted effort

---

## 📚 References

### ChatGPT Greeting Exchange Conversation
- WebSocket discovery: Lines 190-215
- DOM capture patterns: Lines 2647-2668
- Fragility discussion: Lines 3159-3162
- DOM-agnostic approach: Lines 3239-3318

### Existing Codebase
- Fetch interception: `platforms/chatgpt/inject.js` lines 31-74
- Event dispatch: `platforms/chatgpt/inject.js` lines 480-482
- Content script: `platforms/chatgpt/content_test.js`

### External Resources
- [WebSocket API - MDN](https://developer.mozilla.org/en-US/docs/Web/API/WebSocket)
- [MutationObserver - MDN](https://developer.mozilla.org/en-US/docs/Web/API/MutationObserver)
- [OpenAI Realtime API](https://openai.com/index/introducing-our-next-generation-audio-models/)

---

## 🎯 Next Action

**Immediate:** Test PoC with user
**Short-term:** Implement quick improvements if PoC works
**Medium-term:** Research and implement WebSocket interception
**Long-term:** Deploy hybrid approach with both methods

---

**Status**: Ready for user testing and feedback-driven iteration
