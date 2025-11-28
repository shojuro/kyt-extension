-- KYT Day 2: Vector Similarity Search Function
-- This function performs cosine similarity search on message embeddings
-- Must be run in Supabase SQL Editor after supabase_schema.sql
--
-- DISTANCE METRIC: Cosine Distance (<=> operator)
-- - Optimal for OpenAI embeddings (text-embedding-3-small) which are normalized
-- - Measures angular similarity (direction), not magnitude
-- - Range: 0 (identical) to 2 (opposite)
-- - Industry standard for semantic search with normalized vectors

-- Drop function if exists (for re-running)
DROP FUNCTION IF EXISTS match_messages_v2(vector(1536), float, int, jsonb, bigint);

-- Create vector similarity search function (v2 to avoid overload conflicts)
CREATE OR REPLACE FUNCTION match_messages_v2(
  query_embedding vector(1536),
  match_threshold float DEFAULT 0.6, -- Calibrated optimal threshold (Distance)
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
  embedding vector(1536),
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
  FROM public.messages
  WHERE (messages.embedding <=> query_embedding) < match_threshold
  -- Server-side filtering for Precision
  AND (min_timestamp = 0 OR messages."timestamp" >= min_timestamp)
  AND (filter->>'role' IS NULL OR messages.role = filter->>'role')
  AND (filter->>'source' IS NULL OR messages.source = filter->>'source')
  AND (filter->>'conversation_id' IS NULL OR messages.conversation_id = filter->>'conversation_id')
  ORDER BY messages.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

-- Test the function (should return empty results if no messages synced yet)
SELECT * FROM match_messages_v2(
  query_embedding => (SELECT embedding FROM public.messages LIMIT 1),
  match_threshold => 0.5::float,
  match_count => 5
);

-- Verify function was created
SELECT routine_name, routine_type
FROM information_schema.routines
WHERE routine_name = 'match_messages';
