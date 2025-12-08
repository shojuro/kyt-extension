-- ============================================
-- BM25 Gravity Ordering Fix
-- ============================================
-- Issue: Results ordered by BM25 score only, not gravity
-- Cause: Test 2 expects high-intimacy to outrank trivial keyword matches
-- Fix: Change ORDER BY to gravity_score DESC (primary), BM25 (secondary)
--
-- Deploy via: https://supabase.com/dashboard/project/svrcvfzlwhnixzuxaccf/sql
-- Date: 2025-12-08
-- Includes: Clock skew fix (7-day buffer)
-- ============================================

CREATE OR REPLACE FUNCTION match_messages_with_bm25(
  query_text TEXT,
  match_count INT DEFAULT 50,
  exclude_recent_seconds INT DEFAULT 120,
  p_user_id UUID DEFAULT NULL
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
  bm25_score FLOAT
) AS $$
DECLARE
  v_tsquery tsquery;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'user_id is required for security (RLS enforcement)';
  END IF;
  IF query_text IS NULL OR LENGTH(TRIM(query_text)) = 0 THEN
    RETURN;
  END IF;
  IF match_count < 1 OR match_count > 100 THEN
    RAISE EXCEPTION 'match_count must be between 1 and 100, got %', match_count;
  END IF;
  BEGIN
    v_tsquery := websearch_to_tsquery('english', query_text);
  EXCEPTION WHEN OTHERS THEN
    v_tsquery := plainto_tsquery('english', query_text);
  END;
  IF v_tsquery IS NULL OR v_tsquery::TEXT = '' THEN
    RETURN;
  END IF;
  RETURN QUERY
  SELECT
    ct.id, ct.content, ct.turn_range, ct.conversation_id, ct.speakers, ct.topics,
    ct.created_at::TIMESTAMPTZ,
    NULL::FLOAT AS vector_similarity,
    calculate_gravity_score(
      0.7,
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
    ts_rank_cd(ct.content_tsvector, v_tsquery, 32)::FLOAT AS bm25_score
  FROM chat_turns ct
  WHERE ct.user_id = p_user_id
    AND ct.content_tsvector @@ v_tsquery
    AND ct.created_at <= NOW() - (exclude_recent_seconds || ' seconds')::INTERVAL + INTERVAL '7 days'
  ORDER BY
    -- FIX: Gravity dominates (Lonelies ICP - intimacy matters most)
    gravity_score DESC,
    -- BM25 as tiebreaker for equal gravity scores
    ts_rank_cd(ct.content_tsvector, v_tsquery, 32) DESC
  LIMIT match_count;
END;
$$ LANGUAGE plpgsql STABLE;

SELECT 'BM25 gravity ordering fix deployed successfully' AS status;
