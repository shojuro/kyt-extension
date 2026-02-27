-- Ensure vector type is visible (pgvector lives in extensions schema on Supabase)
SET search_path TO public, extensions;

-- Migration: Add p_profile_id parameter to all 7 search/lookup RPCs
--
-- WHY: The profile_id column was added to tables (20260226100000) but RPCs still
-- filter only by user_id. For forward-compatible multi-profile isolation, each RPC
-- needs an optional p_profile_id param that, when non-NULL, restricts results to
-- rows matching that profile_id.
--
-- MVP: profile_id = user_id (1:1), so callers can pass either or NULL.
-- When NULL, the filter is a no-op (backward-compatible).
--
-- POSTGRES NOTE: Adding a new parameter creates a function overload in PostgreSQL.
-- We must DROP the old signature first to avoid ambiguity errors when callers
-- pass the old number of arguments (both old and new signatures would match).
-- This is safe within a single migration transaction.

-- ============================================================================
-- Step 0: Drop old function signatures to prevent overload ambiguity
-- ============================================================================
DROP FUNCTION IF EXISTS match_messages_with_gravity(vector(1024), float, int, int, UUID, UUID[]);
DROP FUNCTION IF EXISTS match_messages_v2(vector(1024), float, int, jsonb, bigint);
DROP FUNCTION IF EXISTS search_entities_by_embedding(vector(1024), float, int, UUID);
DROP FUNCTION IF EXISTS search_entities_by_text(TEXT, UUID, INT);
DROP FUNCTION IF EXISTS graph_walk_from_entities(UUID[], UUID, INT, INT, INT);
DROP FUNCTION IF EXISTS get_newest_turns_for_entities(UUID[], UUID, UUID[], INT);
DROP FUNCTION IF EXISTS lookup_user_preferences(UUID, TEXT, INT);

