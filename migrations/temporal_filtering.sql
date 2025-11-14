-- Migration: Add temporal filtering to match_messages RPC function
-- Purpose: Prevent recent questions from polluting context retrieval
-- Date: 2025-11-14
-- Issue: Context pollution from rapid-fire user questions clustering in top results

-- Drop existing function
DROP FUNCTION IF EXISTS match_messages(vector(1536), float, int);

-- Create updated function with temporal exclusion
CREATE OR REPLACE FUNCTION match_messages(
  query_embedding vector(1536),
  match_threshold float,
  match_count int,
  exclude_recent_seconds int DEFAULT 120
)
RETURNS TABLE (
  id uuid,
  content text,
  msg_timestamp timestamp,
  source text,
  distance float
)
LANGUAGE sql
AS $$
  SELECT
    id,
    content,
    timestamp as msg_timestamp,
    source,
    (embedding <=> query_embedding) as distance
  FROM messages
  WHERE (embedding <=> query_embedding) < match_threshold
    AND timestamp < NOW() - (exclude_recent_seconds || ' seconds')::interval
  ORDER BY embedding <=> query_embedding
  LIMIT match_count;
$$;

-- Grant execute permission to authenticated users
GRANT EXECUTE ON FUNCTION match_messages(vector(1536), float, int, int) TO authenticated;
GRANT EXECUTE ON FUNCTION match_messages(vector(1536), float, int, int) TO anon;

-- Test the function (uncomment to test)
-- SELECT * FROM match_messages(
--   (SELECT embedding FROM messages LIMIT 1),  -- test embedding
--   0.5,                                         -- threshold
--   5,                                           -- count
--   120                                          -- exclude last 2 minutes
-- );
