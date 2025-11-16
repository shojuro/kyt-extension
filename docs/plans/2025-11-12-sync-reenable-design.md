# Sync Re-enablement Design

**Date**: 2025-11-12
**Status**: Approved Design
**Context**: Day 2 sync functionality disabled due to ES module loading issue
**Goal**: Re-enable automatic sync from Chrome storage to Supabase with embeddings

---

## Problem Statement

### Current State
- ✅ **Message capture**: Working (21 messages in Chrome storage)
- ❌ **Sync to Supabase**: DISABLED (lines 319-347 in background.js)
- ✅ **Context injection**: Working (searches Supabase only)

### Impact
- 21 messages captured but not synced to Supabase automatically
- Context injection can't find recent messages (only 3-4 manually synced messages in database)
- Workaround: Manual sync using node scripts

### Root Cause
Chrome service worker ES module loading issue. Lines 18-19 in background.js:
```javascript
// TEMPORARY: Commented out due to Chrome service worker module loading issue
// import { syncToSupabase, setApiConfig } from './src/browser-sync.js';
// import { searchMessages, findSimilarMessages } from './src/browser-search.js';
```

---

## Design Decisions

### 1. Module System: ES Modules
**Chosen approach**: Convert to ES modules (manifest.json `type: "module"`)

**Alternatives considered**:
- Dynamic import() with classic scripts (more complex, all async)
- Inline sync code in background.js (maintainability issues)

**Why ES modules?**
- Clean, modern approach
- Static imports (easier to reason about)
- Low complexity
- Minimal refactoring needed

### 2. Sync Trigger: Hybrid Strategy
**Chosen approach**: Immediate for first message, periodic for batches

**Behavior**:
- **On extension load**: Sync all unsynced messages (handles 21 existing messages)
- **First message in window**: Immediate sync (>4 minutes since last sync)
- **Subsequent messages**: Batched in 5-minute periodic sync

**Why hybrid?**
- Balances freshness (important for context injection) with API efficiency
- Conversations are batched, single messages get immediate context
- Reduces API calls vs pure immediate sync

### 3. Existing Messages: Sync on Load
**Chosen approach**: Sync all 21 messages when extension loads

**Why?**
- Ensures full history available immediately
- One-time bulk operation (30-60 seconds)
- User gets complete context injection from day one

---

## Architecture

### Module Conversion

**manifest.json** (line 17-19):
```json
"background": {
  "service_worker": "background.js",
  "type": "module"
}
```

**background.js** (uncomment lines 18-19):
```javascript
import { syncToSupabase, setApiConfig } from './src/browser-sync.js';
import { searchMessages, findSimilarMessages } from './src/browser-search.js';
```

### Sync Implementation

**1. Extension Install/Update Handler**

```javascript
chrome.runtime.onInstalled.addListener(() => {
  console.log('🔄 Extension installed/updated - syncing existing messages');
  syncToSupabase(); // Sync all unsynced messages (21 existing + future)

  // Set up periodic sync alarm
  chrome.alarms.create('periodicSync', { periodInMinutes: 5 });
});
```

**2. Periodic Sync Handler**

```javascript
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'periodicSync') {
    console.log('⏰ Periodic sync triggered');
    syncToSupabase();
  }
});
```

**3. Hybrid Immediate Sync (in SAVE_MESSAGE handler)**

```javascript
case 'SAVE_MESSAGE':
  saveMessage(message.data)
    .then(async (success) => {
      if (success) {
        // Check if this is the first message in batch window
        const result = await chrome.storage.local.get(['last_sync_status']);
        const lastSync = result.last_sync_status?.lastSyncTime || 0;
        const timeSinceSync = Date.now() - lastSync;

        // If more than 4 minutes since last sync, trigger immediate sync
        if (timeSinceSync > 4 * 60 * 1000) {
          console.log('🚀 First message in window - immediate sync');
          syncToSupabase();
        }

        sendResponse({ success: true });
      }
    });
  return true;
```