-- ============================================================================
-- 1. match_messages_with_gravity
-- Latest: 20260225000000_exclude_from_search.sql
-- ============================================================================
CREATE OR REPLACE FUNCTION match_messages_with_gravity(
  query_embedding vector(1024),
  match_threshold float DEFAULT 0.5,
  match_count int DEFAULT 10,
  exclude_recent_seconds int DEFAULT 120,
  p_user_id UUID DEFAULT NULL,
  boost_entity_ids UUID[] DEFAULT NULL,
  p_profile_id UUID DEFAULT NULL
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
    AND (p_profile_id IS NULL OR ct.profile_id = p_profile_id)
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

-- ============================================================================
-- 2. match_messages_v2
-- Latest: 20260225000000_exclude_from_search.sql
-- ============================================================================
CREATE OR REPLACE FUNCTION match_messages_v2(
  query_embedding vector(1024),
  match_threshold float DEFAULT 0.6,
  match_count int DEFAULT 5,
  filter jsonb DEFAULT '{}'::jsonb,
  min_timestamp bigint DEFAULT 0,
  p_profile_id UUID DEFAULT NULL
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
    AND (p_profile_id IS NULL OR m.profile_id = p_profile_id)
    AND (m.is_question IS NULL OR m.is_question = FALSE)
    AND (m.exclude_from_search IS NULL OR m.exclude_from_search = FALSE)
  ORDER BY m.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

-- ============================================================================
-- 3. search_entities_by_embedding
-- Latest: 20260224000000_reduce_embedding_dims_1024.sql
-- ============================================================================
CREATE OR REPLACE FUNCTION search_entities_by_embedding(
  query_embedding vector(1024),
  match_threshold float DEFAULT 0.8,
  match_count int DEFAULT 5,
  p_user_id UUID DEFAULT NULL,
  p_profile_id UUID DEFAULT NULL
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
    AND (p_profile_id IS NULL OR e.profile_id = p_profile_id)
    AND (1 - (e.embedding <=> query_embedding)) > match_threshold
  ORDER BY e.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

-- ============================================================================
-- 4. search_entities_by_text
-- Latest: 20260216000001_text_entity_search.sql
-- ============================================================================
CREATE OR REPLACE FUNCTION search_entities_by_text(
  p_query_text TEXT,
  p_user_id UUID,
  p_match_count INT DEFAULT 5,
  p_profile_id UUID DEFAULT NULL
)
RETURNS TABLE (
  id UUID,
  entity_text TEXT,
  canonical_name TEXT,
  normalized_name TEXT,
  entity_type TEXT,
  mention_count INT,
  last_seen TIMESTAMPTZ,
  similarity FLOAT
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_query_lower TEXT;
  v_query_underscored TEXT;
BEGIN
  -- Normalize query for matching
  v_query_lower := LOWER(TRIM(p_query_text));
  -- Convert spaces to underscores to match canonical_name format
  v_query_underscored := REPLACE(v_query_lower, ' ', '_');

  RETURN QUERY
  WITH
  -- Strategy 1: Trigram similarity (best for fuzzy matches)
  trgm_matches AS (
    SELECT
      e.id,
      e.entity_text,
      e.canonical_name,
      e.normalized_name,
      e.entity_type::TEXT,
      e.mention_count,
      e.last_seen,
      GREATEST(
        similarity(e.canonical_name, v_query_underscored),
        similarity(e.normalized_name, v_query_underscored),
        similarity(e.entity_text, v_query_lower)
      ) AS sim
    FROM entities e
    WHERE e.user_id = p_user_id
      AND (p_profile_id IS NULL OR e.profile_id = p_profile_id)
      AND (
        similarity(e.canonical_name, v_query_underscored) > 0.15
        OR similarity(e.normalized_name, v_query_underscored) > 0.15
        OR similarity(e.entity_text, v_query_lower) > 0.15
      )
  ),

  -- Strategy 2: ILIKE substring (catches partial matches)
  ilike_matches AS (
    SELECT
      e.id,
      e.entity_text,
      e.canonical_name,
      e.normalized_name,
      e.entity_type::TEXT,
      e.mention_count,
      e.last_seen,
      0.3::FLOAT AS sim  -- Fixed score for substring matches
    FROM entities e
    WHERE e.user_id = p_user_id
      AND (p_profile_id IS NULL OR e.profile_id = p_profile_id)
      AND e.id NOT IN (SELECT tm.id FROM trgm_matches tm)
      AND (
        e.canonical_name ILIKE '%' || v_query_underscored || '%'
        OR e.normalized_name ILIKE '%' || v_query_underscored || '%'
        OR e.entity_text ILIKE '%' || v_query_lower || '%'
      )
  ),

  -- Strategy 3: Keyword splitting (matches individual words against canonical_name tokens)
  -- Split query into words, match each against canonical_name
  keyword_matches AS (
    SELECT
      e.id,
      e.entity_text,
      e.canonical_name,
      e.normalized_name,
      e.entity_type::TEXT,
      e.mention_count,
      e.last_seen,
      -- Score = fraction of query keywords found in canonical_name
      (
        SELECT COUNT(*)::FLOAT / GREATEST(array_length(string_to_array(v_query_lower, ' '), 1), 1)
        FROM unnest(string_to_array(v_query_lower, ' ')) AS kw
        WHERE LENGTH(kw) >= 3
          AND e.canonical_name ILIKE '%' || REPLACE(kw, ' ', '_') || '%'
      ) * 0.5 AS sim  -- Scale keyword matches to max 0.5
    FROM entities e
    WHERE e.user_id = p_user_id
      AND (p_profile_id IS NULL OR e.profile_id = p_profile_id)
      AND e.id NOT IN (SELECT tm.id FROM trgm_matches tm)
      AND e.id NOT IN (SELECT im.id FROM ilike_matches im)
      AND EXISTS (
        SELECT 1
        FROM unnest(string_to_array(v_query_lower, ' ')) AS kw
        WHERE LENGTH(kw) >= 3
          AND e.canonical_name ILIKE '%' || REPLACE(kw, ' ', '_') || '%'
      )
  ),

  -- Combine all strategies
  all_matches AS (
    SELECT * FROM trgm_matches
    UNION ALL
    SELECT * FROM ilike_matches
    UNION ALL
    SELECT * FROM keyword_matches
  ),

  -- Deduplicate by entity id, keep highest similarity
  deduped AS (
    SELECT DISTINCT ON (am.id)
      am.id,
      am.entity_text,
      am.canonical_name,
      am.normalized_name,
      am.entity_type,
      am.mention_count,
      am.last_seen,
      am.sim AS similarity
    FROM all_matches am
    ORDER BY am.id, am.sim DESC
  )

  SELECT d.id, d.entity_text, d.canonical_name, d.normalized_name,
         d.entity_type, d.mention_count, d.last_seen, d.similarity
  FROM deduped d
  ORDER BY d.similarity DESC, d.mention_count DESC
  LIMIT p_match_count;
END;
$$;

-- ============================================================================
-- 5. graph_walk_from_entities
-- Latest: 20260225000000_exclude_from_search.sql
-- ============================================================================
CREATE OR REPLACE FUNCTION graph_walk_from_entities(
  p_entity_ids UUID[],
  p_user_id UUID,
  p_max_results INT DEFAULT 10,
  p_max_depth INT DEFAULT 1,
  p_max_intermediate INT DEFAULT 20,
  p_profile_id UUID DEFAULT NULL
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
      AND (p_profile_id IS NULL OR ct.profile_id = p_profile_id)
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

ALTER FUNCTION graph_walk_from_entities SET statement_timeout = '30s';

-- ============================================================================
-- 6. get_newest_turns_for_entities
-- Latest: 20260225000000_exclude_from_search.sql
-- ============================================================================
CREATE OR REPLACE FUNCTION get_newest_turns_for_entities(
    p_entity_ids UUID[],
    p_user_id UUID,
    p_exclude_turn_ids UUID[] DEFAULT '{}'::UUID[],
    p_max_per_entity INT DEFAULT 1,
    p_profile_id UUID DEFAULT NULL
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
          AND (p_profile_id IS NULL OR ct.profile_id = p_profile_id)
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

ALTER FUNCTION get_newest_turns_for_entities SET statement_timeout = '15s';

-- ============================================================================
-- 7. lookup_user_preferences
-- Latest: 20260221200002_preference_word_boundary_matching.sql
-- ============================================================================
CREATE OR REPLACE FUNCTION lookup_user_preferences(
    p_user_id UUID,
    p_category TEXT,
    p_limit INT DEFAULT 10,
    p_profile_id UUID DEFAULT NULL
)
RETURNS TABLE (
    id UUID,
    category TEXT,
    value TEXT,
    sentiment TEXT,
    confidence FLOAT,
    source_turn_id UUID,
    source_content TEXT,
    created_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    RETURN QUERY
    SELECT DISTINCT ON (up.category, up.sentiment)
        up.id,
        up.category,
        up.value,
        up.sentiment,
        up.confidence,
        up.source_turn_id,
        ct.content AS source_content,
        up.created_at,
        up.updated_at
    FROM user_preferences up
    LEFT JOIN chat_turns ct ON ct.id = up.source_turn_id
    WHERE up.user_id = p_user_id
      AND (p_profile_id IS NULL OR up.profile_id = p_profile_id)
      AND (
          up.category ~* ('\m' || p_category || '\M')
          OR up.value ~* ('\m' || p_category || '\M')
      )
    ORDER BY up.category, up.sentiment, up.updated_at DESC
    LIMIT p_limit;
END;
$$;

-- ============================================================================
-- Re-grant permissions (CREATE OR REPLACE preserves grants for same signature,
-- but new overloads need explicit grants)
-- ============================================================================
GRANT EXECUTE ON FUNCTION match_messages_with_gravity(vector(1024), float, int, int, UUID, UUID[], UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION match_messages_with_gravity(vector(1024), float, int, int, UUID, UUID[], UUID) TO anon;
GRANT EXECUTE ON FUNCTION match_messages_v2(vector(1024), float, int, jsonb, bigint, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION match_messages_v2(vector(1024), float, int, jsonb, bigint, UUID) TO anon;
GRANT EXECUTE ON FUNCTION search_entities_by_embedding(vector(1024), float, int, UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION search_entities_by_embedding(vector(1024), float, int, UUID, UUID) TO anon;
GRANT EXECUTE ON FUNCTION search_entities_by_text(TEXT, UUID, INT, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION search_entities_by_text(TEXT, UUID, INT, UUID) TO anon;
GRANT EXECUTE ON FUNCTION graph_walk_from_entities(UUID[], UUID, INT, INT, INT, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION graph_walk_from_entities(UUID[], UUID, INT, INT, INT, UUID) TO anon;
GRANT EXECUTE ON FUNCTION get_newest_turns_for_entities(UUID[], UUID, UUID[], INT, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION get_newest_turns_for_entities(UUID[], UUID, UUID[], INT, UUID) TO anon;
GRANT EXECUTE ON FUNCTION lookup_user_preferences(UUID, TEXT, INT, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION lookup_user_preferences(UUID, TEXT, INT, UUID) TO anon;
