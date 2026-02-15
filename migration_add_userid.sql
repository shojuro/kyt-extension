-- KYT Day 4: User ID Integration
-- Purpose: Add user_id to messages table and update search function for multi-user support.

-- 1. Add user_id to messages table
ALTER TABLE IF EXISTS messages 
ADD COLUMN IF NOT EXISTS user_id UUID;

-- Index for performance
CREATE INDEX IF NOT EXISTS messages_user_id_idx ON messages(user_id);

-- 2. Update match_messages_v2 to support user_id filtering
CREATE OR REPLACE FUNCTION match_messages_v2(
  query_embedding vector(4096),
  match_threshold float DEFAULT 0.6,
  match_count int DEFAULT 5,
  filter jsonb DEFAULT '{}'::jsonb,
  min_timestamp bigint DEFAULT 0
)
RETURNS TABLE (
  id uuid,
  content text,
  role text,
  conversation_id text,
  model text,
  msg_timestamp bigint,
  message_id text,
  source text,
  created_at timestamp,
  synced_from_extension timestamp,
  embedding vector(4096),
  distance float
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    messages.id,
    messages.content,
    messages.role,
    messages.conversation_id,
    messages.model,
    messages."timestamp" as msg_timestamp,
    messages.message_id,
    messages.source,
    messages.created_at,
    messages.synced_from_extension,
    messages.embedding,
    (messages.embedding <=> query_embedding) as distance
  FROM messages
  WHERE (messages.embedding <=> query_embedding) < match_threshold
  -- Server-side filtering
  AND (min_timestamp = 0 OR messages."timestamp" >= min_timestamp)
  AND (filter->>'role' IS NULL OR messages.role = filter->>'role')
  AND (filter->>'source' IS NULL OR messages.source = filter->>'source')
  AND (filter->>'conversation_id' IS NULL OR messages.conversation_id = filter->>'conversation_id')
  -- User ID filtering (if provided in filter)
  AND (filter->>'user_id' IS NULL OR messages.user_id = (filter->>'user_id')::uuid)
  ORDER BY messages.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;
