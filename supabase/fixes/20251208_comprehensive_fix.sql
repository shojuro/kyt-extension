-- ============================================
-- Comprehensive BM25 Fix - Third-Party Verification Issues
-- ============================================
-- Fixes Applied:
-- 1. Clock skew buffer: 7 days -> 3 days (more reasonable)
-- 2. Rename bm25_score -> fts_score (honest labeling - ts_rank_cd is NOT actual BM25)
-- 3. Add environment guards to test functions (prevent production index drops)
--
-- Deploy via: https://supabase.com/dashboard/project/svrcvfzlwhnixzuxaccf/sql
-- Date: 2025-12-08
-- ============================================

-- DROP existing function first (return type changed: bm25_score -> fts_score)
DROP FUNCTION IF EXISTS match_messages_with_bm25(text, integer, integer, uuid);

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
  fts_score FLOAT  -- RENAMED: was bm25_score, but ts_rank_cd is NOT actual BM25
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
    -- FTS score (NOT BM25 - ts_rank_cd is cover density ranking)
    ts_rank_cd(ct.content_tsvector, v_tsquery, 32)::FLOAT AS fts_score
  FROM chat_turns ct
  WHERE ct.user_id = p_user_id
    AND ct.content_tsvector @@ v_tsquery
    -- FIX: 3-day buffer (was 7 days - too excessive)
    AND ct.created_at <= NOW() - (exclude_recent_seconds || ' seconds')::INTERVAL + INTERVAL '3 days'
  ORDER BY
    gravity_score DESC,
    ts_rank_cd(ct.content_tsvector, v_tsquery, 32) DESC
  LIMIT match_count;
END;
$$ LANGUAGE plpgsql STABLE;

COMMENT ON FUNCTION match_messages_with_bm25 IS
  'Full-text keyword search using PostgreSQL ts_rank_cd (NOT actual BM25). '
  'Returns fts_score for ranking. Gravity formula is UNCHANGED.';

-- ============================================
-- Environment-Guarded Test Functions
-- ============================================

-- Test helper: Temporarily disable BM25 (for Test 3)
-- SECURITY: Only works in test environments
CREATE OR REPLACE FUNCTION test_disable_bm25()
RETURNS VOID AS $$
DECLARE
  v_db_name TEXT;
BEGIN
  SELECT current_database() INTO v_db_name;
  IF v_db_name NOT LIKE '%test%' AND v_db_name NOT LIKE '%dev%' AND v_db_name NOT LIKE '%local%' THEN
    RAISE EXCEPTION 'SECURITY: test_disable_bm25 can only run in test/dev/local databases, not in %', v_db_name;
  END IF;
  DROP INDEX IF EXISTS idx_chat_turns_content_tsvector;
  RAISE NOTICE 'BM25 index disabled for testing in %', v_db_name;
END;
$$ LANGUAGE plpgsql;

-- Test helper: Restore BM25 (for Test 3)
-- SECURITY: Only works in test environments
CREATE OR REPLACE FUNCTION test_restore_bm25()
RETURNS VOID AS $$
DECLARE
  v_db_name TEXT;
BEGIN
  SELECT current_database() INTO v_db_name;
  IF v_db_name NOT LIKE '%test%' AND v_db_name NOT LIKE '%dev%' AND v_db_name NOT LIKE '%local%' THEN
    RAISE EXCEPTION 'SECURITY: test_restore_bm25 can only run in test/dev/local databases, not in %', v_db_name;
  END IF;
  CREATE INDEX IF NOT EXISTS idx_chat_turns_content_tsvector
    ON chat_turns USING GIN (content_tsvector);
  RAISE NOTICE 'BM25 index restored in %', v_db_name;
END;
$$ LANGUAGE plpgsql;

SELECT 'Comprehensive fix deployed successfully' AS status;
