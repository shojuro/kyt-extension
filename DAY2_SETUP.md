# Day 2 Setup Instructions

## ⚠️ REQUIRED: Run SQL in Supabase Dashboard

Before testing, you MUST add the 'source' column to the messages table.

### Steps:

1. **Open Supabase SQL Editor:**
   - Go to https://supabase.com/dashboard/project/svrcvfzlwhnixzuxaccf/sql/new

2. **Copy and paste this SQL:**
   ```sql
   -- Add source column to messages table
   ALTER TABLE messages ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'chatgpt';

   -- Add index for filtering by source
   CREATE INDEX IF NOT EXISTS messages_source_idx ON messages (source);

   -- Update existing records
   UPDATE messages SET source = 'chatgpt' WHERE source IS NULL;
   ```

   OR just run the entire file: `supabase_add_source_column.sql`

3. **Click "Run"**

4. **Verify it worked:**
   ```sql
   SELECT column_name, data_type, column_default
   FROM information_schema.columns
   WHERE table_name = 'messages' AND column_name = 'source';
   ```

   Should return:
   ```
   column_name | data_type | column_default
   -----------+-----------+---------------
   source      | text      | 'chatgpt'
   ```

---

## 🧪 Test CLI Memory Tool

After running the SQL:

```bash
# Test basic capture
node cli/mem.js "Testing CLI memory capture - Day 2 validation"

# Test with description
node cli/mem.js "Remember: The RLS policy error was fixed by adding SELECT permission"

# Test pipe (create test file first)
echo "Test output from npm test" | node cli/mem.js --pipe "Test results"
```

Expected output:
```
🧠 Capturing memory...
✅ Memory captured successfully
   ID: cli_1234567890_abc123
   Length: 45 characters
   Source: CLI

💡 This memory is now searchable from ChatGPT and CLI
```

---

## 🔧 Set Up Extension API Keys

For the extension to sync/search, you need to configure API keys:

```javascript
// In browser console (ChatGPT page with extension loaded)
chrome.runtime.sendMessage({
  type: 'SET_API_CONFIG',
  config: {
    supabaseUrl: 'YOUR_SUPABASE_URL',
    supabaseKey: 'YOUR_SUPABASE_ANON_KEY',
    openaiKey: 'YOUR_OPENAI_API_KEY'
  }
}, response => {
  console.log('Config saved:', response);
});
```

Then test sync:
```javascript
chrome.runtime.sendMessage({
  type: 'SYNC_TO_SUPABASE'
}, response => {
  console.log('Sync result:', response);
});
```

---

## ✅ Next Steps

Once SQL is run and tests pass:
1. Capture test message via CLI ✅
2. Sync ChatGPT messages via extension
3. Search across both sources
4. Create validation suite
5. Document Day 2 complete

---

**Current Status:**
- ✅ Database schema ready (after you run SQL)
- ✅ Browser modules created
- ✅ Background handlers integrated
- ✅ CLI tool created
- ⏳ Waiting for SQL execution
- ⏳ Testing pending
