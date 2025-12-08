# Mobile Voice Capture - Testing Procedures

## Overview

This document provides comprehensive testing procedures for validating the mobile voice capture feature. The feature enables KYT Memory Extension to capture ChatGPT messages that originate from mobile voice conversations and sync to the desktop interface.

## Test Environment Setup

### Prerequisites

1. **Chrome Browser** with extension loaded in developer mode
2. **ChatGPT Account** with mobile app installed
3. **Extension Files** from the `feature/mobile-voice-capture` branch

### Loading the Extension

1. Navigate to `chrome://extensions/`
2. Enable "Developer mode" (top right toggle)
3. Click "Load unpacked"
4. Select the `/home/penguinzyue/kyt-validation-sprint` directory
5. Verify extension appears with green "Service worker" status

### Accessing Test Tools

**Browser Console**:
- Press `F12` or `Ctrl+Shift+I` (Windows/Linux) / `Cmd+Opt+I` (Mac)
- Navigate to the "Console" tab

**Service Worker Console** (for background.js logs):
- Navigate to `chrome://extensions/`
- Click "Service worker" link under the KYT Memory extension
- Separate console window will open showing background script logs

---

## Automated Test Suite

### Running the Automated Tests

1. **Load the test script**:
   ```bash
   # From project root
   cp scripts/test_mobile_voice_capture.js /tmp/test.js
   ```

2. **Navigate to ChatGPT**:
   - Open https://chatgpt.com/ or https://chat.openai.com/

3. **Open browser console** (F12)

4. **Inject test script**:
   ```javascript
   // Copy and paste the entire contents of test_mobile_voice_capture.js
   // Or load it via console snippets
   ```

5. **Run tests**:
   ```javascript
   // Tests auto-run after 2 seconds, or manually trigger:
   window.KYT_TEST_MOBILE_VOICE_CAPTURE();
   ```

### Expected Test Results

**All tests passing**:
```
🧪 Running Mobile Voice Capture Validation Tests...

✅ Test 1: DOM Observer Initialization
   Observer running: true
   Restart attempts: 0

✅ Test 2: Content-Only Hash Deduplication
   Duplicate message blocked successfully

✅ Test 3: Storage Quota Management
   Quota check function exists
   Eviction function exists
   Storage usage: 15.3%

✅ Test 4: Dual-Source Capture Statistics
   API messages: 42
   DOM messages: 3
   Duplicates blocked: 1

✅ Test 5: Error Handling and Auto-Restart
   Observer restart mechanism verified
   Max restart attempts: 5
   Exponential backoff: true

✅ Test 6: Debug Mode Integration
   Debug mode toggle available
   Debug mode currently: false

✅ Test 7: Queue Manager Integration
   Queue manager loaded: true
   Fallback queue available: true

📊 Test Summary: 7/7 passed (100%)
```

### Interpreting Test Failures

**Test 1 Failure** (DOM Observer not running):
```
❌ Test 1: DOM Observer Initialization
   Observer running: false
   
Troubleshooting:
1. Check browser console for "[KYT DOM]" error messages
2. Verify dom-observer.js loaded: check Network tab for 200 status
3. Confirm conversation container exists: document.querySelector('[data-testid="conversation"]')
4. Try manual restart: window.dispatchEvent(new CustomEvent('KYT_DOM_COMMAND', {detail: {command: 'restart'}}))
```

**Test 2 Failure** (Deduplication not working):
```
❌ Test 2: Content-Only Hash Deduplication
   Expected 1 message, found 2
   
Troubleshooting:
1. Check if deduplication.js loaded before content.js
2. Verify window.KYT_Deduplicator exists in page console
3. Check Service Worker console for "Duplicate blocked" messages
4. Inspect chrome.storage.local: chrome.storage.local.get(['captured_messages'], console.log)
```

**Test 3 Failure** (Storage quota management missing):
```
❌ Test 3: Storage Quota Management
   Quota check function not found in background.js
   
Troubleshooting:
1. Verify background.js contains checkStorageQuota() function
2. Check Service Worker console for "📊 Storage:" messages
3. Reload extension: chrome://extensions/ → click reload icon
4. Verify STORAGE_CONFIG constants exist
```

---

## Manual Testing Procedures

### Test 1: Mobile Voice Message Capture

**Objective**: Verify DOM observer captures mobile-synced messages