**Why 4 minutes threshold?**
- Periodic sync is every 5 minutes
- If >4 minutes elapsed, this is likely a new conversation
- Immediate sync ensures context available for next user query
- Messages <4 minutes apart are batched (same conversation)

**4. Re-enable Sync Handlers**

Uncomment and restore lines 319-347:

```javascript
case 'SYNC_TO_SUPABASE':
  syncToSupabase()
    .then(result => {
      console.log('✅ Sync result:', result);
      sendResponse(result);
    })
    .catch(error => {
      console.error('❌ Sync failed:', error);
      sendResponse({ success: false, error: error.message });
    });
  return true;

case 'SEARCH_MESSAGES':
  searchMessages(message.query, message.limit)
    .then(results => sendResponse({ success: true, results }))
    .catch(error => sendResponse({ success: false, error: error.message }));
  return true;

case 'FIND_SIMILAR':
  findSimilarMessages(message.messageId, message.threshold)
    .then(results => sendResponse({ success: true, results }))
    .catch(error => sendResponse({ success: false, error: error.message }));
  return true;
```

---

## Error Handling & Graceful Degradation

### API Configuration Check

```javascript
chrome.runtime.onStartup.addListener(async () => {
  const result = await chrome.storage.local.get(['api_config']);
  if (!result.api_config) {
    console.warn('⚠️ API config not found - sync will fail until configured');
    // Extension still works for message capture
  }
});
```

### Sync Failure Behavior

When sync fails:
1. ✅ **Message capture continues** - Messages saved to Chrome storage
2. ✅ **Context injection continues** - Uses stale Supabase data
3. ✅ **User informed** - Console logs show errors
4. ✅ **Auto-retry** - Next periodic sync (5 min) retries failed messages
5. ✅ **No data loss** - Unsynced messages stay in Chrome storage

### Rate Limiting Protection

Already implemented in `src/browser-sync.js`:
- Batch size: 100 messages per OpenAI API call
- Delay: 100ms between batches
- Supabase: `Prefer: resolution=ignore-duplicates` prevents duplicate inserts

---

## Testing Strategy

### Three-Layer Testing Pyramid

```
       E2E Tests (5 new)
      Real Chrome Browser
     Proves actual behavior
          ▲
         / \
        /   \
   Integration (4 new)
  Chrome API Mocks + Flow
 Tests component interaction
        ▲
       / \
      /   \
   Unit (8 new)
  Pure Logic Tests
 Fast feedback loop
```

**Total: 17 new tests** (adds to existing 33 tests = **50 total tests**)

### Layer 1: Unit Tests (tests/sync-reenable.test.js - NEW)

**8 new unit tests:**

1. **Hybrid sync logic - immediate case**
   ```javascript
   it('should trigger immediate sync when >4 minutes since last sync', () => {
     const lastSyncTime = Date.now() - (5 * 60 * 1000); // 5 minutes ago
     const timeSinceSync = Date.now() - lastSyncTime;
     expect(timeSinceSync > 4 * 60 * 1000).toBe(true); // Should sync immediately
   });
   ```

2. **Hybrid sync logic - batched case**
   ```javascript
   it('should NOT trigger immediate sync when <4 minutes since last sync', () => {
     const lastSyncTime = Date.now() - (2 * 60 * 1000); // 2 minutes ago
     const timeSinceSync = Date.now() - lastSyncTime;
     expect(timeSinceSync > 4 * 60 * 1000).toBe(false); // Should batch
   });
   ```

3. **Alarm creation on install**
4. **Alarm handler triggers syncToSupabase()**
5. **Last sync time tracking in chrome.storage.local**
6. **Synced message IDs array management**
7. **Module import validation** (mock imports, verify functions exist)
8. **Error handling when API config missing**

### Layer 2: Integration Tests (extend tests/integration.test.js)

**4 new integration tests:**

1. **Full message capture + sync flow**
   - Mock: content script → background → saveMessage
   - Check: sync window logic
   - Trigger: immediate or batched sync
   - Verify: syncToSupabase called appropriately

