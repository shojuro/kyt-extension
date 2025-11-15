-- KYT Conversation-Turn Chunking Schema
-- Purpose: Store chat turns with embeddings for conversational context search
-- Date: 2025-11-15
--
-- CONTEXT:
-- - Replaces message-level storage with turn-level chunks
-- - Preserves conversational context (5-7 user-assistant pairs)
-- - Enables conversation-aware semantic search
-- - Supports HyDE preprocessing (hypothetical questions)
-- - RLS enforced for multi-tenant security
-- - Free tier filtering via platform column

-- ============================================
-- 1. Create chat_turns table
-- ============================================
CREATE TABLE IF NOT EXISTS chat_turns (
  -- Primary key
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Turn identification
  turn_range TEXT NOT NULL, -- e.g., "1-5" (turns 1 through 5)
  conversation_id TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('chatgpt', 'claude', 'cli')),

  -- Content (formatted as: "User: ...\nAssistant: ...\n...")
  -- This preserves speaker attribution and conversational flow
  content TEXT NOT NULL,

  -- Metadata
  speakers TEXT[] NOT NULL, -- e.g., ['user', 'assistant']
  turn_count INTEGER NOT NULL, -- Number of turns in this chunk
  start_timestamp BIGINT NOT NULL, -- First turn timestamp (Unix ms)
  end_timestamp BIGINT NOT NULL, -- Last turn timestamp (Unix ms)

  -- Extracted topics (for HyDE preprocessing and filtering)
  topics TEXT[], -- e.g., ['python', 'debugging', 'RLS']
  hypothetical_questions TEXT[], -- Generated questions for HyDE (e.g., ['How to fix RLS?', 'Python auth error'])

  -- Vector embedding (1536 dimensions for text-embedding-3-small)
  -- This is the semantic representation of the turn chunk
  embedding VECTOR(1536),

  -- User attribution (for RLS - Row Level Security)
  -- CRITICAL: This enables multi-tenant isolation
  -- Will be populated from Supabase Auth after Day 2 implementation
  user_id UUID NOT NULL,

  -- Timestamps
  created_at TIMESTAMP DEFAULT NOW(),
  synced_from_extension TIMESTAMP DEFAULT NOW(),

  -- Constraints
  CONSTRAINT valid_turn_count CHECK (turn_count > 0),
  CONSTRAINT valid_timestamps CHECK (end_timestamp >= start_timestamp)
);

-- ============================================
-- 2. Create indexes for performance
-- ============================================

-- Vector similarity search (CRITICAL for search performance)
-- HNSW (Hierarchical Navigable Small World) enables fast approximate nearest neighbor search
-- vector_cosine_ops: Uses cosine similarity (standard for embeddings)
CREATE INDEX IF NOT EXISTS chat_turns_embedding_idx ON chat_turns
USING hnsw (embedding vector_cosine_ops);

-- Filter by platform (for free tier: platform = 'chatgpt')
-- Composite index: platform + user_id for efficient filtering
CREATE INDEX IF NOT EXISTS chat_turns_platform_user_idx ON chat_turns (platform, user_id);

-- Filter by user (for RLS queries: user_id = auth.uid())
CREATE INDEX IF NOT EXISTS chat_turns_user_idx ON chat_turns (user_id);

-- Filter by conversation (for "show me this conversation" queries)
CREATE INDEX IF NOT EXISTS chat_turns_conversation_idx ON chat_turns (conversation_id);

-- Filter by time range (for "last week's conversations" queries)
CREATE INDEX IF NOT EXISTS chat_turns_timestamp_idx ON chat_turns (start_timestamp DESC);

-- GIN index for topic array searches (e.g., WHERE 'python' = ANY(topics))
CREATE INDEX IF NOT EXISTS chat_turns_topics_idx ON chat_turns USING GIN (topics);

-- ============================================
-- 3. Row Level Security (RLS)
-- ============================================
-- CRITICAL: Without RLS, all users would see each other's data
-- This is non-negotiable for MVP (security + monetization)

ALTER TABLE chat_turns ENABLE ROW LEVEL SECURITY;

-- Policy: Users can only see their own chat turns
-- This matches against auth.uid() from Supabase Auth JWT
CREATE POLICY chat_turns_user_isolation ON chat_turns
  FOR ALL
  USING (user_id = auth.uid());

-- ============================================
-- 4. Free Tier Logic (Platform Filtering)
-- ============================================
-- Free tier users: ChatGPT only
-- Pro tier users: ChatGPT + Claude + CLI
-- Dev tier users: All platforms + higher rate limits

-- Create view for free tier (ChatGPT only)
-- This simplifies queries for free tier users
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
  AND user_id = auth.uid(); -- Still enforce RLS in view

-- ============================================
-- 5. Helper Functions
-- ============================================

-- Function: Search chat turns by semantic similarity
-- Usage: SELECT * FROM search_chat_turns('python bug', 5);
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