**Steps**:
1. **On mobile device**:
   - Open ChatGPT app
   - Start a new conversation
   - Send a voice message: "This is a test from mobile voice"
   - Wait for conversation to sync to desktop

2. **On desktop browser**:
   - Open the same conversation on https://chatgpt.com/
   - Open browser console (F12)
   - Wait for message to appear in chat interface
   - Look for console log: `📱 KYT ChatGPT Content: Received message from DOM observer (Mobile Sync)`

3. **Verify capture**:
   ```javascript
   // In browser console
   chrome.storage.local.get(['captured_messages'], (result) => {
     const messages = result.captured_messages || [];
     const mobileMessage = messages.find(m => 
       m.content.includes('This is a test from mobile voice') && 
       m.source === 'dom'
     );
     console.log('Mobile message captured:', mobileMessage ? '✅' : '❌');
     if (mobileMessage) {
       console.log('Message details:', mobileMessage);
     }
   });
   ```

**Expected Result**: 
- Console shows `📱 KYT ChatGPT Content: Received message from DOM observer`
- Message found in storage with `source: 'dom'`
- Service Worker console shows `✅ Message saved`

**Failure Troubleshooting**:
- Message not captured → Check DOM observer health: `window.dispatchEvent(new CustomEvent('KYT_DOM_COMMAND', {detail: {command: 'getHealth'}}))`
- Wrong source (API instead of DOM) → Voice message may have triggered API event, retest with text-only mobile message

---

### Test 2: Deduplication Across Sources

**Objective**: Verify same message from API and DOM is deduplicated

**Steps**:
1. **Create duplicate scenario**:
   ```javascript
   // In browser console on ChatGPT
   const testContent = `Dedup test ${Date.now()}`;
   
   // Simulate API capture
   window.dispatchEvent(new CustomEvent('KYT_MESSAGE_CAPTURED', {
     detail: {
       content: testContent,
       role: 'user',
       conversationId: 'test-conv',
       timestamp: Date.now(),
       messageId: `msg_api_${Date.now()}`,
       source: 'api',
       captureMethod: 'fetch'
     }
   }));
   
   // Wait 100ms
   setTimeout(() => {
     // Simulate DOM capture of same content
     window.dispatchEvent(new CustomEvent('KYT_DOM_MESSAGE_CAPTURED', {
       detail: {
         content: testContent,
         role: 'user',
         conversationId: 'test-conv',
         timestamp: Date.now(),
         messageId: `msg_dom_${Date.now()}`,
         source: 'dom'
       }
     }));
   }, 100);
   ```

2. **Wait 2 seconds** for processing

3. **Verify deduplication**:
   ```javascript
   chrome.storage.local.get(['captured_messages'], (result) => {
     const messages = result.captured_messages || [];
     const matches = messages.filter(m => m.content.includes('Dedup test'));
     console.log(`Found ${matches.length} messages (expected: 1)`);
     if (matches.length === 1) {
       console.log('✅ Deduplication working correctly');
     } else {
       console.log('❌ Deduplication failed - duplicate saved');
       console.log('Messages:', matches);
     }
   });
   ```

4. **Check Service Worker console** for:
   ```
   🔍 Deduplicator: Duplicate message detected (content hash: abc123...)
   ⚠️ Duplicate message blocked (hash: abc123...)
   ```

**Expected Result**: Only 1 message saved, Service Worker shows "Duplicate message blocked"

**Failure Troubleshooting**:
- Both messages saved → Check if window.KYT_Deduplicator exists in page console
- No dedup log → Verify deduplication.js loaded before content.js in manifest.json

---

### Test 3: Storage Quota Management

**Objective**: Verify LRU eviction when storage exceeds 80%

