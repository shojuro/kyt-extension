-- Supersession filter for entity-based retrieval RPCs
-- ---------------------------------------------------------------------------
-- Excludes superseded entities (entities.superseded_by IS NOT NULL) from the
-- three entity-driven retrieval paths so a stale fact that has been replaced by
-- a newer one stops resurfacing. The pure chat_turns vector search
-- (match_messages_with_gravity) does NOT join entities and is intentionally left
-- unchanged.
--
-- Bodies are reproduced verbatim from the live definitions (pg_get_functiondef)
-- with a single added predicate `AND e.superseded_by IS NULL`. CREATE OR REPLACE
-- preserves existing privileges and ownership.
--
-- NOTE: as of this migration 0 of ~16.7k entities are superseded, so this is a
-- strict no-op against current data — it only takes effect once supersession is
-- populated (e.g. by backfill_entities). Safe to deploy; cannot regress.

-- ---------------------------------------------------------------------------
-- 1. search_entities_by_text  (+ superseded_by filter in all 3 strategy CTEs)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.search_entities_by_text(
  p_query_text text,
  p_user_id uuid,
  p_match_count integer DEFAULT 5,
  p_profile_id uuid DEFAULT NULL::uuid,
  p_project_id uuid DEFAULT NULL::uuid
)
RETURNS TABLE(id uuid, entity_text text, canonical_name text, normalized_name text, entity_type text, mention_count integer, last_seen timestamp with time zone, similarity double precision)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_query_lower TEXT;
  v_query_underscored TEXT;
BEGIN
  v_query_lower := LOWER(TRIM(p_query_text));
  v_query_underscored := REPLACE(v_query_lower, ' ', '_');

  RETURN QUERY
  WITH
  trgm_matches AS (
    SELECT e.id, e.entity_text, e.canonical_name, e.normalized_name,
      e.entity_type::TEXT, e.mention_count, e.last_seen,
      GREATEST(similarity(e.canonical_name, v_query_underscored),
        similarity(e.normalized_name, v_query_underscored),
        similarity(e.entity_text, v_query_lower)) AS sim
    FROM entities e
    WHERE e.user_id = p_user_id
      AND (p_profile_id IS NULL OR e.profile_id = p_profile_id)
      AND (p_project_id IS NULL OR e.project_id = p_project_id)
      AND is_vault_excluded(p_project_id, e.project_id)
      AND e.superseded_by IS NULL
      AND (similarity(e.canonical_name, v_query_underscored) > 0.15
        OR similarity(e.normalized_name, v_query_underscored) > 0.15
        OR similarity(e.entity_text, v_query_lower) > 0.15)
  ),
  ilike_matches AS (
    SELECT e.id, e.entity_text, e.canonical_name, e.normalized_name,
      e.entity_type::TEXT, e.mention_count, e.last_seen, 0.3::FLOAT AS sim
    FROM entities e
    WHERE e.user_id = p_user_id
      AND (p_profile_id IS NULL OR e.profile_id = p_profile_id)
      AND (p_project_id IS NULL OR e.project_id = p_project_id)
      AND is_vault_excluded(p_project_id, e.project_id)
      AND e.superseded_by IS NULL
      AND e.id NOT IN (SELECT tm.id FROM trgm_matches tm)
      AND (e.canonical_name ILIKE '%' || v_query_underscored || '%'
        OR e.normalized_name ILIKE '%' || v_query_underscored || '%'
        OR e.entity_text ILIKE '%' || v_query_lower || '%')
  ),
  keyword_matches AS (
    SELECT e.id, e.entity_text, e.canonical_name, e.normalized_name,
      e.entity_type::TEXT, e.mention_count, e.last_seen,
      (SELECT COUNT(*)::FLOAT / GREATEST(array_length(string_to_array(v_query_lower, ' '), 1), 1)
        FROM unnest(string_to_array(v_query_lower, ' ')) AS kw
        WHERE LENGTH(kw) >= 3 AND e.canonical_name ILIKE '%' || REPLACE(kw, ' ', '_') || '%'
      ) * 0.5 AS sim
    FROM entities e
    WHERE e.user_id = p_user_id
      AND (p_profile_id IS NULL OR e.profile_id = p_profile_id)
      AND (p_project_id IS NULL OR e.project_id = p_project_id)
      AND is_vault_excluded(p_project_id, e.project_id)
      AND e.superseded_by IS NULL
      AND e.id NOT IN (SELECT tm.id FROM trgm_matches tm)
      AND e.id NOT IN (SELECT im.id FROM ilike_matches im)
      AND EXISTS (SELECT 1 FROM unnest(string_to_array(v_query_lower, ' ')) AS kw
        WHERE LENGTH(kw) >= 3 AND e.canonical_name ILIKE '%' || REPLACE(kw, ' ', '_') || '%')
  ),
  all_matches AS (
    SELECT * FROM trgm_matches UNION ALL SELECT * FROM ilike_matches UNION ALL SELECT * FROM keyword_matches
  ),
  deduped AS (
    SELECT DISTINCT ON (am.id) am.id, am.entity_text, am.canonical_name,
      am.normalized_name, am.entity_type, am.mention_count, am.last_seen, am.sim AS similarity
    FROM all_matches am ORDER BY am.id, am.sim DESC
  )
  SELECT d.id, d.entity_text, d.canonical_name, d.normalized_name,
    d.entity_type, d.mention_count, d.last_seen, d.similarity
  FROM deduped d ORDER BY d.similarity DESC, d.mention_count DESC
  LIMIT p_match_count;
END;
$$;

