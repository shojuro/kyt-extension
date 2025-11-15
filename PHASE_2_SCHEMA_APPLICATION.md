# Phase 2: Apply chat_turns Schema to Supabase

**Date**: 2025-11-15
**Goal**: Create `chat_turns` table in Supabase for conversation-turn chunking
**Expected Time**: 5 minutes

---

## 📋 Prerequisites

- ✅ Supabase project set up
- ✅ SQL Editor access in Supabase dashboard
- ✅ `pgvector` extension enabled (should already be enabled from `messages` table)

---

## 🚀 Step 1: Open Supabase SQL Editor

1. Go to your Supabase project dashboard
2. Navigate to **SQL Editor** (left sidebar)
3. Click **New Query**

---

## 📝 Step 2: Copy and Execute Schema

**Copy the entire contents of `supabase_chat_turns_schema.sql`** and paste into the SQL Editor.

**OR** run these sections individually:

### Section 1: Create Table
```sql
CREATE TABLE IF NOT EXISTS chat_turns (
  -- Primary key
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Turn identification
  turn_range TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('chatgpt', 'claude', 'cli')),

  -- Content (formatted as: "User: ...\nAssistant: ...\n...")
  content TEXT NOT NULL,

  -- Metadata
  speakers TEXT[] NOT NULL,
  turn_count INTEGER NOT NULL,
  start_timestamp BIGINT NOT NULL,
  end_timestamp BIGINT NOT NULL,

  -- Extracted topics (for HyDE preprocessing and filtering)
  topics TEXT[],
  hypothetical_questions TEXT[],

  -- Vector embedding (1536 dimensions for text-embedding-3-small)
  embedding VECTOR(1536),

  -- User attribution (for RLS)
  user_id UUID NOT NULL,

  -- Timestamps
  created_at TIMESTAMP DEFAULT NOW(),
  synced_from_extension TIMESTAMP DEFAULT NOW(),

  -- Constraints
  CONSTRAINT valid_turn_count CHECK (turn_count > 0),
  CONSTRAINT valid_timestamps CHECK (end_timestamp >= start_timestamp)
);
```

### Section 2: Create Indexes
```sql
-- Vector similarity search (CRITICAL for search performance)
CREATE INDEX IF NOT EXISTS chat_turns_embedding_idx ON chat_turns
USING hnsw (embedding vector_cosine_ops);

-- Filter by platform + user (composite for efficiency)
CREATE INDEX IF NOT EXISTS chat_turns_platform_user_idx ON chat_turns (platform, user_id);

-- Filter by user (for RLS queries)
CREATE INDEX IF NOT EXISTS chat_turns_user_idx ON chat_turns (user_id);

-- Filter by conversation
CREATE INDEX IF NOT EXISTS chat_turns_conversation_idx ON chat_turns (conversation_id);

-- Filter by time range
CREATE INDEX IF NOT EXISTS chat_turns_timestamp_idx ON chat_turns (start_timestamp DESC);

-- GIN index for topic array searches
CREATE INDEX IF NOT EXISTS chat_turns_topics_idx ON chat_turns USING GIN (topics);
```

### Section 3: Enable Row Level Security
```sql
-- Enable RLS
ALTER TABLE chat_turns ENABLE ROW LEVEL SECURITY;

-- Policy: Users can only see their own chat turns
CREATE POLICY chat_turns_user_isolation ON chat_turns
  FOR ALL
  USING (user_id = auth.uid());
```

### Section 4: Create Free Tier View
```sql
-- Create view for free tier (ChatGPT only)
CREATE OR REPLACE VIEW chat_turns_free AS
SELECT
  id,
  turn_range,
  conversation_id,
  platform,
  content,
  speakers,
  turn_count,
  start_timestamp,
  end_timestamp,
  topics,
  hypothetical_questions,
  embedding,
  created_at
FROM chat_turns
WHERE platform = 'chatgpt'
  AND user_id = auth.uid();
```

### Section 5: Create Search Function
```sql
-- Function: Search chat turns by semantic similarity
CREATE OR REPLACE FUNCTION search_chat_turns(
  query_embedding VECTOR(1536),
  match_threshold FLOAT DEFAULT 0.5,
  match_count INT DEFAULT 5,
  filter_platform TEXT DEFAULT NULL
)
RETURNS TABLE (
  id UUID,
  turn_range TEXT,
  conversation_id TEXT,
  content TEXT,
  topics TEXT[],
  similarity FLOAT
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    ct.id,
    ct.turn_range,
    ct.conversation_id,
    ct.content,
    ct.topics,
    1 - (ct.embedding <=> query_embedding) AS similarity
  FROM chat_turns ct
  WHERE
    ct.user_id = auth.uid()
    AND (filter_platform IS NULL OR ct.platform = filter_platform)
    AND (1 - (ct.embedding <=> query_embedding)) > match_threshold
  ORDER BY ct.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;
```

