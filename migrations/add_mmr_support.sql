-- Migration: Add MMR support to match_messages function
-- Purpose: Return embeddings for client-side MMR reranking
-- Date: 2025-11-16
-- Issue: Need inter-item similarity for MMR diversity scoring

-- Drop existing function
DROP FUNCTION IF EXISTS match_messages(vector(1536), float, int, int);

-- Create updated function that returns embeddings for MMR
CREATE OR REPLACE FUNCTION match_messages(
  query_embedding vector(1536),
  match_threshold float,
  match_count int,
  exclude_recent_seconds int DEFAULT 120
)
RETURNS TABLE (
  id uuid,
  content text,
  msg_timestamp bigint,
  source text,
  distance float,
  embedding vector(1536)  -- NEW: Return embedding for MMR reranking
)
LANGUAGE sql
AS $$
  SELECT
    id,
    content,
    timestamp as msg_timestamp,
    source,
    (embedding <=> query_embedding) as distance,
    embedding  -- Return embedding for client-side MMR
  FROM messages
  WHERE (embedding <=> query_embedding) < match_threshold
    AND timestamp < EXTRACT(EPOCH FROM NOW())::bigint * 1000 - (exclude_recent_seconds * 1000)
  ORDER BY embedding <=> query_embedding
  LIMIT match_count;
$$;

-- Grant execute permission to authenticated users
GRANT EXECUTE ON FUNCTION match_messages(vector(1536), float, int, int) TO authenticated;
GRANT EXECUTE ON FUNCTION match_messages(vector(1536), float, int, int) TO anon;

-- Verification: Check function signature
SELECT 
  routine_name,
  data_type as return_type,
  routine_definition
FROM information_schema.routines
WHERE routine_name = 'match_messages';

-- Note: This migration should be run in Supabase SQL Editor
-- After running, update background.js to use MMR reranking on results
