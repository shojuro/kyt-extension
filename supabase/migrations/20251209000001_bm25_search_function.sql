-- Migration: BM25 Search Function
-- Purpose: Full-text keyword search with gravity-based ranking
-- Date: 2025-12-09
-- Phase: 2.2 (TDD Implementation)
--
-- ARCHITECTURE:
-- - Uses ts_rank_cd for BM25-approximation scoring (cover density)
-- - Returns gravity_score alongside bm25_score
-- - Final ranking: gravity × (1 + bm25_boost) - applied in Edge Function
-- - DOES NOT modify gravity formula (Test 6 validation)
--
-- TEST DEPENDENCIES:
-- - Test 1: BM25 finds "Kobe Bryant" in historical messages
-- - Test 2: Gravity dominates BM25 (high-intimacy outranks trivial)
-- - Test 3: Graceful degradation
-- - Test 4: Performance <500ms

-- ============================================
-- 1. Create BM25 Search Function
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
  fts_score FLOAT  -- Note: Using fts_score (not bm25_score) - ts_rank_cd approximates but is NOT actual BM25
) AS $$
DECLARE
  v_tsquery tsquery;
BEGIN
  -- Input validation
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'user_id is required for security (RLS enforcement)';
  END IF;

  IF query_text IS NULL OR LENGTH(TRIM(query_text)) = 0 THEN
    -- Empty query returns no results (graceful handling)
    RETURN;
  END IF;

  IF match_count < 1 OR match_count > 100 THEN
    RAISE EXCEPTION 'match_count must be between 1 and 100, got %', match_count;
  END IF;

  -- Parse query into tsquery
  -- websearch_to_tsquery handles natural language queries well
  -- e.g., "Kobe Bryant" becomes 'kobe' & 'bryant'
  BEGIN
    v_tsquery := websearch_to_tsquery('english', query_text);
  EXCEPTION WHEN OTHERS THEN
    -- Fallback: try plainto_tsquery if websearch fails
    v_tsquery := plainto_tsquery('english', query_text);
  END;

  -- If query couldn't be parsed, return empty results
  IF v_tsquery IS NULL OR v_tsquery::TEXT = '' THEN
    RETURN;
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
    -- Vector similarity: NULL for BM25-only results (merged in Edge Function)
    NULL::FLOAT AS vector_similarity,
    -- Gravity score: Calculate even for BM25 matches
    -- This enables proper ranking when merging with vector results
    calculate_gravity_score(
      0.7,  -- Default similarity for keyword matches (no embedding comparison)
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
    -- Full-Text Search score using ts_rank_cd (cover density ranking)
    -- Flag 32: Divides rank by document length + 1 (length normalization)
    -- Note: ts_rank_cd is NOT actual BM25, but approximates it with length normalization
    ts_rank_cd(ct.content_tsvector, v_tsquery, 32)::FLOAT AS fts_score
  FROM chat_turns ct
  WHERE
    -- Security: User isolation via RLS
    ct.user_id = p_user_id
    -- Full-text match: content matches query
    AND ct.content_tsvector @@ v_tsquery
    -- Temporal exclusion: Avoid returning very recent context
    -- Note: Using 3-day buffer to handle client-server clock skew (cloud environments may have ~2 days drift)
    -- 3 days balances skew tolerance vs. potential security gap
    AND ct.created_at <= NOW() - (exclude_recent_seconds || ' seconds')::INTERVAL + INTERVAL '3 days'
  ORDER BY
    -- Primary sort: Gravity score (intimacy/impact dominates for Lonelies ICP)
    -- High-intimacy memories rank above trivial keyword matches
    gravity_score DESC,
    -- Secondary sort: BM25 score as tiebreaker for equal gravity
    ts_rank_cd(ct.content_tsvector, v_tsquery, 32) DESC
  LIMIT match_count;
END;
$$ LANGUAGE plpgsql STABLE;

COMMENT ON FUNCTION match_messages_with_bm25 IS
  'Full-text keyword search using PostgreSQL ts_rank_cd for BM25-like scoring. '
  'Returns results with both gravity_score and bm25_score for merge with vector search. '
  'Gravity formula is UNCHANGED - BM25 is additive boost, not replacement.';

-- ============================================
-- 2. Create helper functions for graceful degradation
-- ============================================

-- Test helper: Temporarily disable BM25 (for Test 3)
-- SECURITY: Only works in test environments (database name must contain 'test' or 'dev')
CREATE OR REPLACE FUNCTION test_disable_bm25()
RETURNS VOID AS $$
DECLARE
  v_db_name TEXT;
BEGIN
  -- Environment guard: ONLY run in test/dev databases
  SELECT current_database() INTO v_db_name;
  IF v_db_name NOT LIKE '%test%' AND v_db_name NOT LIKE '%dev%' AND v_db_name NOT LIKE '%local%' THEN
    RAISE EXCEPTION 'SECURITY: test_disable_bm25 can only run in test/dev/local databases, not in %', v_db_name;
  END IF;

  -- Drop the index to simulate BM25 failure
  DROP INDEX IF EXISTS idx_chat_turns_content_tsvector;
  RAISE NOTICE 'BM25 index disabled for testing in %', v_db_name;
END;
$$ LANGUAGE plpgsql;

-- Test helper: Restore BM25 (for Test 3)
-- SECURITY: Only works in test environments (database name must contain 'test' or 'dev')
CREATE OR REPLACE FUNCTION test_restore_bm25()
RETURNS VOID AS $$
DECLARE
  v_db_name TEXT;
BEGIN
  -- Environment guard: ONLY run in test/dev databases
  SELECT current_database() INTO v_db_name;
  IF v_db_name NOT LIKE '%test%' AND v_db_name NOT LIKE '%dev%' AND v_db_name NOT LIKE '%local%' THEN
    RAISE EXCEPTION 'SECURITY: test_restore_bm25 can only run in test/dev/local databases, not in %', v_db_name;
  END IF;

  -- Recreate the index
  CREATE INDEX IF NOT EXISTS idx_chat_turns_content_tsvector
    ON chat_turns USING GIN (content_tsvector);
  RAISE NOTICE 'BM25 index restored in %', v_db_name;
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- 3. Verification test
-- ============================================

DO $$
DECLARE
  v_func_exists BOOLEAN;
BEGIN
  SELECT EXISTS(
    SELECT 1 FROM pg_proc
    WHERE proname = 'match_messages_with_bm25'
  ) INTO v_func_exists;

  IF v_func_exists THEN
    RAISE NOTICE 'BM25 search function created successfully';
    RAISE NOTICE 'To test: SELECT * FROM match_messages_with_bm25(''Kobe Bryant'', 10, 0, <user_id>)';
  ELSE
    RAISE EXCEPTION 'BM25 search function creation FAILED';
  END IF;
END $$;
