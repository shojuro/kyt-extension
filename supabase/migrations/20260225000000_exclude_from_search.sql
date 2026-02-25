-- Migration: Add exclude_from_search flag to chat_turns and messages
--
-- WHY: Testing the retrieval pipeline pollutes the database — captured test
-- conversations get stored and then surface in future retrievals, creating a
-- self-reinforcing noise loop.  This column lets us hide test data without
-- deleting it (reversible via KYT_DEBUG.includeConversation).
--
-- OVERHEAD: Partial index only covers TRUE rows (near-zero for normal queries).
-- RPCs filter with (col IS NULL OR col = FALSE), matching the is_question/
-- deflection pattern, so default-NULL rows pass through with zero cost.

-- ============================================================================
-- Step 1: Add columns
-- ============================================================================
ALTER TABLE chat_turns ADD COLUMN IF NOT EXISTS exclude_from_search BOOLEAN DEFAULT FALSE;
ALTER TABLE messages   ADD COLUMN IF NOT EXISTS exclude_from_search BOOLEAN DEFAULT FALSE;

-- ============================================================================
-- Step 2: Partial indexes (only index TRUE rows — near-zero overhead)
-- ============================================================================
CREATE INDEX IF NOT EXISTS idx_chat_turns_exclude
  ON chat_turns(exclude_from_search) WHERE exclude_from_search = TRUE;
CREATE INDEX IF NOT EXISTS idx_messages_exclude
  ON messages(exclude_from_search) WHERE exclude_from_search = TRUE;

-- ============================================================================
-- Step 3a: Recreate match_messages_with_gravity
-- (Latest: 20260224000000 + exclude_from_search filter)
-- ============================================================================
CREATE OR REPLACE FUNCTION match_messages_with_gravity(
  query_embedding vector(1024),
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
    AND (ct.exclude_from_search IS NULL OR ct.exclude_from_search = FALSE)
  ORDER BY
    gravity_score DESC NULLS LAST
  LIMIT match_count;
END;
$$ LANGUAGE plpgsql STABLE;

-- ============================================================================
-- Step 3b: Recreate graph_walk_from_entities
-- (Latest: 20260222100000 + exclude_from_search filter in turn_results CTE)
-- ============================================================================
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
  contextual_content TEXT,
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
      ct.contextual_content,
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
      AND (ct.exclude_from_search IS NULL OR ct.exclude_from_search = FALSE)
  ),

  deduped AS (
    SELECT DISTINCT ON (tr.chat_turn_id)
      tr.chat_turn_id,
      tr.content,
      tr.contextual_content,
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

-- ============================================================================
-- Step 3c: Recreate get_newest_turns_for_entities
-- (Latest: 20260222100000 + exclude_from_search filter in ranked_mentions CTE)
-- ============================================================================
CREATE OR REPLACE FUNCTION get_newest_turns_for_entities(
    p_entity_ids UUID[],
    p_user_id UUID,
    p_exclude_turn_ids UUID[] DEFAULT '{}'::UUID[],
    p_max_per_entity INT DEFAULT 1
)
RETURNS TABLE (
    chat_turn_id UUID,
    content TEXT,
    contextual_content TEXT,
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
            ct.contextual_content,
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
          AND (ct.exclude_from_search IS NULL OR ct.exclude_from_search = FALSE)
    )
    SELECT
        rm.chat_turn_id,
        rm.content,
        rm.contextual_content,
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
    'Excludes deflection turns (deflection >= 0.70) and excluded rows (exclude_from_search = TRUE). '
    'Includes contextual_content for BM25/reranking.';

-- ============================================================================
-- Step 3d: Recreate match_messages_v2
-- (Latest: 20260224000000 + exclude_from_search filter)
-- ============================================================================
CREATE OR REPLACE FUNCTION match_messages_v2(
  query_embedding vector(1024),
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
  embedding vector(1024),
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
    AND (m.exclude_from_search IS NULL OR m.exclude_from_search = FALSE)
  ORDER BY m.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

-- ============================================================================
-- Step 3e: Recreate chat_turns_free view with exclude_from_search filter
-- ============================================================================
DROP VIEW IF EXISTS chat_turns_free;

CREATE VIEW chat_turns_free AS
  SELECT id,
    turn_range,
    conversation_id,
    platform,
    content,
    speakers,
    turn_count,
    start_timestamp,
    end_timestamp,
    topics,
    hypothetical_questions,
    embedding,
    created_at
  FROM chat_turns
  WHERE platform = 'chatgpt' AND user_id = auth.uid()
    AND (exclude_from_search IS NULL OR exclude_from_search = FALSE);

GRANT ALL ON chat_turns_free TO authenticated;
GRANT ALL ON chat_turns_free TO anon;
GRANT ALL ON chat_turns_free TO service_role;
GRANT ALL ON chat_turns_free TO postgres;

-- ============================================================================
-- Step 4: Re-apply statement timeouts (CREATE OR REPLACE removes them)
-- ============================================================================
ALTER FUNCTION match_messages_with_gravity SET statement_timeout = '45s';
ALTER FUNCTION graph_walk_from_entities SET statement_timeout = '30s';
ALTER FUNCTION get_newest_turns_for_entities SET statement_timeout = '15s';

-- ============================================================================
-- Step 5: Re-grant permissions
-- ============================================================================
GRANT EXECUTE ON FUNCTION match_messages_with_gravity(vector(1024), float, int, int, UUID, UUID[]) TO authenticated;
GRANT EXECUTE ON FUNCTION match_messages_with_gravity(vector(1024), float, int, int, UUID, UUID[]) TO anon;
GRANT EXECUTE ON FUNCTION graph_walk_from_entities(UUID[], UUID, INT, INT, INT) TO authenticated;
GRANT EXECUTE ON FUNCTION graph_walk_from_entities(UUID[], UUID, INT, INT, INT) TO anon;
GRANT EXECUTE ON FUNCTION match_messages_v2(vector(1024), float, int, jsonb, bigint) TO authenticated;
GRANT EXECUTE ON FUNCTION match_messages_v2(vector(1024), float, int, jsonb, bigint) TO anon;
