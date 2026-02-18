-- Migration: Add is_question and deflection columns to messages table
-- Purpose: Filter self-referential questions (P1) and high-confidence deflections (P3)
-- from retrieval pipeline to prevent preference retrieval pollution.

-- 1. Add is_question column (default FALSE)
ALTER TABLE messages ADD COLUMN IF NOT EXISTS is_question BOOLEAN DEFAULT FALSE;

-- 2. Add deflection column (float, nullable)
ALTER TABLE messages ADD COLUMN IF NOT EXISTS deflection FLOAT;

-- 3. Partial index: only index non-question rows (the ones we actually search)
CREATE INDEX IF NOT EXISTS idx_messages_is_question ON messages(is_question) WHERE is_question = FALSE;

-- 4. Update match_messages_v2 RPC to exclude questions from vector search
-- Drop existing signature first (follows pattern from 20260212000000)
DROP FUNCTION IF EXISTS match_messages_v2(vector(4096), float, int, jsonb, bigint);

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
    AND (m.is_question IS NULL OR m.is_question = FALSE)
  ORDER BY m.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;
