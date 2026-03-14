-- Migration: Projects & Vault feature
--
-- Adds project scoping to K.Y.T. memory. Conversations, chat_turns, and entities
-- can be assigned to a project. Projects marked is_vault=TRUE are excluded from
-- general search unless the caller explicitly targets that project.
--
-- All 7 search/lookup RPCs are dropped and recreated with a new p_project_id
-- parameter. Vault exclusion logic: when p_project_id IS NULL, rows belonging
-- to vault projects are hidden. When p_project_id is specified, only that
-- project's rows are returned (vault or not).

SET search_path TO public, extensions;

-- ============================================================================
-- 1. Projects table (must be created before is_vault_excluded which references it)
-- ============================================================================
CREATE TABLE projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id),
  name TEXT NOT NULL,
  description TEXT,
  is_vault BOOLEAN NOT NULL DEFAULT FALSE,
  is_archived BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, name)
);

ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
CREATE POLICY projects_user_policy ON projects FOR ALL USING (auth.uid() = user_id);
CREATE INDEX idx_projects_user_id ON projects(user_id);

-- ============================================================================
-- 2. Helper function: is_vault_excluded (after projects table exists)
-- ============================================================================
CREATE OR REPLACE FUNCTION is_vault_excluded(p_project_id UUID, row_project_id UUID)
RETURNS BOOLEAN AS $$
  SELECT p_project_id IS NOT NULL
    OR row_project_id IS NULL
    OR NOT EXISTS (SELECT 1 FROM projects WHERE id = row_project_id AND is_vault = TRUE);
$$ LANGUAGE sql STABLE;

-- ============================================================================
-- 3. Add project_id to chat_turns, entities, conversations
-- ============================================================================
ALTER TABLE chat_turns ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES projects(id);
ALTER TABLE entities ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES projects(id);
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES projects(id);
ALTER TABLE messages ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES projects(id);

CREATE INDEX IF NOT EXISTS idx_chat_turns_project_id ON chat_turns(project_id);
CREATE INDEX IF NOT EXISTS idx_entities_project_id ON entities(project_id);
CREATE INDEX IF NOT EXISTS idx_conversations_project_id ON conversations(project_id);
CREATE INDEX IF NOT EXISTS idx_messages_project_id ON messages(project_id);

-- ============================================================================
-- 4. Drop old RPC signatures (must match current production signatures exactly)
-- ============================================================================
DROP FUNCTION IF EXISTS match_messages_with_gravity(vector(1024), float, int, int, UUID, UUID[], UUID, TEXT);
DROP FUNCTION IF EXISTS match_messages_v2(vector(1024), float, int, jsonb, bigint, UUID);
DROP FUNCTION IF EXISTS search_entities_by_embedding(vector(1024), float, int, UUID, UUID);
DROP FUNCTION IF EXISTS search_entities_by_text(TEXT, UUID, INT, UUID);
DROP FUNCTION IF EXISTS graph_walk_from_entities(UUID[], UUID, INT, INT, INT, UUID);
DROP FUNCTION IF EXISTS get_newest_turns_for_entities(UUID[], UUID, UUID[], INT, UUID);
DROP FUNCTION IF EXISTS lookup_user_preferences(UUID, TEXT, INT, UUID);

-- ============================================================================
-- 5. Recreate RPCs with p_project_id parameter
-- ============================================================================

