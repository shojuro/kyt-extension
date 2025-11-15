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
DROP FUNCTION IF EXISTS match_messages(vector(1536), float, int);

-- Create vector similarity search function
CREATE OR REPLACE FUNCTION match_messages(
  query_embedding vector(1536),
  match_threshold float DEFAULT 0.5,
  match_count int DEFAULT 5
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
    -- Cosine distance: 0 (perfect match) to 2 (opposite)
    -- <=> operator is optimized for normalized embeddings
    (messages.embedding <=> query_embedding) as distance
  FROM messages
  WHERE (messages.embedding <=> query_embedding) < match_threshold
  ORDER BY messages.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

-- Test the function (should return empty results if no messages synced yet)
SELECT * FROM match_messages(
  (SELECT embedding FROM messages LIMIT 1),
  0.5,
  5
);

-- Verify function was created
SELECT routine_name, routine_type
FROM information_schema.routines
WHERE routine_name = 'match_messages';
