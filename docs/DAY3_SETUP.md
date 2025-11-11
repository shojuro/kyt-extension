# Day 3 Setup Guide: Extension Sync & Context Injection

## Prerequisites

Before starting Day 3, ensure you have:
- ✅ Day 2 complete (7/9 validation tests passing)
- ✅ Supabase project with messages table and match_messages() function
- ✅ OpenAI API key
- ✅ Supabase URL and anon key

---

## Phase 1: Extension Setup & Sync Testing

### Step 1: Load Extension in Chrome

1. Open Chrome browser
2. Navigate to: `chrome://extensions`
3. Enable "Developer mode" (toggle in top right)
4. Click "Load unpacked"
5. Select directory: `/home/penguinzyue/kyt-validation-sprint`
6. Verify extension appears with "K" icon and status "Enabled"

**Expected Console Output** (in Chrome DevTools):
```
🚀 KYT Background: Service worker starting...
✅ KYT Background: Service worker ready
```

---

### Step 2: Configure API Keys

Open ChatGPT (https://chat.openai.com or https://chatgpt.com) and open DevTools (F12).

**Paste this script into the Console:**

```javascript
// KYT Day 3: API Configuration Setup
// This stores your API keys in chrome.storage.local (not in code!)

const config = {
  supabaseUrl: 'YOUR_SUPABASE_URL',        // e.g., https://abc123.supabase.co
  supabaseKey: 'YOUR_SUPABASE_ANON_KEY',   // Your Supabase anon/public key
  openaiKey: 'YOUR_OPENAI_API_KEY'         // Starts with sk-...
};

// Validate config
if (config.supabaseUrl === 'YOUR_SUPABASE_URL' ||
    config.supabaseKey === 'YOUR_SUPABASE_ANON_KEY' ||
    config.openaiKey === 'YOUR_OPENAI_API_KEY') {
  console.error('❌ ERROR: Please replace placeholder values with your actual API keys!');
} else {
  // Save to chrome.storage
  chrome.runtime.sendMessage({
    type: 'SET_API_CONFIG',
    config: config
  }, (response) => {
    if (response.success) {
      console.log('✅ API configuration saved successfully!');
      console.log('   Supabase URL:', config.supabaseUrl);
      console.log('   OpenAI key:', config.openaiKey.substring(0, 10) + '...');
      console.log('\n📝 Next: Have 5+ ChatGPT conversations to test sync');
    } else {
      console.error('❌ Failed to save config:', response.error);
    }
  });
}
```

**Replace the placeholder values:**
- `YOUR_SUPABASE_URL`: From Supabase project settings → API → Project URL
- `YOUR_SUPABASE_ANON_KEY`: From Supabase project settings → API → anon/public key
- `YOUR_OPENAI_API_KEY`: From OpenAI dashboard → API keys

---

### Step 3: Test Message Capture

Have **5+ conversations** with ChatGPT on different topics:

1. "What is the capital of France?"
2. "Explain quantum computing in simple terms"
3. "I'm building a RAG system with semantic search and pgvector"
4. "What are the benefits of using TypeScript?"
5. "Tell me about the history of the internet"

**Watch DevTools Console for:**
```
🎯 KYT INJECTED: Intercepted ChatGPT API call!
✅ KYT INJECTED: Message extracted: What is the capital...
📨 KYT Content Script: Received message from page context
✅ KYT Content Script: Message forwarded to background for storage
✅ KYT Background: Message saved (total: 5)
```

**Verify Capture:**
```javascript
chrome.storage.local.get(['captured_messages'], (result) => {
  const messages = result.captured_messages || [];
  console.log('📦 Captured messages:', messages.length);
  console.table(messages.slice(0, 5).map(m => ({
    messageId: m.messageId,
    content: m.content.substring(0, 50) + '...',
    role: m.role,
    timestamp: new Date(m.timestamp).toLocaleString()
  })));
});
```

**Expected:** 5+ messages captured

---

### Step 4: Sync to Supabase

Now sync captured messages to Supabase with embeddings:

```javascript
chrome.runtime.sendMessage({type: 'SYNC_TO_SUPABASE'}, (response) => {
  console.log('📊 Sync Result:', response);
  if (response.success) {
    console.log(`✅ SUCCESS: Synced ${response.synced} messages to Supabase`);
    console.log('   Messages now have embeddings and are searchable');
  } else {
    console.error('❌ SYNC FAILED:', response.error);
  }
});
```

**Expected Output:**
```
📊 Sync Result: {success: true, synced: 5, message: "Successfully synced 5 messages"}
✅ SUCCESS: Synced 5 messages to Supabase
   Messages now have embeddings and are searchable
```

**If sync fails:**
- Check API keys are correct
- Verify Supabase URL/key
- Check OpenAI API key is valid (not expired)
- Check console for detailed error messages

---

### Step 5: Verify in Supabase

Go to Supabase dashboard → SQL Editor:

```sql
-- Check total messages
SELECT COUNT(*) as total_messages FROM messages;

-- Check ChatGPT messages (should be 5+)
SELECT COUNT(*) as chatgpt_messages FROM messages WHERE source = 'chatgpt';

-- View recent synced messages
SELECT
  message_id,
  content,
  role,
  source,
  synced_from_extension,
  pg_column_size(embedding) as embedding_bytes
FROM messages
WHERE source = 'chatgpt'
ORDER BY synced_from_extension DESC
LIMIT 5;
```

**Expected:**
- `total_messages`: >= 8 (3 CLI from Day 2 + 5 ChatGPT)
- `chatgpt_messages`: >= 5
- All messages have `embedding_bytes` = 6152 (1536 floats × 4 bytes)

---

## Phase 2: Context Injection Testing (After Implementation)

Once context injection is implemented, test end-to-end RAG:

### Test 1: CLI → ChatGPT Context

1. **Capture via CLI:**
   ```bash
   mem "This project uses Node.js, Supabase, pgvector, and OpenAI embeddings"
   ```

2. **Wait 30 seconds** (for embedding generation)

3. **Ask ChatGPT:**
   "What database technology am I using in my current project?"

4. **Expected:** ChatGPT references "Supabase" or "pgvector" from injected context

### Test 2: ChatGPT → ChatGPT Context

1. **Conversation 1:** Tell ChatGPT about a project
   "I'm building a Chrome extension for long-term memory using RAG"

2. **Sync:** `chrome.runtime.sendMessage({type: 'SYNC_TO_SUPABASE'}, console.log)`

3. **New Chat Session** (click "+ New chat")

4. **Conversation 2:** Ask ChatGPT
   "What project was I working on earlier today?"

5. **Expected:** ChatGPT references the RAG/Chrome extension from previous chat

---

## Debugging Commands

### Check Stored Config
```javascript
chrome.storage.local.get(['api_config'], (result) => {
  if (result.api_config) {
    console.log('✅ API Config found');
    console.log('   Supabase URL:', result.api_config.supabaseUrl);
    console.log('   Has OpenAI key:', !!result.api_config.openaiKey);
  } else {
    console.error('❌ No API config found - run setup script first');
  }
});
```

### Check Sync Status
```javascript
chrome.storage.local.get(['last_sync_status'], (result) => {
  if (result.last_sync_status) {
    console.log('📊 Last Sync:', new Date(result.last_sync_status.lastSyncTime).toLocaleString());
    console.log('   Synced count:', result.last_sync_status.syncedCount);
    console.log('   Total synced IDs:', result.last_sync_status.syncedMessageIds.length);
  } else {
    console.log('⚠️ No sync history yet');
  }
});
```

### Test Search
```javascript
chrome.runtime.sendMessage({
  type: 'SEARCH_MESSAGES',
  query: 'quantum computing',
  options: { limit: 3, threshold: 0.5 }
}, (response) => {
  if (response.success) {
    console.log(`🔍 Found ${response.results.length} results`);
    console.table(response.results.map(r => ({
      content: r.content.substring(0, 50) + '...',
      distance: r.distance.toFixed(3),
      source: r.source
    })));
  }
});
```

### Clear Storage (If Needed)
```javascript
// WARNING: This deletes all captured messages!
chrome.storage.local.clear(() => {
  console.log('🗑️ Storage cleared');
  console.log('   You will need to re-capture conversations');
});
```

---

## Troubleshooting

### No Messages Captured
- Check extension is loaded: `chrome://extensions`
- Check inject.js loaded: Look for "KYT INJECTED: Fetch override installed"
- Refresh ChatGPT page
- Check for errors in console

### Sync Fails: 401 Unauthorized
- Check OpenAI API key is valid
- Verify key starts with `sk-`
- Check key not expired in OpenAI dashboard

### Sync Fails: Supabase Error
- Check Supabase URL format: `https://xxx.supabase.co`
- Verify anon key (not service_role key)
- Check messages table exists: `SELECT * FROM messages LIMIT 1`
- Verify match_messages() function exists

### Search Returns No Results
- Check messages have embeddings: `SELECT COUNT(*) FROM messages WHERE embedding IS NOT NULL`
- Try lower threshold: `options: { threshold: 0.7 }`
- Verify semantic relevance (search needs similar content)

---

## Success Criteria

Phase 1 complete when:
- ✅ Extension loaded without errors
- ✅ 5+ ChatGPT messages captured
- ✅ Sync successful (5+ messages synced)
- ✅ Supabase query shows ChatGPT messages with embeddings
- ✅ Search test returns relevant results

**Then proceed to Phase 2: Context Injection Implementation**