**Steps**:
1. **Fill storage to near capacity**:
   ```javascript
   // In Service Worker console (chrome://extensions/ → Service worker)
   
   async function fillStorage() {
     const result = await chrome.storage.local.get(['captured_messages']);
     const messages = result.captured_messages || [];
     
     // Add messages until ~75% full
     const targetSize = chrome.storage.local.QUOTA_BYTES * 0.75;
     let currentSize = JSON.stringify(messages).length;
     
     console.log(`Current size: ${(currentSize/1024/1024).toFixed(2)}MB`);
     console.log(`Target size: ${(targetSize/1024/1024).toFixed(2)}MB`);
     
     let counter = 0;
     while (currentSize < targetSize) {
       const filler = {
         content: 'X'.repeat(1000) + ` ${counter}`,
         timestamp: Date.now() - (100000 - counter) * 1000,
         messageId: `filler_${counter}`,
         capturedAt: Date.now() - (100000 - counter) * 1000
       };
       messages.push(filler);
       counter++;
       currentSize = JSON.stringify(messages).length;
       
       if (counter % 100 === 0) {
         console.log(`Added ${counter} messages, size: ${(currentSize/1024/1024).toFixed(2)}MB`);
       }
     }
     
     await chrome.storage.local.set({ captured_messages: messages });
     console.log(`✅ Storage filled: ${messages.length} messages, ${(currentSize/1024/1024).toFixed(2)}MB`);
   }
   
   fillStorage();
   ```

2. **Trigger quota check**:
   ```javascript
   // In Service Worker console
   const status = await checkStorageQuota();
   console.log('Quota status:', status);
   ```

3. **Add message to trigger eviction**:
   ```javascript
   // Simulate new message that pushes over 80%
   const result = await chrome.storage.local.get(['captured_messages']);
   const messages = result.captured_messages || [];
   
   messages.push({
     content: 'Trigger message ' + 'X'.repeat(50000),
     timestamp: Date.now(),
     messageId: `trigger_${Date.now()}`,
     capturedAt: Date.now()
   });
   
   await chrome.storage.local.set({ captured_messages: messages });
   
   // Manually trigger quota check and eviction
   const quotaStatus = await checkStorageQuota();
   console.log(`📊 Storage: ${quotaStatus.usagePercent.toFixed(1)}%`);
   
   if (quotaStatus.isExceeded) {
     console.log('⚠️ Quota exceeded - triggering eviction');
     const evictionResult = await evictOldMessages();
     console.log('Eviction result:', evictionResult);
   }
   ```

4. **Verify eviction**:
   ```javascript
   const afterStatus = await checkStorageQuota();
   console.log(`After eviction: ${afterStatus.usagePercent.toFixed(1)}% (${afterStatus.messageCount} messages)`);
   ```

**Expected Result**:
```
⚠️ Storage quota exceeded (82.3% > 80%)
🗑️ Storage quota exceeded - starting LRU eviction...
✅ Eviction complete:
   Evicted: 1247 messages
   Remaining: 3891 messages
   Old usage: 82.3%
   New usage: 69.8%
```

**Failure Troubleshooting**:
- Eviction not triggered → Check if checkStorageQuota() is called in saveMessage()
- Usage still > 80% → Verify evictOldMessages() sorts by oldest timestamp
- MIN_MESSAGES_TO_KEEP error → Ensure at least 100 messages remain

---

### Test 4: Error Handling and Auto-Restart

**Objective**: Verify DOM observer restarts after failure

**Steps**:
1. **Simulate observer failure**:
   ```javascript
   // In browser console on ChatGPT
   
   // Send stop command
   window.dispatchEvent(new CustomEvent('KYT_DOM_COMMAND', {
     detail: { command: 'stop' }
   }));
   
   console.log('Observer stopped - waiting for auto-restart...');
   ```

2. **Monitor restart attempts**:
   ```javascript
   // Listen for restart status
   let restartCount = 0;
   window.addEventListener('KYT_DOM_OBSERVER_STATUS', (event) => {
     console.log(`Observer status: ${event.detail.status}, restarts: ${event.detail.restartAttempts}`);
     if (event.detail.status === 'running' && event.detail.restartAttempts > 0) {
       console.log('✅ Auto-restart successful');
     }
   });
   
   // Trigger health check after 3 seconds
   setTimeout(() => {
     window.dispatchEvent(new CustomEvent('KYT_DOM_COMMAND', {
       detail: { command: 'getHealth' }
     }));
   }, 3000);
   ```

3. **Check health status**:
   ```javascript
   window.addEventListener('KYT_DOM_HEALTH', (event) => {
     console.log('Health:', event.detail);
   }, { once: true });
   
   window.dispatchEvent(new CustomEvent('KYT_DOM_COMMAND', {
     detail: { command: 'getHealth' }
   }));
   ```

**Expected Result**:
```
[KYT DOM] Observer stopped
[KYT DOM] Scheduling restart #1 in 1000ms
[KYT DOM] Found conversation container: DIV
[KYT DOM] Observer started successfully
Observer status: running, restarts: 0
✅ Auto-restart successful
```

