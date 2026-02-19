-- Migration: Add deflection filter to chat_turns RPCs
-- Purpose: Exclude chat_turns with high deflection scores (>= 0.70) from all
-- retrieval paths. This prevents "I don't have a record of..." responses from
-- crowding out actual preferences/facts in search results.

-- 1. Update match_messages_with_gravity to exclude deflections
DROP FUNCTION IF EXISTS match_messages_with_gravity(vector(4096), float, int, int, UUID, UUID[]);

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
    AND (ct.is_question IS NULL OR ct.is_question = FALSE)
    AND (ct.deflection IS NULL OR ct.deflection < 0.70)
  ORDER BY
    gravity_score DESC NULLS LAST
  LIMIT match_count;
END;
$$ LANGUAGE plpgsql STABLE;

-- 2. Update graph_walk_from_entities to exclude deflections
DROP FUNCTION IF EXISTS graph_walk_from_entities(UUID[], UUID, INT, INT, INT);

CREATE OR REPLACE FUNCTION graph_walk_from_entities(
  p_entity_ids UUID[],
  p_user_id UUID,
  p_max_results INT DEFAULT 10,
  p_max_depth INT DEFAULT 1,
  p_max_intermediate INT DEFAULT 20
)
RETURNS TABLE (
  chat_turn_id UUID,
  content TEXT,
  conversation_id TEXT,
  platform TEXT,
  start_timestamp BIGINT,
  traversal_depth INT,
  relationship_strength FLOAT,
  connected_entity_text TEXT,
  connected_entity_type TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN QUERY
  WITH RECURSIVE
  entity_walk(entity_id, depth, cumulative_strength) AS (
    SELECT unnest(p_entity_ids), 0, 1.0::FLOAT

    UNION ALL

    SELECT
      CASE
        WHEN er.entity_a_id = ew.entity_id THEN er.entity_b_id
        ELSE er.entity_a_id
      END,
      ew.depth + 1,
      ew.cumulative_strength
        * er.relationship_strength
        * temporal_decay_factor(er.last_seen)
    FROM entity_walk ew
    JOIN entity_relationships er
      ON er.user_id = p_user_id
      AND (er.entity_a_id = ew.entity_id OR er.entity_b_id = ew.entity_id)
    WHERE ew.depth < p_max_depth
      AND CASE
        WHEN er.entity_a_id = ew.entity_id THEN er.entity_b_id
        ELSE er.entity_a_id
      END != ALL(p_entity_ids)
  ),

  best_entities AS (
    SELECT DISTINCT ON (ew.entity_id)
      ew.entity_id,
      ew.depth,
      ew.cumulative_strength
    FROM entity_walk ew
    ORDER BY ew.entity_id, ew.cumulative_strength DESC
    LIMIT p_max_intermediate
  ),

  turn_results AS (
    SELECT
      ct.id AS chat_turn_id,
      ct.content,
      ct.conversation_id,
      ct.platform,
      ct.start_timestamp,
      be.depth AS traversal_depth,
      be.cumulative_strength AS relationship_strength,
      e.entity_text AS connected_entity_text,
      e.entity_type AS connected_entity_type
    FROM best_entities be
    JOIN entity_mentions em ON em.entity_id = be.entity_id
    JOIN chat_turns ct ON ct.id = em.chat_turn_id
    JOIN entities e ON e.id = be.entity_id
    WHERE ct.user_id = p_user_id
      AND (ct.is_question IS NULL OR ct.is_question = FALSE)
      AND (ct.deflection IS NULL OR ct.deflection < 0.70)
  ),

  deduped AS (
    SELECT DISTINCT ON (tr.chat_turn_id)
      tr.chat_turn_id,
      tr.content,
      tr.conversation_id,
      tr.platform,
      tr.start_timestamp,
      tr.traversal_depth,
      tr.relationship_strength,
      tr.connected_entity_text,
      tr.connected_entity_type
    FROM turn_results tr
    ORDER BY tr.chat_turn_id, tr.relationship_strength DESC, tr.traversal_depth ASC
  )

  SELECT * FROM deduped
  ORDER BY deduped.relationship_strength DESC
  LIMIT p_max_results;
END;
$$;

GRANT EXECUTE ON FUNCTION graph_walk_from_entities(UUID[], UUID, INT, INT, INT) TO authenticated;
GRANT EXECUTE ON FUNCTION graph_walk_from_entities(UUID[], UUID, INT, INT, INT) TO anon;

-- 3. Update get_newest_turns_for_entities to exclude deflections
DROP FUNCTION IF EXISTS get_newest_turns_for_entities(UUID[], UUID, UUID[], INT);

CREATE OR REPLACE FUNCTION get_newest_turns_for_entities(
    p_entity_ids UUID[],
    p_user_id UUID,
    p_exclude_turn_ids UUID[] DEFAULT '{}'::UUID[],
    p_max_per_entity INT DEFAULT 1
)
RETURNS TABLE (
    chat_turn_id UUID,
    content TEXT,
    created_at TIMESTAMP,
    entity_id UUID,
    canonical_name TEXT,
    entity_type TEXT
)
LANGUAGE plpgsql STABLE
AS $$
BEGIN
    RETURN QUERY
    WITH ranked_mentions AS (
        SELECT
            em.chat_turn_id,
            ct.content,
            ct.created_at,
            em.entity_id,
            e.canonical_name,
            e.entity_type,
            ROW_NUMBER() OVER (
                PARTITION BY em.entity_id
                ORDER BY ct.created_at DESC
            ) AS rn
        FROM entity_mentions em
        JOIN chat_turns ct ON ct.id = em.chat_turn_id
        JOIN entities e ON e.id = em.entity_id
        WHERE em.entity_id = ANY(p_entity_ids)
          AND ct.user_id = p_user_id
          AND em.chat_turn_id != ALL(p_exclude_turn_ids)
          AND (ct.is_question IS NULL OR ct.is_question = FALSE)
          AND (ct.deflection IS NULL OR ct.deflection < 0.70)
    )
    SELECT
        rm.chat_turn_id,
        rm.content,
        rm.created_at,
        rm.entity_id,
        rm.canonical_name,
        rm.entity_type
    FROM ranked_mentions rm
    WHERE rm.rn <= p_max_per_entity;
END;
$$;

COMMENT ON FUNCTION get_newest_turns_for_entities IS
    'Entity timeline guarantee: returns the most recent chat_turn per entity that is not already in the candidate set. '
    'Prevents semantic search bias toward long/rich content from hiding short factual corrections. '
    'Excludes deflection turns (deflection >= 0.70).';
