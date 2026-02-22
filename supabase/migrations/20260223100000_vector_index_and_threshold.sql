-- Migration: match_messages_with_gravity default threshold fix
-- Purpose: Update DEFAULT threshold from 0.7 to 0.5
--
-- Note on indexes: HNSW/IVFFlat indexes cannot be created on vector(4096) columns
-- (pgvector 0.8.0 caps at 2000 dims for vector type, 4000 for halfvec).
-- Sequential scan remains the only option at 4096d. Statement timeouts in the
-- next migration (20260223100001) provide the safety net for slow seq scans.
--
-- No stale entities index exists to drop (confirmed via pg_indexes query).

-- Recreate match_messages_with_gravity with DEFAULT 0.5 threshold
-- The caller already passes 0.5, but the function default was still 0.7.
-- Any call without an explicit threshold silently used the wrong cutoff.
DROP FUNCTION IF EXISTS match_messages_with_gravity(vector(4096), float, int, int, UUID, UUID[]);

CREATE OR REPLACE FUNCTION match_messages_with_gravity(
  query_embedding vector(4096),
  match_threshold float DEFAULT 0.5,
  match_count int DEFAULT 10,
  exclude_recent_seconds int DEFAULT 120,
  p_user_id UUID DEFAULT NULL,
  boost_entity_ids UUID[] DEFAULT NULL
)
RETURNS TABLE (
  id UUID,
  content TEXT,
  contextual_content TEXT,
  turn_range TEXT,
  conversation_id TEXT,
  speakers TEXT[],
  topics TEXT[],
  created_at TIMESTAMPTZ,
  vector_similarity FLOAT,
  gravity_score FLOAT,
  impact_score INT,
  intimacy_level INT,
  access_count INT,
  last_accessed TIMESTAMPTZ,
  entity_boost BOOLEAN
) AS $$
BEGIN
  IF match_threshold < 0 OR match_threshold > 1 THEN
    RAISE EXCEPTION 'match_threshold must be between 0 and 1, got %', match_threshold;
  END IF;

  IF match_count < 1 OR match_count > 100 THEN
    RAISE EXCEPTION 'match_count must be between 1 and 100, got %', match_count;
  END IF;

  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'user_id is required for security (RLS enforcement)';
  END IF;

  RETURN QUERY
  SELECT
    ct.id,
    ct.content,
    ct.contextual_content,
    ct.turn_range,
    ct.conversation_id,
    ct.speakers,
    ct.topics,
    ct.created_at::TIMESTAMPTZ,
    (1 - (ct.embedding <=> query_embedding))::FLOAT AS vector_similarity,
    calculate_gravity_score(
      1 - (ct.embedding <=> query_embedding),
      COALESCE(ct.impact_score, 0),
      COALESCE(ct.intimacy_level, 0),
      ct.created_at::TIMESTAMPTZ,
      COALESCE(ct.last_accessed, ct.created_at::TIMESTAMPTZ),
      COALESCE(ct.access_count, 0)
    )::FLOAT AS gravity_score,
    ct.impact_score::INT,
    ct.intimacy_level::INT,
    ct.access_count,
    ct.last_accessed,
    CASE
      WHEN boost_entity_ids IS NOT NULL AND EXISTS (
        SELECT 1 FROM entity_mentions em
        WHERE em.chat_turn_id = ct.id
        AND em.entity_id = ANY(boost_entity_ids)
      ) THEN TRUE
      ELSE FALSE
    END AS entity_boost
  FROM chat_turns ct
  WHERE
    ct.user_id = p_user_id
    AND (1 - (ct.embedding <=> query_embedding)) > match_threshold
    AND ct.created_at < NOW() - (exclude_recent_seconds || ' seconds')::INTERVAL
    AND (ct.is_question IS NULL OR ct.is_question = FALSE)
    AND (ct.deflection IS NULL OR ct.deflection < 0.70)
  ORDER BY
    gravity_score DESC NULLS LAST
  LIMIT match_count;
END;
$$ LANGUAGE plpgsql STABLE;

-- Re-grant permissions (DROP removes grants)
GRANT EXECUTE ON FUNCTION match_messages_with_gravity(vector(4096), float, int, int, UUID, UUID[]) TO authenticated;
GRANT EXECUTE ON FUNCTION match_messages_with_gravity(vector(4096), float, int, int, UUID, UUID[]) TO anon;
