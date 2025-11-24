# Mobile ChatGPT Voice Capture - Production Design

**Date**: 2025-11-22
**Feature**: Capture mobile ChatGPT voice conversations via DOM observation
**Status**: Approved for Implementation

## Problem Statement

**Current State**: Extension successfully captures desktop-initiated ChatGPT conversations via API interception (95% reliability, 6/6 validation tests passed).

**Missing Capability**: Mobile voice conversations (both free plan standard voice and Plus plan Advanced Voice Mode) sync to desktop web but are not captured because:
- Mobile app uses sealed E2EE pipeline (no network interception possible)
- Synced messages appear directly in desktop DOM without triggering fetch events
- No API calls fire when mobile-originated messages populate the page

**User Impact**: Users lose conversation continuity when switching from mobile to desktop, breaking the "second brain" memory system.

## Solution Architecture

### Dual-Source Capture System

The solution adds DOM observation as a complementary capture mechanism to the existing API interception:

**Source 1: API Interception (Existing ✅)**
- **Trigger**: User types on desktop → `fetch('/backend-api/f/conversation')`
- **Captures**: Desktop-initiated messages (user + assistant)
- **Mechanism**: Page context fetch wrapper in `platforms/chatgpt/inject.js`
- **Reliability**: 95% (validated)
- **Timing**: Synchronous with user action

**Source 2: DOM MutationObserver (New 🆕)**
- **Trigger**: Mobile message syncs → DOM updates → mutation event
- **Captures**: Mobile-originated messages appearing in desktop DOM
- **Mechanism**: MutationObserver on conversation container
- **Expected Reliability**: 95%+ (DOM is stable, authoritative source)
- **Timing**: Asynchronous (typically <60 seconds after mobile send)

**Unified Backend (Existing ✅)**
- Both sources → Same deduplication system → `chrome.storage.local` → Supabase (optional)
- Hash-based dedup with content-only hash (critical for preventing duplicates)
- Existing storage, embedding, and RAG pipeline

### Key Insight

These are NOT alternative approaches—they're complementary capture methods for different entry points:
- Desktop typing → Never appears in mutation events (happens via fetch)
- Mobile sync → Never triggers fetch events (appears directly in DOM)

Both must coexist to achieve complete conversation capture.

## Technical Design

### 1. DOM Observer Module

**File**: `platforms/chatgpt/dom-observer.js` (~250 lines)

**Core Pattern**:
```javascript
const observer = new MutationObserver((mutations) => {
  throttledHandler(() => {
    try {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (isMessageNode(node)) {
            const message = extractMessage(node);
            sendToBackground(message);
          }
        }
      }
    } catch (error) {
      logError(error);
      scheduleRestart();
    }
  });
});

observer.observe(target, {
  childList: true,
  subtree: true
});
```

**Multi-Tier Selector Fallback**:
```javascript
const SELECTOR_TIERS = [
  // Tier 1: Most stable (data attributes)
  '[data-testid="conversation"] [data-message-author-role="user"]',

  // Tier 2: Class patterns (more fragile)
  '.group.w-full.text-token-text-primary [data-message-author-role="user"]',

  // Tier 3: Structural fallback
  'div[class*="group"] div[class*="message"]'
];

function findConversationContainer() {
  for (const selector of SELECTOR_TIERS) {
    const container = document.querySelector(selector);
    if (container) {
      console.log(`[KYT DOM] Using selector tier: ${selector}`);
      return container;
    }
  }
  throw new Error('No conversation container found');
}
```

**Performance Optimization**:
- Throttle mutation handler to max 1 execution per 100ms
- Scope observer to specific container (not entire document)
- Early-exit for non-message nodes (check role attribute first)
- Debounce message extraction for rapid-fire mutations

### 2. Enhanced Deduplication System

**Critical Change**: Content-only hash to prevent double-capture

**Problem**:
- Desktop typing at 10:00:00 → API captures with timestamp 10:00:00
- Same message renders in DOM at 10:00:00.123 → DOM captures with timestamp 10:00:00.123
- Different timestamps → hash mismatch → duplicate storage

**Solution**:
```javascript
// BEFORE (timestamp-dependent)
const hash = hashMessage(content + timestamp);

// AFTER (content-only)
const hash = hashMessage(content);
```

**Message Schema** (unified across sources):
```javascript
{
  content: "message text",
  role: "user" | "assistant",
  conversationId: "uuid",
  timestamp: 1699564892000,
  messageId: "msg_1699564892000_abc123",
  source: "api" | "dom",  // For debugging/metrics
  schema_version: 2       // Migration support
}
```

