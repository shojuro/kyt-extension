# KYT Memory Extension - Sync Behavior

**Date**: 2025-11-12
**Status**: ✅ ACTIVE (Day 4)

---

## Overview

Messages captured from ChatGPT are automatically synced to Supabase with OpenAI embeddings for semantic search and context injection.

## Sync Strategy: Hybrid

### Three Sync Triggers

1. **Initial Sync** (on extension install/update)
   - Syncs ALL unsynced messages in Chrome storage
   - Runs automatically when extension loads
   - Typical time: 30-60 seconds for 20+ messages

2. **Immediate Sync** (first message in conversation)
   - **When**: >4 minutes since last sync
   - **Why**: Ensures context available for follow-up queries
   - **Latency**: ~5-10 seconds

3. **Batched Sync** (subsequent messages)
   - **When**: <4 minutes since last sync
   - **Frequency**: Every 5 minutes via periodic alarm
   - **Why**: Reduces API calls, improves efficiency

### Why 4-Minute Threshold?

- Periodic alarm fires every 5 minutes
- If >4 minutes elapsed, this is likely a new conversation
- Messages <4 minutes apart are batched (same conversation)

---

## How It Works

```
1. Message Capture (instant)
   ↓
2. Sync Decision
   Time since last sync > 4 min? → Immediate sync
   Time since last sync < 4 min? → Batch for periodic sync
   ↓
3. Sync Process (~5-10 seconds)
   - Generate OpenAI embedding (1536 dimensions)
   - Insert to Supabase with metadata
   - Update sync status in Chrome storage
   ↓
4. Context Injection (~1-2 seconds)
   - Search Supabase for similar messages
   - Prepend context to ChatGPT prompt
```

---

## Monitoring

### Service Worker Console

Open `chrome://extensions` → Click "service worker" link

**Successful sync logs:**
```
🔄 Extension installed/updated - syncing existing messages
✅ Initial sync completed: 21 messages synced
⏰ Periodic sync alarm created (5 minute interval)
🚀 First message in window - immediate sync
✅ Immediate sync: 1 messages synced
📦 Message batched for next periodic sync
⏰ Periodic sync triggered
✅ Periodic sync: 3 messages synced
```

**Sync failure logs:**
```
⚠️ API config not found - sync will fail until configured
⚠️ Initial sync failed: [error message]
❌ Immediate sync failed: [error message]
```

### Check Sync Status

In service worker console:
```javascript
chrome.storage.local.get(['last_sync_status'], (result) => {
  console.log(result.last_sync_status);
});
```

Expected output:
```javascript
{
  lastSyncTime: 1699876543210,  // Unix timestamp
  syncedCount: 24,               // Messages synced in last operation
  syncedMessageIds: [            // IDs of all synced messages
    'msg_1699876543210_abc123',
    ...
  ]
}
```

---

## API Configuration

### Required Keys

Sync requires three API keys:
- `SUPABASE_URL` - Your Supabase project URL
- `SUPABASE_ANON_KEY` - Supabase anon key
- `OPENAI_API_KEY` - OpenAI API key

### Setting Up (Option 1: Chrome Storage)

In service worker console:
```javascript
await chrome.storage.local.set({
  api_config: {
    supabaseUrl: 'https://your-project.supabase.co',
    supabaseKey: 'your-anon-key',
    openaiKey: 'sk-your-openai-key'
  }
});
```

### Setting Up (Option 2: Message Handler)

```javascript
chrome.runtime.sendMessage({
  type: 'SET_API_CONFIG',
  config: {
    supabaseUrl: 'https://your-project.supabase.co',
    supabaseKey: 'your-anon-key',
    openaiKey: 'sk-your-openai-key'
  }
});
```

---

## Troubleshooting

### Sync Not Working

**Check 1: API Config**
```javascript
chrome.storage.local.get(['api_config'], (r) => console.log(r));
```
If undefined → Set up API keys (see above)

**Check 2: Manual Sync Test**
```javascript
chrome.runtime.sendMessage({ type: 'SYNC_TO_SUPABASE' }, (response) => {
  console.log(response);
});
```

**Check 3: Console Errors**
Open service worker console, look for red error messages

### Messages Not in Supabase

**Verify sync status:**
```javascript
chrome.storage.local.get(['last_sync_status'], (r) => {
  console.log('Last sync:', new Date(r.last_sync_status?.lastSyncTime));
  console.log('Synced count:', r.last_sync_status?.syncedCount);
});
```

**Check Supabase directly (from terminal):**
```bash
node -e "
import('@supabase/supabase-js').then(sb => {
  const supabase = sb.createClient('URL', 'KEY');
  return supabase.from('messages').select('*', { count: 'exact' });
}).then(({ count }) => console.log('Total:', count));
"
```

### Context Injection Returns Null

**Cause**: Messages synced but semantic similarity below threshold (0.5)

**Solution**: Try more similar queries or lower threshold in DEFAULT_CONFIG

---

## Performance

### Typical Latencies
- Message capture: <10ms (instant)
- Sync decision: <10ms (instant)
- Embedding generation: 500-1000ms
- Supabase insert: 100-200ms
- **Total sync time**: ~1-2 seconds
- Context retrieval: ~1-2 seconds

### API Usage
- OpenAI: 1 embedding call per message (~$0.00001 per message)
- Supabase: 1 insert per message (usually free tier)

### Storage
- Chrome storage: ~1-2KB per message metadata
- Supabase: ~2KB per message + 6KB per embedding

---

## Advanced

### Manually Trigger Sync

```javascript
chrome.runtime.sendMessage({ type: 'SYNC_TO_SUPABASE' }, (response) => {
  if (response.success) {
    console.log(`Synced ${response.synced} messages`);
  } else {
    console.error('Sync failed:', response.error);
  }
});
```

### View Unsynced Messages

```javascript
chrome.storage.local.get(['captured_messages', 'last_sync_status'], (result) => {
  const allMessages = result.captured_messages || [];
  const syncedIds = new Set(result.last_sync_status?.syncedMessageIds || []);
  const unsynced = allMessages.filter(m => !syncedIds.has(m.messageId));
  console.log(`Unsynced: ${unsynced.length} messages`);
  console.table(unsynced);
});
```

### Force Re-sync All Messages

```javascript
// Clear sync status
await chrome.storage.local.set({
  last_sync_status: { syncedMessageIds: [] }
});

// Trigger sync
chrome.runtime.sendMessage({ type: 'SYNC_TO_SUPABASE' });
```

---

## See Also

- [Design Document](./docs/plans/2025-11-12-sync-reenable-design.md)
- [Implementation Plan](./docs/plans/2025-11-12-sync-reenable-implementation.md)
- [DAY3_COMPLETE.md](./DAY3_COMPLETE.md) - Full feature documentation