2. **Periodic alarm triggers sync**
   - Mock: chrome.alarms fires
   - Trigger: alarm handler
   - Verify: syncToSupabase called with correct timing

3. **Extension install flow**
   - Mock: chrome.runtime.onInstalled fires
   - Verify: syncToSupabase called once
   - Verify: alarm created with 5-minute period

4. **Graceful degradation - no API config**
   - Mock: chrome.storage.local with no api_config
   - Trigger: sync attempt
   - Verify: Error logged, extension continues working

### Layer 3: E2E Tests (extend tests/e2e/extension.e2e.test.js)

**5 new E2E tests:**

1. **Extension loads with ES modules**
   ```javascript
   it('should load background.js as ES module', async () => {
     const worker = await browser.serviceWorkers()[0];
     const moduleType = await worker.evaluate(() => {
       return typeof syncToSupabase === 'function';
     });
     expect(moduleType).toBe(true);
   });
   ```

2. **Sync alarm registers on install**
   - Load extension in real Chrome
   - Check chrome.alarms.getAll()
   - Verify 'periodicSync' alarm exists with 5-minute period

3. **First message triggers immediate sync**
   - Set lastSyncTime to 6 minutes ago in storage
   - Capture a message
   - Verify syncToSupabase called immediately

4. **Subsequent messages batch correctly**
   - Set lastSyncTime to 2 minutes ago
   - Capture a message
   - Verify syncToSupabase NOT called
   - Wait for periodic alarm
   - Verify sync triggered by alarm

5. **21 existing messages sync on load**
   - Prepopulate chrome.storage with 21 messages
   - Load extension
   - Monitor console for sync logs
   - Verify all 21 messages marked as synced in storage

### Manual E2E Verification

**After automated tests pass:**

1. **Fresh install test**
   - Load extension in chrome://extensions
   - Check console: "syncing existing messages"
   - Query Supabase: verify 21 messages appear within 60 seconds

2. **Hybrid sync test**
   - Send ChatGPT message (wait for immediate sync log)
   - Send another message 1 minute later (should NOT sync yet)
   - Wait 5 minutes total
   - Check console: periodic sync log
   - Query Supabase: both messages present

3. **Context injection verification**
   - Send query similar to synced content
   - Check: window.KYT_LAST_CONTEXT shows results (not null)
   - Confirm: context injection working with newly synced messages

---

## Success Criteria

### Automated Tests
- ✅ 8/8 new unit tests passing
- ✅ 4/4 new integration tests passing
- ✅ 5/5 new E2E tests passing
- ✅ All existing 33 tests still passing
- ✅ Total: 50/50 tests passing

### Functional Requirements
- ✅ Extension loads with ES modules (no console errors)
- ✅ 21 existing messages sync on extension install
- ✅ First message triggers immediate sync (>4 min window)
- ✅ Subsequent messages batch (5-minute periodic sync)
- ✅ Context injection finds newly synced messages
- ✅ Sync failures don't break message capture
- ✅ Console logs show sync status clearly

### VTEST Verification
Following CLAUDE.md anti-theater rules, prove tests can fail:

```bash
# Break a test intentionally
# Edit tests/sync-reenable.test.js
# Change: expect(timeSinceSync > 4 * 60 * 1000).toBe(true);
# To:     expect(timeSinceSync > 4 * 60 * 1000).toBe(false);

npm test
# Should FAIL: ❌ "expected true to be false"

# Fix and re-run
# Change back to correct expectation
npm test
# Should PASS: ✅ All tests passing
```

---

## Migration Plan

### Phase 1: Enable ES Modules (No Behavior Change)
1. Add `"type": "module"` to manifest.json
2. Uncomment import statements in background.js
3. Run existing tests (should still pass - no logic changed)
4. Load extension in Chrome, verify no console errors

### Phase 2: Add Sync Logic
1. Add chrome.runtime.onInstalled listener
2. Add chrome.alarms.onAlarm listener
3. Add hybrid sync logic to SAVE_MESSAGE handler
4. Add API config check on startup