-- --------------------------------------------------------------------------
-- 5a. match_messages_with_gravity
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION match_messages_with_gravity(
  query_embedding vector(1024),
  match_threshold float DEFAULT 0.5,
  match_count int DEFAULT 10,
  exclude_recent_seconds int DEFAULT 120,
  p_user_id UUID DEFAULT NULL,
  boost_entity_ids UUID[] DEFAULT NULL,
  p_profile_id UUID DEFAULT NULL,
  p_platform TEXT DEFAULT NULL,
  p_project_id UUID DEFAULT NULL
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
    AND (p_project_id IS NULL OR ct.project_id = p_project_id)
    AND is_vault_excluded(p_project_id, ct.project_id)
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

-- --------------------------------------------------------------------------
-- 5b. match_messages_v2
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION match_messages_v2(
  query_embedding vector(1024),
  match_threshold float DEFAULT 0.6,
  match_count int DEFAULT 5,
  filter jsonb DEFAULT '{}'::jsonb,
  min_timestamp bigint DEFAULT 0,
  p_profile_id UUID DEFAULT NULL,
  p_project_id UUID DEFAULT NULL
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
    AND (p_project_id IS NULL OR m.project_id = p_project_id)
    AND is_vault_excluded(p_project_id, m.project_id)
    AND (m.is_question IS NULL OR m.is_question = FALSE)
    AND (m.exclude_from_search IS NULL OR m.exclude_from_search = FALSE)
  ORDER BY m.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

-- --------------------------------------------------------------------------
-- 5c. search_entities_by_embedding
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION search_entities_by_embedding(
  query_embedding vector(1024),
  match_threshold float DEFAULT 0.8,
  match_count int DEFAULT 5,
  p_user_id UUID DEFAULT NULL,
  p_profile_id UUID DEFAULT NULL,
  p_project_id UUID DEFAULT NULL
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
    AND (p_project_id IS NULL OR e.project_id = p_project_id)
    AND is_vault_excluded(p_project_id, e.project_id)
    AND (1 - (e.embedding <=> query_embedding)) > match_threshold
  ORDER BY e.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

-- --------------------------------------------------------------------------
-- 5d. search_entities_by_text
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION search_entities_by_text(
  p_query_text TEXT,
  p_user_id UUID,
  p_match_count INT DEFAULT 5,
  p_profile_id UUID DEFAULT NULL,
  p_project_id UUID DEFAULT NULL
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
      AND (p_project_id IS NULL OR e.project_id = p_project_id)
      AND is_vault_excluded(p_project_id, e.project_id)
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
      AND (p_project_id IS NULL OR e.project_id = p_project_id)
      AND is_vault_excluded(p_project_id, e.project_id)
      AND e.id NOT IN (SELECT tm.id FROM trgm_matches tm)
      AND (
        e.canonical_name ILIKE '%' || v_query_underscored || '%'
        OR e.normalized_name ILIKE '%' || v_query_underscored || '%'
        OR e.entity_text ILIKE '%' || v_query_lower || '%'
      )
  ),

  -- Strategy 3: Keyword splitting (matches individual words against canonical_name tokens)
  keyword_matches AS (
    SELECT
      e.id,
      e.entity_text,
      e.canonical_name,
      e.normalized_name,
      e.entity_type::TEXT,
      e.mention_count,
      e.last_seen,
      (
        SELECT COUNT(*)::FLOAT / GREATEST(array_length(string_to_array(v_query_lower, ' '), 1), 1)
        FROM unnest(string_to_array(v_query_lower, ' ')) AS kw
        WHERE LENGTH(kw) >= 3
          AND e.canonical_name ILIKE '%' || REPLACE(kw, ' ', '_') || '%'
      ) * 0.5 AS sim
    FROM entities e
    WHERE e.user_id = p_user_id
      AND (p_profile_id IS NULL OR e.profile_id = p_profile_id)
      AND (p_project_id IS NULL OR e.project_id = p_project_id)
      AND is_vault_excluded(p_project_id, e.project_id)
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

-- --------------------------------------------------------------------------
-- 5e. graph_walk_from_entities
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION graph_walk_from_entities(
  p_entity_ids UUID[],
  p_user_id UUID,
  p_max_results INT DEFAULT 10,
  p_max_depth INT DEFAULT 1,
  p_max_intermediate INT DEFAULT 20,
  p_profile_id UUID DEFAULT NULL,
  p_project_id UUID DEFAULT NULL
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
      AND (p_project_id IS NULL OR ct.project_id = p_project_id)
      AND is_vault_excluded(p_project_id, ct.project_id)
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

-- --------------------------------------------------------------------------
-- 5f. get_newest_turns_for_entities
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION get_newest_turns_for_entities(
    p_entity_ids UUID[],
    p_user_id UUID,
    p_exclude_turn_ids UUID[] DEFAULT '{}'::UUID[],
    p_max_per_entity INT DEFAULT 1,
    p_profile_id UUID DEFAULT NULL,
    p_project_id UUID DEFAULT NULL
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
          AND (p_project_id IS NULL OR ct.project_id = p_project_id)
          AND is_vault_excluded(p_project_id, ct.project_id)
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

-- --------------------------------------------------------------------------
-- 5g. lookup_user_preferences
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION lookup_user_preferences(
    p_user_id UUID,
    p_category TEXT,
    p_limit INT DEFAULT 10,
    p_profile_id UUID DEFAULT NULL,
    p_project_id UUID DEFAULT NULL
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
      AND (p_project_id IS NULL OR ct.project_id = p_project_id)
      AND is_vault_excluded(p_project_id, ct.project_id)
      AND (
          up.category ~* ('\m' || p_category || '\M')
          OR up.value ~* ('\m' || p_category || '\M')
      )
    ORDER BY up.category, up.sentiment, up.updated_at DESC
    LIMIT p_limit;
END;
$$;

-- ============================================================================
-- 6. New helper RPCs
-- ============================================================================

-- --------------------------------------------------------------------------
-- 6a. get_project_summary
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION get_project_summary(
    p_project_id UUID,
    p_user_id UUID,
    p_limit INT DEFAULT 50
)
RETURNS TABLE (
    id UUID,
    content TEXT,
    created_at TIMESTAMPTZ,
    platform TEXT,
    speakers TEXT[]
)
LANGUAGE plpgsql STABLE
SECURITY DEFINER
AS $$
BEGIN
    -- Validate project ownership
    IF NOT EXISTS (
        SELECT 1 FROM projects
        WHERE projects.id = p_project_id AND projects.user_id = p_user_id
    ) THEN
        RAISE EXCEPTION 'Project not found or not owned by user';
    END IF;

    RETURN QUERY
    SELECT
        ct.id,
        ct.content,
        ct.created_at::TIMESTAMPTZ,
        ct.platform,
        ct.speakers
    FROM chat_turns ct
    WHERE ct.project_id = p_project_id
      AND ct.user_id = p_user_id
    ORDER BY ct.created_at DESC
    LIMIT p_limit;
END;
$$;

-- --------------------------------------------------------------------------
-- 6b. assign_turns_to_project
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION assign_turns_to_project(
    p_turn_ids UUID[],
    p_project_id UUID,
    p_user_id UUID
)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_updated INT;
BEGIN
    -- Validate project ownership (NULL p_project_id = unassign, always allowed)
    IF p_project_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM projects
        WHERE projects.id = p_project_id AND projects.user_id = p_user_id
    ) THEN
        RAISE EXCEPTION 'Project not found or not owned by user';
    END IF;

    UPDATE chat_turns
    SET project_id = p_project_id
    WHERE id = ANY(p_turn_ids)
      AND user_id = p_user_id;

    GET DIAGNOSTICS v_updated = ROW_COUNT;
    RETURN v_updated;
END;
$$;

-- ============================================================================
-- 7. Grant permissions
-- ============================================================================

-- RPCs with new signatures
GRANT EXECUTE ON FUNCTION match_messages_with_gravity(vector(1024), float, int, int, UUID, UUID[], UUID, TEXT, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION match_messages_with_gravity(vector(1024), float, int, int, UUID, UUID[], UUID, TEXT, UUID) TO anon;
GRANT EXECUTE ON FUNCTION match_messages_v2(vector(1024), float, int, jsonb, bigint, UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION match_messages_v2(vector(1024), float, int, jsonb, bigint, UUID, UUID) TO anon;
GRANT EXECUTE ON FUNCTION search_entities_by_embedding(vector(1024), float, int, UUID, UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION search_entities_by_embedding(vector(1024), float, int, UUID, UUID, UUID) TO anon;
GRANT EXECUTE ON FUNCTION search_entities_by_text(TEXT, UUID, INT, UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION search_entities_by_text(TEXT, UUID, INT, UUID, UUID) TO anon;
GRANT EXECUTE ON FUNCTION graph_walk_from_entities(UUID[], UUID, INT, INT, INT, UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION graph_walk_from_entities(UUID[], UUID, INT, INT, INT, UUID, UUID) TO anon;
GRANT EXECUTE ON FUNCTION get_newest_turns_for_entities(UUID[], UUID, UUID[], INT, UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION get_newest_turns_for_entities(UUID[], UUID, UUID[], INT, UUID, UUID) TO anon;
GRANT EXECUTE ON FUNCTION lookup_user_preferences(UUID, TEXT, INT, UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION lookup_user_preferences(UUID, TEXT, INT, UUID, UUID) TO anon;

-- New helper RPCs
GRANT EXECUTE ON FUNCTION get_project_summary(UUID, UUID, INT) TO authenticated;
GRANT EXECUTE ON FUNCTION assign_turns_to_project(UUID[], UUID, UUID) TO authenticated;

-- Helper function
GRANT EXECUTE ON FUNCTION is_vault_excluded(UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION is_vault_excluded(UUID, UUID) TO anon;