**Failure Troubleshooting**:
- No restart → Check for "Max restart attempts reached" in console
- Immediate failure → Verify conversation container exists on page
- Exponential backoff not working → Check scheduleRestart() function logic

---

### Test 5: Debug Mode Toggle

**Objective**: Verify debug mode can be toggled and affects logging

**Steps**:
1. **Open extension popup**:
   - Click KYT Memory icon in Chrome toolbar
   - Popup should open showing statistics

2. **Enable debug mode**:
   - Look for "Debug Mode" toggle switch
   - Click to enable (switch should turn green/blue)

3. **Verify debug storage**:
   ```javascript
   // In browser console
   chrome.storage.local.get(['kytDebugMode'], (result) => {
     console.log('Debug mode enabled:', result.kytDebugMode);
   });
   ```

4. **Check debug logs**:
   ```javascript
   // In browser console on ChatGPT
   // With debug mode ON, you should see detailed logs:
   window.dispatchEvent(new CustomEvent('KYT_DOM_COMMAND', {
     detail: { command: 'enableDebug' }
   }));
   
   // Now trigger some activity
   window.dispatchEvent(new CustomEvent('KYT_DOM_COMMAND', {
     detail: { command: 'getHealth' }
   }));
   
   // You should see detailed [KYT DOM] logs
   ```

5. **Disable debug mode**:
   - Click toggle switch in popup again
   - Logs should become less verbose

**Expected Result**:
- Debug mode ON: Detailed `[KYT DOM]` logs visible
- Debug mode OFF: Only error logs visible
- Popup toggle reflects current state

**Failure Troubleshooting**:
- Toggle doesn't change state → Check popup.js event listener
- Logs still verbose when OFF → Verify debugMode flag check in log() function
- Storage not updating → Check chrome.storage.local.set() call in popup

---

### Test 6: Queue Manager Fallback

**Objective**: Verify queue manager falls back to local storage when service worker unavailable

**Steps**:
1. **Simulate service worker unavailability**:
   ```javascript
   // In Service Worker console (chrome://extensions/ → Service worker)
   // Close the Service Worker console window to simulate unavailability
   ```

2. **Trigger message capture**:
   ```javascript
   // In browser console on ChatGPT
   window.dispatchEvent(new CustomEvent('KYT_MESSAGE_CAPTURED', {
     detail: {
       content: 'Test message during SW unavailability',
       role: 'user',
       conversationId: 'test-fallback',
       timestamp: Date.now(),
       messageId: `msg_fallback_${Date.now()}`,
       source: 'api'
     }
   }));
   ```

3. **Check fallback queue**:
   ```javascript
   // In browser console
   chrome.storage.local.get(['kyt_local_queue'], (result) => {
     const queue = result.kyt_local_queue || [];
     console.log('Fallback queue length:', queue.length);
     console.log('Latest queued message:', queue[queue.length - 1]);
   });
   ```

4. **Reopen Service Worker console** to restore availability

5. **Verify queue processing**:
   - Service Worker console should show: `🔄 [KYT Processor] Processing queue: X items`
   - After processing: `✅ [KYT Processor] Synced message`

**Expected Result**:
```
⚠️ [KYT Queue] Service Worker unreachable for msg_fallback_xxx
📥 [KYT Queue] Enqueued to local storage (encrypted)
🔄 [KYT Processor] Processing queue: 1 items
✅ [KYT Processor] Synced message msg_fallback_xxx
```

**Failure Troubleshooting**:
- Message lost → Check if queue-manager.js loaded correctly
- No retry → Verify queue processor alarm is running
- Encryption error → Check if crypto.js loaded and key generated

---

## Statistics Validation

### Checking Capture Statistics

**In browser console on ChatGPT**:
```javascript
chrome.runtime.sendMessage({ type: 'GET_STATS' }, (response) => {
  console.log('📊 KYT Statistics:');
  console.log('  Total messages:', response.stats.totalMessages);
  console.log('  API messages:', response.stats.messagesBySource?.api || 0);
  console.log('  DOM messages:', response.stats.messagesBySource?.dom || 0);
  console.log('  Duplicates blocked:', response.stats.duplicatesBlocked || 0);
  console.log('  Storage usage:', response.stats.storageUsage);
  console.log('  DOM observer status:', response.stats.domObserverStatus);
});
```