### Phase 3: Re-enable Handlers
1. Uncomment SYNC_TO_SUPABASE handler
2. Uncomment SEARCH_MESSAGES handler
3. Uncomment FIND_SIMILAR handler
4. Update handler implementations (remove "disabled" messages)

### Phase 4: Add Tests
1. Create tests/sync-reenable.test.js (8 unit tests)
2. Extend tests/integration.test.js (4 integration tests)
3. Extend tests/e2e/extension.e2e.test.js (5 E2E tests)
4. Run all 50 tests, ensure passing

### Phase 5: Manual Verification
1. Fresh extension install
2. Verify 21 messages sync
3. Test hybrid sync behavior
4. Verify context injection works with synced messages

---

## Risks & Mitigations

### Risk 1: ES Module Compatibility
**Risk**: Existing code might have patterns incompatible with ES modules
**Likelihood**: Low (code review shows no obvious issues)
**Mitigation**: Phase 1 tests ES module conversion in isolation
**Rollback**: Revert manifest.json change, re-comment imports

### Risk 2: Rate Limiting
**Risk**: Syncing 21 messages on install might hit OpenAI rate limits
**Likelihood**: Low (browser-sync.js has 100ms delays built in)
**Mitigation**: Batch processing already implemented
**Monitoring**: Console logs show batch progress

### Risk 3: API Config Missing
**Risk**: Users install extension without configuring API keys
**Likelihood**: High (first-time install scenario)
**Mitigation**: Graceful degradation - capture works, sync fails silently
**User Experience**: Console warning explains issue

### Risk 4: Chrome Storage Quota
**Risk**: 21 messages * embedding (1536 floats) = significant storage
**Likelihood**: Low (embeddings stored in Supabase, not Chrome storage)
**Mitigation**: Chrome storage only holds message metadata
**Monitoring**: getStorageStats() tracks quota usage

---

## Rollback Plan

If sync re-enablement causes issues:

### Quick Rollback (< 5 minutes)
1. Re-comment import statements (lines 18-19)
2. Re-disable handlers (lines 319-347)
3. Remove `"type": "module"` from manifest.json
4. Reload extension

**Effect**: Returns to Day 3 state (capture + context injection work, sync disabled)

### Selective Rollback
- **Module issues only**: Revert manifest.json, keep handler logic
- **Sync logic issues only**: Revert handlers, keep ES modules
- **Alarm issues only**: Remove alarm listeners, keep manual sync

---

## Future Enhancements

### After Initial Re-enablement

1. **User-configurable sync frequency**
   - Allow users to set periodic sync interval (1-60 minutes)
   - Default: 5 minutes

2. **Sync status UI**
   - Badge icon showing sync status (✅ synced, ⏳ syncing, ❌ failed)
   - Popup showing last sync time and message counts

3. **Smart batching**
   - Detect conversation boundaries (large time gaps)
   - Sync conversation as unit (all messages together)

4. **Incremental sync on startup**
   - If >20 unsynced messages, sync in batches of 5
   - Prevents long blocking operation on extension startup

5. **Retry with exponential backoff**
   - On sync failure, retry after 1 min, 2 min, 4 min, 8 min
   - Prevents hammering API during outages

---

## Documentation Updates

### Files to Update
1. **DAY3_COMPLETE.md** - Update "Known Limitations" section (sync re-enabled)
2. **README.md** - Add sync behavior explanation
3. **HOW_TO_TEST_CORRECTLY.md** - Add sync testing examples
4. **tests/README.md** - Document new sync tests

### New Files to Create
1. **SYNC_BEHAVIOR.md** - User-facing guide explaining hybrid sync
2. **API_CONFIG_SETUP.md** - Guide for setting up API keys

---

## Summary

**Problem**: Day 2 sync disabled due to ES module loading issue
**Solution**: Convert to ES modules + add hybrid sync strategy
**Testing**: 17 new tests across 3 layers (unit → integration → E2E)
**Impact**: 21 existing messages synced, future messages auto-sync, context injection fully functional
**Risk**: Low (phased migration, graceful degradation, quick rollback)

**Next Step**: Create implementation plan with bite-sized tasks
