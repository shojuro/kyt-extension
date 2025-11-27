-- Migration: Add Entity Search RPCs
-- Date: 2025-11-27
-- Applied directly to database, this file documents the changes

-- 1. Function to search for entities by embedding (for query entity extraction)
CREATE OR REPLACE FUNCTION search_entities_by_embedding(
    query_embedding vector(4096),
    match_threshold float DEFAULT 0.8,
    match_count int DEFAULT 5,
    p_user_id UUID DEFAULT NULL
)
RETURNS TABLE (
    id UUID,
    entity_text TEXT,
    canonical_name TEXT,
    similarity FLOAT
)
LANGUAGE plpgsql STABLE
AS $$
BEGIN
    RETURN QUERY
    SELECT
        e.id,
        e.entity_text,
        e.canonical_name,
        (1 - (e.embedding <=> query_embedding))::FLOAT AS similarity
    FROM entities e
    WHERE
        e.user_id = p_user_id
        AND (1 - (e.embedding <=> query_embedding)) > match_threshold
    ORDER BY e.embedding <=> query_embedding
    LIMIT match_count;
END;
$$;

-- 2. Update match_messages_with_gravity with entity boost support
-- Preserves gravity calculation, adds boost_entity_ids param and entity_boost return
CREATE OR REPLACE FUNCTION match_messages_with_gravity(
  query_embedding vector(4096),
  match_threshold float DEFAULT 0.7,
  match_count int DEFAULT 10,
  exclude_recent_seconds int DEFAULT 120,
  p_user_id UUID DEFAULT NULL,
  boost_entity_ids UUID[] DEFAULT NULL
)
RETURNS TABLE (
  id UUID,
  content TEXT,
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
  ORDER BY
    gravity_score DESC NULLS LAST
  LIMIT match_count;
END;
$$ LANGUAGE plpgsql STABLE;