-- ============================================
-- 6. Verification Queries
-- ============================================

-- Check if pgvector extension is enabled (required for VECTOR type)
SELECT * FROM pg_extension WHERE extname = 'vector';

-- Check table structure
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'chat_turns'
ORDER BY ordinal_position;

-- Check indexes
SELECT indexname, indexdef
FROM pg_indexes
WHERE tablename = 'chat_turns'
ORDER BY indexname;

-- Check RLS policies
SELECT schemaname, tablename, policyname, permissive, roles, qual
FROM pg_policies
WHERE tablename = 'chat_turns';

-- Check constraints
SELECT
  tc.constraint_name,
  tc.constraint_type,
  cc.check_clause
FROM information_schema.table_constraints tc
LEFT JOIN information_schema.check_constraints cc
  ON tc.constraint_name = cc.constraint_name
WHERE tc.table_name = 'chat_turns'
ORDER BY tc.constraint_type, tc.constraint_name;

-- ============================================
-- 7. Sample Queries (for testing)
-- ============================================

-- Count turns by platform
SELECT platform, COUNT(*) as turn_count
FROM chat_turns
GROUP BY platform;

-- Find turns by topic
SELECT turn_range, content, topics
FROM chat_turns
WHERE 'python' = ANY(topics)
LIMIT 10;

-- Get recent conversations
SELECT
  conversation_id,
  COUNT(*) as chunk_count,
  MIN(start_timestamp) as first_message,
  MAX(end_timestamp) as last_message
FROM chat_turns
GROUP BY conversation_id
ORDER BY MAX(end_timestamp) DESC
LIMIT 10;

-- Test semantic search (requires embedding)
-- SELECT * FROM search_chat_turns('[embedding vector]'::vector, 0.7, 5);

-- ============================================
-- 8. Migration Notes
-- ============================================

-- IMPORTANT: This schema COEXISTS with the existing 'messages' table
--
-- Migration strategy:
-- 1. Keep 'messages' table for backward compatibility
-- 2. Use 'chat_turns' for new conversation-aware features
-- 3. Gradually migrate existing messages to turn chunks
-- 4. Eventually deprecate 'messages' table (after validation)
--
-- Dual-write approach (temporary):
-- - Sync continues writing to 'messages' (existing code)
-- - New chunking logic writes to 'chat_turns' (Phase 5)
-- - Both tables contain same data, different granularity
--
-- HyDE batch process:
-- - Run on existing 'messages' data (30-day history)
-- - Generate turn chunks with hypothetical questions
-- - Populate 'chat_turns' table
-- - User gets instant value on download (WOW moment)

-- ============================================
-- 9. Performance Considerations
-- ============================================

-- Expected data volume:
-- - 1 user × 30 days × 20 messages/day = 600 messages
-- - At 5 turns per chunk = ~120 chunks per user
-- - At 1KB per chunk = ~120KB per user
-- - 10,000 users = 1.2GB
--
-- HNSW index build time:
-- - <1000 vectors: instant
-- - 10,000 vectors: ~1 second
-- - 100,000 vectors: ~10 seconds
-- - 1M vectors: ~2 minutes
--
-- Query performance:
-- - HNSW search: <10ms for top-5 results
-- - Platform filtering: <1ms (indexed)
-- - RLS overhead: minimal (indexed on user_id)

-- ============================================
-- 10. Security Notes
-- ============================================

-- RLS Policy Explanation:
-- - auth.uid() extracts user ID from Supabase Auth JWT
-- - JWT automatically validated by Supabase
-- - No manual token validation needed
-- - Policy enforced at PostgreSQL level (database-level security)
--
-- Attack surface:
-- - SQL injection: Prevented by parameterized queries
-- - Data leakage: Prevented by RLS (user_id = auth.uid())
-- - Token forgery: Prevented by Supabase Auth validation
--
-- Free tier enforcement:
-- - Platform filtering via application logic (not RLS)
-- - chat_turns_free view simplifies free tier queries
-- - Pro tier check: SELECT platform FROM chat_turns (includes 'claude')

COMMENT ON TABLE chat_turns IS 'Conversation-turn chunks with embeddings for context-aware search. Uses sliding window (5-7 turns, 2-3 overlap) to preserve conversational context.';
COMMENT ON COLUMN chat_turns.turn_range IS 'Range of turns in this chunk (e.g., "1-5" means turns 1 through 5)';
COMMENT ON COLUMN chat_turns.content IS 'Formatted turn content: "User: ...\nAssistant: ...\n..." preserving speaker attribution';
COMMENT ON COLUMN chat_turns.hypothetical_questions IS 'HyDE-generated questions for improved retrieval (e.g., ["How to fix RLS?", "Python auth error"])';
COMMENT ON COLUMN chat_turns.user_id IS 'User ID from Supabase Auth (auth.uid()) - enforces multi-tenant isolation via RLS';