### Section 6: Add Table Comments
```sql
COMMENT ON TABLE chat_turns IS 'Conversation-turn chunks with embeddings for context-aware search. Uses sliding window (5-7 turns, 2-3 overlap) to preserve conversational context.';

COMMENT ON COLUMN chat_turns.turn_range IS 'Range of turns in this chunk (e.g., "1-5" means turns 1 through 5)';

COMMENT ON COLUMN chat_turns.content IS 'Formatted turn content: "User: ...\nAssistant: ...\n..." preserving speaker attribution';

COMMENT ON COLUMN chat_turns.hypothetical_questions IS 'HyDE-generated questions for improved retrieval (e.g., ["How to fix RLS?", "Python auth error"])';

COMMENT ON COLUMN chat_turns.user_id IS 'User ID from Supabase Auth (auth.uid()) - enforces multi-tenant isolation via RLS';
```

---

## ✅ Step 3: Verify Schema Creation

Run these verification queries in the SQL Editor:

### Check Table Structure
```sql
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'chat_turns'
ORDER BY ordinal_position;
```

**Expected Output**: 17 columns (id, turn_range, conversation_id, platform, content, speakers, turn_count, start_timestamp, end_timestamp, topics, hypothetical_questions, embedding, user_id, created_at, synced_from_extension, valid_turn_count, valid_timestamps)

### Check Indexes
```sql
SELECT indexname, indexdef
FROM pg_indexes
WHERE tablename = 'chat_turns'
ORDER BY indexname;
```

**Expected Output**: 6 indexes (chat_turns_embedding_idx, chat_turns_platform_user_idx, chat_turns_user_idx, chat_turns_conversation_idx, chat_turns_timestamp_idx, chat_turns_topics_idx)

### Check RLS Policies
```sql
SELECT schemaname, tablename, policyname, permissive, roles, qual
FROM pg_policies
WHERE tablename = 'chat_turns';
```

**Expected Output**: 1 policy (chat_turns_user_isolation)

### Check Constraints
```sql
SELECT
  tc.constraint_name,
  tc.constraint_type,
  cc.check_clause
FROM information_schema.table_constraints tc
LEFT JOIN information_schema.check_constraints cc
  ON tc.constraint_name = cc.constraint_name
WHERE tc.table_name = 'chat_turns'
ORDER BY tc.constraint_type, tc.constraint_name;
```

**Expected Output**: 4 constraints (valid_turn_count, valid_timestamps, platform check, primary key)

### Check pgvector Extension
```sql
SELECT * FROM pg_extension WHERE extname = 'vector';
```

**Expected Output**: 1 row showing `vector` extension is enabled

---

## 🎯 Success Criteria

**Schema is successfully applied when**:
- ✅ `chat_turns` table exists with 17 columns
- ✅ 6 indexes created (including HNSW vector index)
- ✅ RLS enabled with 1 policy (chat_turns_user_isolation)
- ✅ 4 constraints enforced (valid_turn_count, valid_timestamps, platform, primary key)
- ✅ `search_chat_turns()` function created
- ✅ `chat_turns_free` view created
- ✅ No errors in SQL execution

---

## 🐛 Troubleshooting

### Error: "type 'vector' does not exist"
**Cause**: `pgvector` extension not enabled

**Fix**:
```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

### Error: "relation 'chat_turns' already exists"
**Cause**: Table was previously created

**Solution**: This is fine - `CREATE TABLE IF NOT EXISTS` will skip creation. Verify with structure check query above.

### Error: "policy 'chat_turns_user_isolation' already exists"
**Cause**: Policy was previously created

**Fix**:
```sql
DROP POLICY IF EXISTS chat_turns_user_isolation ON chat_turns;
-- Then re-run the CREATE POLICY statement
```

### Error: "function search_chat_turns already exists"
**Cause**: Function was previously created

**Solution**: This is fine - `CREATE OR REPLACE FUNCTION` will update it.

---

## ⏭️ Next Steps After Schema Application

1. **Verify schema** using the queries above
2. **Update CHANGELOG.md** with Phase 2 completion
3. **Commit schema application documentation**
4. **Proceed to Phase 3**: Implement conversation chunker (`src/conversation-chunker.js`)

---

**Ready to apply the schema?** Follow the steps above and verify the results!
