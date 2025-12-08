-- Migration: Add BM25 Full-Text Search Support
-- Purpose: Add tsvector column and GIN index for keyword-based search
-- Date: 2025-12-09
-- Phase: 2.1 (TDD Implementation)
--
-- ARCHITECTURE:
-- - BM25 is server-side only (PostgreSQL full-text search)
-- - Parallel to vector search, not replacement
-- - Gravity formula UNCHANGED (BM25 is additive boost)
--
-- TEST DEPENDENCIES:
-- - Test 1: BM25 finds "Kobe Bryant" in historical messages
-- - Test 4: Search latency <500ms with BM25 enabled
-- - Test 5: Server-side only (no FTS in client)

-- ============================================
-- 1. Add tsvector column for full-text search
-- ============================================

-- content_tsvector stores pre-computed text search vectors
-- Using 'english' configuration for stemming and stop words
ALTER TABLE chat_turns
  ADD COLUMN IF NOT EXISTS content_tsvector tsvector;

COMMENT ON COLUMN chat_turns.content_tsvector IS
  'Pre-computed tsvector for BM25-style full-text search. '
  'Used for keyword recall in parallel with vector similarity search.';

-- ============================================
-- 2. Create GIN index for fast full-text queries
-- ============================================

-- GIN (Generalized Inverted Index) is optimal for full-text search
-- Enables fast @@ (text search match) operations
CREATE INDEX IF NOT EXISTS idx_chat_turns_content_tsvector
  ON chat_turns USING GIN (content_tsvector);

COMMENT ON INDEX idx_chat_turns_content_tsvector IS
  'GIN index for fast full-text search queries. '
  'Supports BM25-style keyword matching via ts_rank_cd.';

-- ============================================
-- 3. Create trigger for auto-update on insert/update
-- ============================================

-- Function to update tsvector when content changes
CREATE OR REPLACE FUNCTION update_chat_turns_tsvector()
RETURNS TRIGGER AS $$
BEGIN
  -- Only update if content changed (optimization)
  IF TG_OP = 'INSERT' OR NEW.content IS DISTINCT FROM OLD.content THEN
    NEW.content_tsvector := to_tsvector('english', COALESCE(NEW.content, ''));
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION update_chat_turns_tsvector IS
  'Trigger function to auto-update content_tsvector on insert/update. '
  'Uses English configuration for stemming and stop word removal.';

-- Trigger for automatic tsvector updates
DROP TRIGGER IF EXISTS trigger_chat_turns_tsvector ON chat_turns;

CREATE TRIGGER trigger_chat_turns_tsvector
  BEFORE INSERT OR UPDATE OF content
  ON chat_turns
  FOR EACH ROW
  EXECUTE FUNCTION update_chat_turns_tsvector();

-- ============================================
-- 4. Backfill existing rows
-- ============================================

-- Update all existing rows to populate tsvector
-- This may take a while for large tables
UPDATE chat_turns
SET content_tsvector = to_tsvector('english', COALESCE(content, ''))
WHERE content_tsvector IS NULL;

-- ============================================
-- 5. Verify migration
-- ============================================

DO $$
DECLARE
  v_count_total INT;
  v_count_with_tsvector INT;
BEGIN
  SELECT COUNT(*) INTO v_count_total FROM chat_turns;
  SELECT COUNT(*) INTO v_count_with_tsvector FROM chat_turns WHERE content_tsvector IS NOT NULL;

  RAISE NOTICE 'BM25 Migration Complete:';
  RAISE NOTICE '  Total rows: %', v_count_total;
  RAISE NOTICE '  Rows with tsvector: %', v_count_with_tsvector;

  IF v_count_total > 0 AND v_count_with_tsvector = 0 THEN
    RAISE WARNING 'Backfill may have failed - no tsvectors populated';
  END IF;
END $$;
