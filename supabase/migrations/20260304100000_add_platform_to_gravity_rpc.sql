-- Migration: Add platform column to match_messages_with_gravity RETURNS TABLE
--
-- WHY: Gap 3 fix — when user asks "what did I discuss on Gemini?", dev conversations
-- *about* Gemini (from claude-code) outrank actual Gemini user content. To apply a
-- platform-mismatch penalty, the client/server pipeline needs the platform field.
--
-- APPROACH: Add ct.platform to SELECT + RETURNS TABLE. Optional p_platform filter
-- param for future use (NULL = no filter, backward-compatible).
--
-- Must DROP old signature first to prevent overload ambiguity (standard pattern).

SET search_path TO public, extensions;

-- Drop old signature (7 params: vector, float, int, int, UUID, UUID[], UUID)
DROP FUNCTION IF EXISTS match_messages_with_gravity(vector(1024), float, int, int, UUID, UUID[], UUID);

CREATE OR REPLACE FUNCTION match_messages_with_gravity(
  query_embedding vector(1024),
  match_threshold float DEFAULT 0.5,
  match_count int DEFAULT 10,
  exclude_recent_seconds int DEFAULT 120,
  p_user_id UUID DEFAULT NULL,
  boost_entity_ids UUID[] DEFAULT NULL,
  p_profile_id UUID DEFAULT NULL,
  p_platform TEXT DEFAULT NULL
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
  entity_boost BOOLEAN,
  platform TEXT
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
    END AS entity_boost,
    ct.platform
  FROM chat_turns ct
  WHERE
    ct.user_id = p_user_id
    AND (p_profile_id IS NULL OR ct.profile_id = p_profile_id)
    AND (p_platform IS NULL OR ct.platform = p_platform)
    AND (1 - (ct.embedding <=> query_embedding)) > match_threshold
    AND ct.created_at < NOW() - (exclude_recent_seconds || ' seconds')::INTERVAL
    AND (ct.is_question IS NULL OR ct.is_question = FALSE)
    AND (ct.deflection IS NULL OR ct.deflection < 0.70)
    AND (ct.exclude_from_search IS NULL OR ct.exclude_from_search = FALSE)
  ORDER BY
    gravity_score DESC NULLS LAST
  LIMIT match_count;
END;
$$ LANGUAGE plpgsql STABLE;

ALTER FUNCTION match_messages_with_gravity SET statement_timeout = '45s';

-- Grant access
GRANT EXECUTE ON FUNCTION match_messages_with_gravity(vector(1024), float, int, int, UUID, UUID[], UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION match_messages_with_gravity(vector(1024), float, int, int, UUID, UUID[], UUID, TEXT) TO anon;
