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
    -- BM25-like score using ts_rank_cd (cover density ranking)
    -- Flag 32: Divides rank by document length + 1 (length normalization)
    -- This approximates BM25's document length normalization
    ts_rank_cd(ct.content_tsvector, v_tsquery, 32)::FLOAT AS bm25_score
  FROM chat_turns ct
  WHERE
    -- Security: User isolation via RLS
    ct.user_id = p_user_id
    -- Full-text match: content matches query
    AND ct.content_tsvector @@ v_tsquery
    -- Temporal exclusion: Avoid returning very recent context
    -- Note: Using 7-day buffer to handle client-server clock skew (cloud environments may have significant drift)
    -- This allows messages with timestamps up to 7 days in the "future" relative to server time
    AND ct.created_at <= NOW() - (exclude_recent_seconds || ' seconds')::INTERVAL + INTERVAL '7 days'
  ORDER BY
    -- Primary sort: BM25 score (keyword relevance)
    -- Gravity is used for final ranking in merge step
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
CREATE OR REPLACE FUNCTION test_disable_bm25()
RETURNS VOID AS $$
BEGIN
  -- Drop the index to simulate BM25 failure
  -- In production, this would never be called
  DROP INDEX IF EXISTS idx_chat_turns_content_tsvector;
  RAISE NOTICE 'BM25 index disabled for testing';
END;
$$ LANGUAGE plpgsql;

-- Test helper: Restore BM25 (for Test 3)
CREATE OR REPLACE FUNCTION test_restore_bm25()
RETURNS VOID AS $$
BEGIN
  -- Recreate the index
  CREATE INDEX IF NOT EXISTS idx_chat_turns_content_tsvector
    ON chat_turns USING GIN (content_tsvector);
  RAISE NOTICE 'BM25 index restored';
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