**Expected Output**:
```
📊 KYT Statistics:
  Total messages: 127
  API messages: 124
  DOM messages: 3
  Duplicates blocked: 5
  Storage usage: 23.4%
  DOM observer status: running
```

### Storage Health Check

**In Service Worker console**:
```javascript
const quotaStatus = await checkStorageQuota();
console.log('Storage Health:');
console.log('  Usage:', quotaStatus.usagePercent.toFixed(1) + '%');
console.log('  Size:', (quotaStatus.storageSize / 1024 / 1024).toFixed(2) + 'MB');
console.log('  Limit:', (quotaStatus.storageLimitBytes / 1024 / 1024).toFixed(2) + 'MB');
console.log('  Messages:', quotaStatus.messageCount);
console.log('  Needs eviction:', quotaStatus.isExceeded);
```

---

## Performance Benchmarks

### DOM Observer Performance

**Throttling effectiveness**:
- Max 10 mutations/second (100ms throttle)
- Debounce settles in 50ms
- Should not impact page performance

**To measure**:
```javascript
// In browser console on ChatGPT
let mutationCount = 0;
const startTime = Date.now();

// Listen to health checks for mutation queue size
window.addEventListener('KYT_DOM_HEALTH', (event) => {
  console.log('Pending mutations:', event.detail.pendingMutations);
});

// Send health check every second for 10 seconds
const interval = setInterval(() => {
  window.dispatchEvent(new CustomEvent('KYT_DOM_COMMAND', {
    detail: { command: 'getHealth' }
  }));
}, 1000);

setTimeout(() => {
  clearInterval(interval);
  console.log('✅ Observer performance test complete');
}, 10000);
```

**Expected Result**: `pendingMutations` should never exceed 50 during normal chat usage

---

## Regression Testing

After making any changes to the mobile voice capture feature, run this regression test checklist:

- [ ] Automated test suite passes 100%
- [ ] Mobile voice messages captured successfully
- [ ] Deduplication working across API and DOM sources
- [ ] Storage eviction triggers at 80% capacity
- [ ] Storage reduces to ~70% after eviction
- [ ] At least 100 messages retained after eviction
- [ ] DOM observer restarts after simulated failure
- [ ] Debug mode toggle works in popup
- [ ] Queue manager fallback works when SW unavailable
- [ ] Statistics accurately reflect message counts by source
- [ ] No console errors during normal operation
- [ ] Extension icon shows correct status (green when active)

---

## Troubleshooting Common Issues

### Issue: DOM observer not starting

**Symptoms**: No `[KYT DOM]` logs, observer health shows `running: false`

**Diagnosis**:
```javascript
// Check if dom-observer.js loaded
console.log('DOM observer loaded:', typeof window !== 'undefined');

// Check for conversation container
const container = document.querySelector('[data-testid="conversation"]');
console.log('Conversation container exists:', !!container);

// Check observer instance
window.dispatchEvent(new CustomEvent('KYT_DOM_COMMAND', {
  detail: { command: 'getHealth' }
}));
```

**Solutions**:
1. Reload extension: `chrome://extensions/` → reload button
2. Refresh ChatGPT page: `Ctrl+R`
3. Check manifest.json: verify dom-observer.js in content_scripts
4. Manual restart: `window.dispatchEvent(new CustomEvent('KYT_DOM_COMMAND', {detail: {command: 'restart'}}))`

---

### Issue: Messages duplicating despite deduplication

**Symptoms**: Same message saved twice with different sources

**Diagnosis**:
```javascript
// Check deduplicator availability
console.log('Deduplicator exists:', typeof window.KYT_Deduplicator !== 'undefined');

// Check recent messages
chrome.storage.local.get(['captured_messages'], (result) => {
  const messages = result.captured_messages || [];
  const recent = messages.slice(-20);
  
  // Group by content hash
  const grouped = recent.reduce((acc, msg) => {
    const hash = msg.contentHash || 'no-hash';
    acc[hash] = (acc[hash] || 0) + 1;
    return acc;
  }, {});
  
  console.log('Duplicate hashes:', Object.entries(grouped).filter(([h, c]) => c > 1));
});
```

**Solutions**:
1. Verify deduplication.js loads before content.js in manifest.json
2. Check if contentHash is being generated: messages should have `contentHash` field
3. Clear storage and test with fresh messages
4. Check Service Worker console for "Duplicate blocked" logs