-- ---------------------------------------------------------------------------
-- 2. graph_walk_from_entities  (+ superseded_by filter on connected entity e)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.graph_walk_from_entities(
  p_entity_ids uuid[],
  p_user_id uuid,
  p_max_results integer DEFAULT 10,
  p_max_depth integer DEFAULT 1,
  p_max_intermediate integer DEFAULT 20,
  p_profile_id uuid DEFAULT NULL::uuid,
  p_project_id uuid DEFAULT NULL::uuid
)
RETURNS TABLE(chat_turn_id uuid, content text, contextual_content text, conversation_id text, platform text, start_timestamp bigint, traversal_depth integer, relationship_strength double precision, connected_entity_text text, connected_entity_type text)
LANGUAGE plpgsql
SECURITY DEFINER
SET statement_timeout TO '30s'
AS $$
BEGIN
  RETURN QUERY
  WITH RECURSIVE
  entity_walk(entity_id, depth, cumulative_strength) AS (
    SELECT unnest(p_entity_ids), 0, 1.0::FLOAT
    UNION ALL
    SELECT
      CASE WHEN er.entity_a_id = ew.entity_id THEN er.entity_b_id ELSE er.entity_a_id END,
      ew.depth + 1,
      ew.cumulative_strength * er.relationship_strength * temporal_decay_factor(er.last_seen)
    FROM entity_walk ew
    JOIN entity_relationships er ON er.user_id = p_user_id
      AND (er.entity_a_id = ew.entity_id OR er.entity_b_id = ew.entity_id)
    WHERE ew.depth < p_max_depth
      AND CASE WHEN er.entity_a_id = ew.entity_id THEN er.entity_b_id ELSE er.entity_a_id END != ALL(p_entity_ids)
  ),
  best_entities AS (
    SELECT DISTINCT ON (ew.entity_id) ew.entity_id, ew.depth, ew.cumulative_strength
    FROM entity_walk ew ORDER BY ew.entity_id, ew.cumulative_strength DESC LIMIT p_max_intermediate
  ),
  turn_results AS (
    SELECT ct.id AS chat_turn_id, ct.content, ct.contextual_content,
      ct.conversation_id, ct.platform, ct.start_timestamp,
      be.depth AS traversal_depth, be.cumulative_strength AS relationship_strength,
      e.entity_text AS connected_entity_text, e.entity_type AS connected_entity_type
    FROM best_entities be
    JOIN entity_mentions em ON em.entity_id = be.entity_id
    JOIN chat_turns ct ON ct.id = em.chat_turn_id
    JOIN entities e ON e.id = be.entity_id
    WHERE ct.user_id = p_user_id
      AND (p_profile_id IS NULL OR ct.profile_id = p_profile_id)
      AND (p_project_id IS NULL OR ct.project_id = p_project_id)
      AND is_vault_excluded(p_project_id, ct.project_id)
      AND e.superseded_by IS NULL
      AND (ct.is_question IS NULL OR ct.is_question = FALSE)
      AND (ct.deflection IS NULL OR ct.deflection < 0.70)
      AND (ct.exclude_from_search IS NULL OR ct.exclude_from_search = FALSE)
  ),
  deduped AS (
    SELECT DISTINCT ON (tr.chat_turn_id) tr.chat_turn_id, tr.content,
      tr.contextual_content, tr.conversation_id, tr.platform, tr.start_timestamp,
      tr.traversal_depth, tr.relationship_strength, tr.connected_entity_text, tr.connected_entity_type
    FROM turn_results tr ORDER BY tr.chat_turn_id, tr.relationship_strength DESC, tr.traversal_depth ASC
  )
  SELECT * FROM deduped ORDER BY deduped.relationship_strength DESC LIMIT p_max_results;
END;
$$;

-- ---------------------------------------------------------------------------
-- 3. get_newest_turns_for_entities  (+ superseded_by filter on entity e)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_newest_turns_for_entities(
  p_entity_ids uuid[],
  p_user_id uuid,
  p_exclude_turn_ids uuid[] DEFAULT '{}'::uuid[],
  p_max_per_entity integer DEFAULT 1,
  p_profile_id uuid DEFAULT NULL::uuid,
  p_project_id uuid DEFAULT NULL::uuid
)
RETURNS TABLE(chat_turn_id uuid, content text, contextual_content text, created_at timestamp without time zone, entity_id uuid, canonical_name text, entity_type text)
LANGUAGE plpgsql
STABLE
SET statement_timeout TO '15s'
AS $$
BEGIN
    RETURN QUERY
    WITH ranked_mentions AS (
        SELECT em.chat_turn_id, ct.content, ct.contextual_content, ct.created_at,
            em.entity_id, e.canonical_name, e.entity_type,
            ROW_NUMBER() OVER (PARTITION BY em.entity_id ORDER BY ct.created_at DESC) AS rn
        FROM entity_mentions em
        JOIN chat_turns ct ON ct.id = em.chat_turn_id
        JOIN entities e ON e.id = em.entity_id
        WHERE em.entity_id = ANY(p_entity_ids)
          AND ct.user_id = p_user_id
          AND (p_profile_id IS NULL OR ct.profile_id = p_profile_id)
          AND (p_project_id IS NULL OR ct.project_id = p_project_id)
          AND is_vault_excluded(p_project_id, ct.project_id)
          AND e.superseded_by IS NULL
          AND em.chat_turn_id != ALL(p_exclude_turn_ids)
          AND (ct.is_question IS NULL OR ct.is_question = FALSE)
          AND (ct.deflection IS NULL OR ct.deflection < 0.70)
          AND (ct.exclude_from_search IS NULL OR ct.exclude_from_search = FALSE)
    )
    SELECT rm.chat_turn_id, rm.content, rm.contextual_content,
        rm.created_at, rm.entity_id, rm.canonical_name, rm.entity_type
    FROM ranked_mentions rm WHERE rm.rn <= p_max_per_entity;
END;
$$;
