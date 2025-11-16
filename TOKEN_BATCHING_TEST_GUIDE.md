# Token Batching Test Guide

**Date**: 2025-11-15
**Goal**: Verify token-aware batching fixes 26,916 token sync error
**Expected Time**: 5 minutes

---

## 🎯 What We Fixed

**Problem**: `OpenAI API error: This model's maximum context length is 8192 tokens, however you requested 26916 tokens`

**Solution**: Batch messages by tokens (max 8,000 per batch), not count (100 messages)

---

## ✅ Test Steps

### 1. Reload Extension
1. Open `chrome://extensions`
2. Find "KYT Memory Extension"
3. Click reload button (circular arrow icon)
4. Verify no errors in extension card

### 2. Open Service Worker Console
1. Click "service worker" link (under extension details)
2. This opens DevTools for background.js
3. Keep this console open during testing

### 3. Trigger Sync
**Option A: Manual Sync** (if sync button exists)
- Click sync button in extension popup

**Option B: Reload Trigger**
- Close and reopen the service worker DevTools
- Extension should auto-sync on startup

**Option C: Console Command**
```javascript
// In service worker console:
chrome.runtime.sendMessage({ type: 'SYNC_NOW' });
```

### 4. Check Console Logs

**Expected Output** (with new batching):
```
🔄 Starting sync to Supabase...
📦 Found X new messages to sync (Y total)
📊 Generating embeddings: 4 batches for 100 messages
📊 Batch 1/4: 30 messages (~8000 tokens)
📊 Batch 2/4: 30 messages (~8000 tokens)
📊 Batch 3/4: 30 messages (~8000 tokens)
📊 Batch 4/4: 10 messages (~3000 tokens)
✅ Sync complete: 100 messages synced
```

**Key Changes to Look For**:
- ✅ "X batches for Y messages" (NEW)
- ✅ "~8000 tokens" per batch (NEW)
- ✅ Multiple batches if >30 messages
- ✅ NO "26916 tokens" error

**Old Output** (before fix):
```
📊 Generating embeddings: batch 1 (100 messages)  // No token count
❌ Sync failed: Error: OpenAI API error: ... 26916 tokens
```

### 5. Verify Success

**Success Indicators**:
- ✅ Console shows: `✅ Sync complete: X messages synced`
- ✅ NO error messages
- ✅ Batch logs show token counts
- ✅ All batches <8,000 tokens

**If Sync Fails**:
- Check error message
- Look for "OpenAI API error"
- Check if token count still exceeds 8,192

---

## 🔍 Advanced Testing (Optional)

### Check Storage Stats
```javascript
// In service worker console:
chrome.storage.local.get(['captured_messages'], (result) => {
  const messages = result.captured_messages || [];
  const totalChars = messages.reduce((sum, m) => sum + (m.content?.length || 0), 0);
  const estimatedTokens = Math.ceil(totalChars / 4);

  console.log({
    messageCount: messages.length,
    totalCharacters: totalChars,
    estimatedTotalTokens: estimatedTokens,
    expectedBatches: Math.ceil(estimatedTokens / 8000)
  });
});
```

**Example Output**:
```javascript
{
  messageCount: 100,
  totalCharacters: 108000,
  estimatedTotalTokens: 27000,
  expectedBatches: 4  // 27000 / 8000 = 3.4 → 4 batches
}
```

### Verify Batch Calculation
```javascript
// Test batching function directly:
function estimateTokens(text) {
  return Math.ceil((text?.length || 0) / 4);
}

// Example: 100 messages × 1080 chars each
const mockMessages = Array(100).fill({ content: 'x'.repeat(1080) });
const texts = mockMessages.map(m => m.content);
const totalTokens = texts.reduce((sum, text) => sum + estimateTokens(text), 0);

console.log(`Total tokens: ${totalTokens}`);
console.log(`Expected batches: ${Math.ceil(totalTokens / 8000)}`);
```

---

## ✅ Success Criteria

**Minimum Success**:
- [ ] Extension reloads without errors
- [ ] Sync completes (no "26916 tokens" error)
- [ ] Console shows batch logs with token counts

**Full Success**:
- [ ] All batches show <8,000 tokens
- [ ] Multiple batches created for large message sets
- [ ] Logs show: "Batch X/Y: Z messages (~N tokens)"
- [ ] Supabase receives all messages

---

## 🐛 Troubleshooting

### Error: "26916 tokens" still appears
**Possible Causes**:
- Extension not reloaded after code changes
- Old code cached in service worker
- Different sync mechanism being used

**Fix**:
1. Hard reload: Remove extension, re-add from directory
2. Clear service worker cache: `chrome://serviceworker-internals`
3. Verify code changes: `cat src/browser-sync.js | grep "batchByTokens"`

### No sync triggered
**Possible Causes**:
- No new messages to sync
- Sync already completed for existing messages

**Fix**:
```javascript
// Reset sync status to force re-sync:
chrome.storage.local.set({ last_sync_status: { syncedMessageIds: [] } });
// Then trigger sync again
```

### Batches still too large
**Possible Causes**:
- Token estimation incorrect (1 token ≈ 4 chars is rough)
- Special characters inflate token count

**Fix**:
- Lower batch limit from 8000 to 7500
- Change: `batchByTokens(texts, 7500)`

---

## 📊 Expected Results Summary

| Scenario | Messages | Avg Tokens/Msg | Total Tokens | Expected Batches |
|----------|----------|----------------|--------------|------------------|
| Small    | 10       | 100            | 1,000        | 1                |
| Medium   | 50       | 150            | 7,500        | 1                |
| Large    | 100      | 270            | 27,000       | 4                |
| Very Long| 100      | 500            | 50,000       | 7                |

---

## ⏭️ After Testing

**If Tests Pass**:
✅ Token batching fix verified
→ Ready for Phase 2: Create `chat_turns` schema

**If Tests Fail**:
❌ Debug issue
→ Report error message
→ Adjust implementation

---

**Ready to test? Reload the extension and follow the steps above!**