---

### Issue: Storage eviction not triggering

**Symptoms**: Storage exceeds 80% but no eviction occurs

**Diagnosis**:
```javascript
// In Service Worker console
const status = await checkStorageQuota();
console.log('Quota status:', status);

// Check if eviction function exists
console.log('Eviction function exists:', typeof evictOldMessages === 'function');

// Check configuration
console.log('Storage config:', STORAGE_CONFIG);
```

**Solutions**:
1. Verify STORAGE_CONFIG in background.js (MAX_USAGE_PERCENT: 80)
2. Check saveMessage() calls checkStorageQuota()
3. Manually trigger eviction: `evictOldMessages()`
4. Check health_check alarm is running: `chrome.alarms.getAll(console.log)`

---

### Issue: Queue not syncing after Service Worker restart

**Symptoms**: Messages stuck in local queue, never reach chrome.storage

**Diagnosis**:
```javascript
// Check local queue
chrome.storage.local.get(['kyt_local_queue'], (result) => {
  console.log('Queue size:', result.kyt_local_queue?.length || 0);
  console.log('Oldest message:', result.kyt_local_queue?.[0]);
});

// Check if processor is running
// In Service Worker console
console.log('Processor alarm exists:', await chrome.alarms.get('kyt_queue_processor'));
```

**Solutions**:
1. Verify queue processor alarm created on startup
2. Check for errors in Service Worker console
3. Manually trigger processing: Send message to background with type 'PROCESS_QUEUE'
4. Clear stuck queue if corrupt: `chrome.storage.local.remove(['kyt_local_queue'])`

---

## Test Data Cleanup

After testing, clean up test data:

```javascript
// In Service Worker console

// Option 1: Remove only test messages
const result = await chrome.storage.local.get(['captured_messages']);
const messages = result.captured_messages || [];
const cleaned = messages.filter(m => 
  !m.messageId?.includes('test') &&
  !m.messageId?.includes('filler') &&
  !m.content?.includes('Dedup test')
);

await chrome.storage.local.set({ captured_messages: cleaned });
console.log(`Cleaned: ${messages.length - cleaned.length} test messages removed`);

// Option 2: Full reset (use with caution!)
await chrome.storage.local.clear();
console.log('✅ All storage cleared');
```

---

## Performance Metrics

Track these metrics during testing:

| Metric | Target | Measurement |
|--------|--------|-------------|
| DOM observer CPU usage | < 5% | Chrome Task Manager |
| Memory overhead | < 50MB | Chrome Task Manager → Extension |
| Message capture latency | < 100ms | Console timestamps |
| Dedup check time | < 10ms | Performance.now() |
| Storage quota check | < 50ms | Performance.now() |
| Eviction duration | < 2s | Console logs |
| Queue sync latency | < 1s | Message timestamp delta |

**To measure capture latency**:
```javascript
// In browser console
window.addEventListener('KYT_MESSAGE_CAPTURED', () => {
  console.log('API capture timestamp:', performance.now());
});

window.addEventListener('KYT_DOM_MESSAGE_CAPTURED', () => {
  console.log('DOM capture timestamp:', performance.now());
});

// Trigger a test message and note the delta
```

---

## Continuous Monitoring

For ongoing validation, monitor these indicators:

**Daily**:
- [ ] Extension icon shows green status
- [ ] No errors in Service Worker console
- [ ] Storage usage < 80%
- [ ] DOM observer running (health check)

**Weekly**:
- [ ] Run automated test suite
- [ ] Review capture statistics for anomalies
- [ ] Check duplicate blocking rate (should be > 0)
- [ ] Verify mobile messages being captured

**Monthly**:
- [ ] Full regression test suite
- [ ] Performance benchmarks
- [ ] Storage eviction stress test
- [ ] Queue fallback test

---

## Reporting Issues

When reporting test failures, include:

1. **Test name** and expected vs actual behavior
2. **Console logs** (both browser and Service Worker)
3. **Extension version** from manifest.json
4. **Chrome version**: `chrome://version/`
5. **Storage state**: Output of `chrome.storage.local.get(console.log)`
6. **Steps to reproduce**
7. **Screenshots** if visual issue

Submit issues to: https://github.com/your-repo/kyt-memory/issues