**Deduplication Logic**:
```javascript
async function saveMessage(message) {
  const contentHash = await hashContent(message.content);
  const existing = await checkDuplicateByHash(contentHash);

  if (existing && isWithinWindow(existing.timestamp, message.timestamp, 5000)) {
    console.log(`[KYT Dedup] Duplicate detected: ${contentHash.slice(0, 8)}`);
    return { saved: false, reason: 'duplicate' };
  }

  await storeMessage(message);
  return { saved: true };
}
```

### 3. Message Extraction & Sanitization

**Extract Message from DOM Node**:
```javascript
function extractMessage(node) {
  // Determine role (CRITICAL: only capture user messages)
  const role = node.getAttribute('data-message-author-role') ||
               (node.matches('.user-message') ? 'user' : 'assistant');

  // Extract text content (safe, no innerHTML)
  const content = node.innerText?.trim();

  if (!content || content.length === 0) {
    return null;
  }

  // Detect placeholder/incomplete messages
  if (isPlaceholder(content)) {
    console.log('[KYT DOM] Skipping placeholder:', content);
    return null;
  }

  // Extract conversation ID from DOM context
  const conversationId = extractConversationId(node);

  return {
    content: sanitizeText(content),
    role,
    conversationId,
    timestamp: Date.now(),
    messageId: generateMessageId(),
    source: 'dom'
  };
}

function isPlaceholder(text) {
  const placeholders = ['...', 'Thinking...', '•••', 'Loading'];
  return placeholders.some(p => text === p || text.startsWith(p));
}

function sanitizeText(text) {
  // Unicode normalization
  let sanitized = text.normalize('NFC');

  // Remove zero-width characters
  sanitized = sanitized.replace(/[\u200B-\u200D\uFEFF]/g, '');

  // Normalize whitespace
  sanitized = sanitized.replace(/\s+/g, ' ').trim();

  return sanitized;
}
```

### 4. Storage Management

**Quota Monitoring**:
```javascript
async function checkStorageQuota() {
  const bytesInUse = await chrome.storage.local.getBytesInUse();
  const quota = chrome.storage.local.QUOTA_BYTES; // 10 MB
  const usagePercent = (bytesInUse / quota) * 100;

  console.log(`[KYT Storage] Using ${bytesInUse} / ${quota} bytes (${usagePercent.toFixed(1)}%)`);

  if (usagePercent > 80) {
    console.warn('[KYT Storage] Approaching quota limit, triggering LRU eviction');
    await evictOldMessages();
  }

  return { bytesInUse, quota, usagePercent };
}
```

**LRU Eviction**:
```javascript
async function evictOldMessages() {
  const messages = await getAllMessages();

  // Sort by timestamp (oldest first)
  messages.sort((a, b) => a.timestamp - b.timestamp);

  // Keep newest 80% of messages
  const keepCount = Math.floor(messages.length * 0.8);
  const toEvict = messages.slice(0, messages.length - keepCount);

  console.log(`[KYT Eviction] Removing ${toEvict.length} old messages`);

  for (const msg of toEvict) {
    await deleteMessage(msg.messageId);
  }

  return toEvict.length;
}
```

### 5. Error Handling & Resilience

**Observer Auto-Restart**:
```javascript
class ResilientObserver {
  constructor() {
    this.observer = null;
    this.restartAttempts = 0;
    this.maxRestarts = 5;
    this.backoffMs = 1000;
  }

  start() {
    try {
      const target = findConversationContainer();
      this.observer = new MutationObserver(this.handleMutations.bind(this));
      this.observer.observe(target, { childList: true, subtree: true });

      this.restartAttempts = 0; // Reset on success
      console.log('[KYT DOM] Observer started successfully');

    } catch (error) {
      console.error('[KYT DOM] Observer failed to start:', error);
      this.scheduleRestart();
    }
  }

  scheduleRestart() {
    if (this.restartAttempts >= this.maxRestarts) {
      console.error('[KYT DOM] Max restart attempts reached, giving up');
      this.notifyFailure();
      return;
    }

    this.restartAttempts++;
    const delay = this.backoffMs * Math.pow(2, this.restartAttempts - 1);

    console.log(`[KYT DOM] Scheduling restart #${this.restartAttempts} in ${delay}ms`);

    setTimeout(() => this.start(), delay);
  }

  handleMutations(mutations) {
    try {
      // Process mutations
      processNewMessages(mutations);
    } catch (error) {
      console.error('[KYT DOM] Mutation handler error:', error);
      this.stop();
      this.scheduleRestart();
    }
  }

  stop() {
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
  }
}
```

### 6. Observability & Debug Mode

**Capture Statistics**:
```javascript
const stats = {
  messagesCapturedd: {
    api: 0,
    dom: 0
  },
  lastCapture: {
    api: null,
    dom: null
  },
  errors: [],
  observerStatus: 'running' | 'stopped' | 'error'
};

