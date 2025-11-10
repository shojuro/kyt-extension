-- KYT Day 2: Vector Similarity Search Function
-- This function performs cosine similarity search on message embeddings
-- Must be run in Supabase SQL Editor after supabase_schema.sql

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
  timestamp bigint,
  message_id text,
  created_at timestamp,
  synced_from_extension timestamp,
  similarity float
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
    messages.timestamp,
    messages.message_id,
    messages.created_at,
    messages.synced_from_extension,
    1 - (messages.embedding <=> query_embedding) as similarity
  FROM messages
  WHERE 1 - (messages.embedding <=> query_embedding) > match_threshold
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
