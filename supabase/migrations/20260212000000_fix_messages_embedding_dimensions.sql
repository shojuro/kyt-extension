-- Migration: Fix messages.embedding dimension mismatch
-- The 20251127000000 migration updated chat_turns and entities to VECTOR(4096)
-- but missed the messages table, which still uses VECTOR(1536).
-- This causes match_messages_v2 to fail silently when called with 4096-dim embeddings.

-- 1. Alter messages.embedding to VECTOR(4096)
ALTER TABLE messages ALTER COLUMN embedding TYPE vector(4096);

-- 2. Drop the old function signature (accepts vector(1536))
DROP FUNCTION IF EXISTS match_messages_v2(vector(1536), float, int, jsonb, bigint);

-- 3. Recreate match_messages_v2 with correct 4096-dim signature
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
    m.id,
    m.content,
    m.role,
    m.conversation_id,
    m.model,
    m."timestamp" as msg_timestamp,
    m.message_id,
    m.source,
    m.created_at,
    m.synced_from_extension,
    m.embedding,
    (m.embedding <=> query_embedding) as distance
  FROM public.messages m
  WHERE (m.embedding <=> query_embedding) < match_threshold
    AND (min_timestamp = 0 OR m."timestamp" >= min_timestamp)
    AND (filter->>'role' IS NULL OR m.role = filter->>'role')
    AND (filter->>'source' IS NULL OR m.source = filter->>'source')
    AND (filter->>'conversation_id' IS NULL OR m.conversation_id = filter->>'conversation_id')
    AND (filter->>'user_id' IS NULL OR m.user_id = (filter->>'user_id')::uuid)
  ORDER BY m.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

-- 4. Null out stale 1536-dim embeddings so backfill picks them up
UPDATE messages SET embedding = NULL WHERE embedding IS NOT NULL;

-- 5. Rebuild HNSW index for new dimensions
DROP INDEX IF EXISTS messages_embedding_idx;
CREATE INDEX messages_embedding_idx ON messages USING hnsw (embedding vector_cosine_ops);