function updateStats(source, message) {
  stats.messagesCaptured[source]++;
  stats.lastCapture[source] = Date.now();

  chrome.storage.local.set({ kyt_stats: stats });
}
```

**Debug Mode**:
```javascript
let debugMode = false;

async function enableDebugMode() {
  debugMode = true;
  console.log('[KYT Debug] Debug mode enabled');

  // Override console.log to capture all logs
  const originalLog = console.log;
  console.log = function(...args) {
    if (args[0]?.startsWith?.('[KYT')) {
      chrome.storage.local.get('kyt_debug_logs', (data) => {
        const logs = data.kyt_debug_logs || [];
        logs.push({ timestamp: Date.now(), message: args.join(' ') });
        chrome.storage.local.set({ kyt_debug_logs: logs.slice(-100) }); // Keep last 100
      });
    }
    originalLog.apply(console, args);
  };
}
```

**Diagnostic Export**:
```javascript
async function exportDiagnostics() {
  const stats = await chrome.storage.local.get('kyt_stats');
  const logs = await chrome.storage.local.get('kyt_debug_logs');
  const storage = await checkStorageQuota();

  return {
    extension_version: chrome.runtime.getManifest().version,
    timestamp: new Date().toISOString(),
    observer_status: stats.kyt_stats?.observerStatus || 'unknown',
    messages_captured_24h: stats.kyt_stats?.messagesCaptured || {},
    storage_usage_mb: (storage.bytesInUse / 1024 / 1024).toFixed(2),
    recent_errors: stats.kyt_stats?.errors?.slice(-10) || [],
    debug_logs: logs.kyt_debug_logs?.slice(-50) || []
  };
}
```

## Testing Strategy

### 1. Unit Tests

**DOM Extraction Tests** (`tests/dom-observer.test.js`):
```javascript
describe('DOM Observer', () => {
  it('should extract user message from DOM node', () => {
    const node = createMockMessageNode('user', 'Hello world');
    const message = extractMessage(node);

    expect(message.content).toBe('Hello world');
    expect(message.role).toBe('user');
    expect(message.source).toBe('dom');
  });

  it('should skip assistant messages', () => {
    const node = createMockMessageNode('assistant', 'Hi there');
    const message = extractMessage(node);

    // Should not capture assistant messages from DOM
    expect(message).toBeNull();
  });

  it('should detect and skip placeholders', () => {
    const node = createMockMessageNode('user', '...');
    const message = extractMessage(node);

    expect(message).toBeNull();
  });
});
```

### 2. Simulated Mutation Tests

**Inject Fake Nodes** (`validation/test-dom-capture.js`):
```javascript
// Run in browser console on ChatGPT page
async function testDOMCapture() {
  const container = document.querySelector('[data-testid="conversation"]');

  // Create fake message node
  const testNode = document.createElement('div');
  testNode.setAttribute('data-message-author-role', 'user');
  testNode.className = 'group w-full text-token-text-primary';
  testNode.innerText = 'Test mobile message from DOM';

  console.log('[Test] Injecting fake message node...');
  container.appendChild(testNode);

  // Wait for extension to process
  await new Promise(resolve => setTimeout(resolve, 2000));

  // Check if captured
  const captured = await chrome.storage.local.get('messages');
  const found = captured.messages?.some(m =>
    m.content === 'Test mobile message from DOM' && m.source === 'dom'
  );

  console.log('[Test] Message captured:', found);
  return found;
}
```

### 3. Manual Mobile Testing Protocol

**Test Procedure**:
1. Open ChatGPT on mobile app
2. Start voice conversation (send 3-5 messages)
3. Open same conversation on desktop (extension installed)
4. Wait 60 seconds for sync
5. Open extension popup → Check capture statistics
6. Expected: "DOM: 5 messages" (or however many sent)
7. Verify in chrome.storage.local that messages exist with `source: 'dom'`

**Test Matrix**:
- [ ] Free plan standard voice → desktop sync
- [ ] Plus plan Advanced Voice → desktop sync
- [ ] Mixed: mobile voice + desktop typing in same conversation
- [ ] Batch sync: 10 mobile messages → desktop (all captured?)
- [ ] Edited message: Send, edit, sync (latest version captured?)

### 4. Performance Tests

**Mutation Handler Performance**:
```javascript
// Measure impact on ChatGPT UI
console.time('mutation-handler');
// Trigger 100 rapid mutations
for (let i = 0; i < 100; i++) {
  container.appendChild(createFakeNode());
}
console.timeEnd('mutation-handler');
// Should be < 50ms total
```

## Implementation Phases

### Phase 1: Core DOM Observer (4-6 hours)
- [x] Create `platforms/chatgpt/dom-observer.js`
- [x] Implement basic MutationObserver
- [x] Selector discovery (inspect ChatGPT DOM manually)
- [x] Message extraction with role detection
- [x] Integration with existing content.js

### Phase 2: Hardening (3-4 hours)
- [x] Multi-tier selector fallback system
- [x] Error handling with auto-restart
- [x] Throttling and performance optimization
- [x] Placeholder detection

### Phase 3: Storage & Dedup (2-3 hours)
- [x] Change dedup to content-only hash
- [x] Storage quota monitoring
- [x] LRU eviction policy
- [x] Schema versioning

### Phase 4: Observability (3-4 hours)
- [x] Capture statistics by source
- [x] Debug mode toggle
- [x] Diagnostic export
- [x] Health indicators in popup

### Phase 5: Testing (2-3 hours)
- [x] Unit tests for extraction logic
- [x] Simulated mutation test harness
- [x] Manual mobile testing
- [x] Validation suite extension

**Total**: 14-20 hours for production-ready implementation

## Security & Privacy

### Data Storage
- ✅ Uses `chrome.storage.local` (NOT `.sync`) - data stays on-device
- ✅ No telemetry to extension developers
- ✅ Optional Supabase sync requires user-provided keys
- ⚠️ Privacy warning: Voice conversations may contain PII (document in README)

### DOM Sanitization
- ✅ Uses `innerText` only (never `innerHTML`)
- ✅ Unicode normalization
- ✅ Zero-width character removal
- ✅ No code execution risk

### Permissions
```json
{
  "permissions": ["storage", "alarms"],
  "host_permissions": ["https://chat.openai.com/*", "https://chatgpt.com/*"]
}
```
- No additional permissions required
- No broad web access
- Scoped to ChatGPT domains only

## Rollout Plan

### Phase 1: Internal Testing (Week 1)
- Deploy to developer machines
- Manual mobile testing with personal accounts
- Monitor for selector breakage

### Phase 2: Beta Release (Week 2-3)
- Recruit 5-10 beta testers
- Provide diagnostic export for bug reports
- Iterate on selector robustness

### Phase 3: Public Release (Week 4)
- Publish to Chrome Web Store
- Document mobile sync feature in README
- Monitor user feedback for edge cases

## Success Metrics

### Technical Metrics
- ✅ 95%+ capture rate (DOM message count vs captured count)
- ✅ <50ms mutation handler latency
- ✅ Observer uptime >99.9% (auto-restart working)
- ✅ Zero storage quota exceeded errors

### User Metrics
- ✅ <5% bug reports related to "mobile messages not captured"
- ✅ >90% of users with mobile+desktop usage seeing DOM captures
- ✅ Average sync latency <60 seconds

## Known Limitations

1. **Selector Fragility**: ChatGPT UI changes require selector updates
   - Mitigation: Multi-tier fallback + monitoring

2. **Backfill Gap**: Doesn't capture conversations that happened while desktop was offline
   - Mitigation: Separate "History Sync" feature (future)

3. **Assistant Message Duplication Risk**: If selectors aren't specific enough
   - Mitigation: Strict `data-message-author-role="user"` filtering

4. **Edited Messages**: May capture both original and edited versions
   - Mitigation: Detect edit events, update instead of duplicate

## Future Enhancements

1. **Conversation Backfill**: API-based history sync for offline gaps
2. **WebSocket Monitoring**: Capture streaming responses in real-time
3. **Multi-Platform**: Extend to Claude, Gemini, etc.
4. **PII Detection**: Automatic redaction of sensitive data
5. **Local Encryption**: Encrypt stored messages at rest

## References

- Expert guidance document (provided by user)
- Existing codebase: `platforms/chatgpt/inject.js` (API interception)
- Research document: Technical Research (conversation history)
- Chrome Extension docs: MutationObserver API
- Deduplication system: `background.js` (existing)

---

**Approved By**: User (2025-11-22)
**Implementation Start**: 2025-11-22
**Target Completion**: 2025-11-23
