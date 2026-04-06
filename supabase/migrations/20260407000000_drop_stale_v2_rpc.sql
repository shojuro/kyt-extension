-- Fix query_memory empty results: 3 issues resolved in this migration.
--
-- 1. Drop stale match_messages_with_gravity_v2 (missing vault exclusion).
-- 2. Recreate match_messages_with_gravity with candidate pool optimization
--    (prevents statement timeout on 21K+ rows) + vault exclusion.
-- 3. Add p_candidate_pool parameter for fast pre-filtering via HNSW scan.
--
-- Root cause: the old function computed calculate_gravity_score() for ALL
-- matching rows, hitting the 2-minute statement timeout. The candidate pool
-- CTE first gets top-N by vector distance (fast HNSW scan), then computes
-- gravity only for those N rows.

-- Step 1: Drop stale _v2 function
DROP FUNCTION IF EXISTS match_messages_with_gravity_v2(
  vector, double precision, integer, integer, uuid, uuid[], uuid, uuid, text, integer
);

-- Step 2: Recreate canonical function with candidate pool + vault exclusion
CREATE OR REPLACE FUNCTION match_messages_with_gravity(
  query_embedding vector(1024),
  match_threshold float DEFAULT 0.5,
  match_count int DEFAULT 10,
  exclude_recent_seconds int DEFAULT 120,
  p_user_id UUID DEFAULT NULL,
  boost_entity_ids UUID[] DEFAULT NULL,
  p_profile_id UUID DEFAULT NULL,
  p_platform TEXT DEFAULT NULL,
  p_project_id UUID DEFAULT NULL,
  p_candidate_pool int DEFAULT 50
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
  platform TEXT,
  content_category TEXT
) AS $$
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'user_id is required for security (RLS enforcement)';
  END IF;
  IF match_count < 1 OR match_count > 100 THEN
    RAISE EXCEPTION 'match_count must be between 1 and 100, got %', match_count;
  END IF;

  RETURN QUERY
  WITH vector_candidates AS (
    -- Stage 1: Fast HNSW scan — get top candidate_pool rows by vector distance
    SELECT
      ct.id, ct.content, ct.contextual_content,
      ct.turn_range::TEXT AS turn_range, ct.conversation_id,
      ct.speakers, ct.topics,
      ct.created_at::TIMESTAMPTZ AS created_at,
      (1 - (ct.embedding <=> query_embedding))::FLOAT AS vector_similarity,
      ct.impact_score, ct.intimacy_level, ct.access_count, ct.last_accessed,
      ct.valence, ct.arousal, ct.content_category, ct.platform,
      ct.is_question, ct.profile_id, ct.project_id
    FROM chat_turns ct
    WHERE ct.user_id = p_user_id
      AND ct.embedding IS NOT NULL
      AND (ct.deflection IS NULL OR ct.deflection < 0.70)
      AND (ct.exclude_from_search IS NULL OR ct.exclude_from_search = FALSE)
      AND (ct.is_injection IS NULL OR ct.is_injection = FALSE)
      AND is_vault_excluded(p_project_id, ct.project_id)
    ORDER BY ct.embedding <=> query_embedding
    LIMIT p_candidate_pool
  )
  -- Stage 2: Compute gravity only for the candidate pool
  SELECT
    vc.id, vc.content, vc.contextual_content, vc.turn_range,
    vc.conversation_id, vc.speakers, vc.topics, vc.created_at,
    vc.vector_similarity,
    calculate_gravity_score(
      vc.vector_similarity,
      COALESCE(vc.impact_score, 0), COALESCE(vc.intimacy_level, 0),
      vc.created_at, COALESCE(vc.last_accessed, vc.created_at),
      COALESCE(vc.access_count, 0), vc.valence, vc.arousal,
      COALESCE(vc.content_category, 'emotional')
    )::FLOAT AS gravity_score,
    vc.impact_score::INT, vc.intimacy_level::INT,
    vc.access_count::INT, vc.last_accessed::TIMESTAMPTZ,
    CASE
      WHEN boost_entity_ids IS NOT NULL AND EXISTS (
        SELECT 1 FROM entity_mentions em
        WHERE em.chat_turn_id = vc.id AND em.entity_id = ANY(boost_entity_ids)
      ) THEN TRUE ELSE FALSE
    END AS entity_boost,
    vc.platform::TEXT,
    COALESCE(vc.content_category, 'emotional')::TEXT AS content_category
  FROM vector_candidates vc
  WHERE vc.vector_similarity > match_threshold
    AND vc.created_at < NOW() - (exclude_recent_seconds || ' seconds')::INTERVAL
    AND (vc.is_question IS NULL OR vc.is_question = FALSE)
    AND (p_profile_id IS NULL OR vc.profile_id = p_profile_id)
    AND (p_platform IS NULL OR vc.platform = p_platform)
    AND (p_project_id IS NULL OR vc.project_id = p_project_id)
  ORDER BY gravity_score DESC
  LIMIT match_count;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;
