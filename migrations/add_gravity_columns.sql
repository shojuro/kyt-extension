-- Migration: Add gravity score columns to chat_turns table
-- Purpose: Enable semantic decay with salience-based memory persistence
-- Author: SQL Engineer (Temporal Decay Feature - Worktree 1)
-- Date: 2025-11-24

-- Add new columns for gravity score calculation
ALTER TABLE chat_turns
  ADD COLUMN IF NOT EXISTS impact_score INT2 DEFAULT 0
    CHECK (impact_score >= 0 AND impact_score <= 100),
  ADD COLUMN IF NOT EXISTS intimacy_level INT2 DEFAULT 0
    CHECK (intimacy_level >= 0 AND intimacy_level <= 3),
  ADD COLUMN IF NOT EXISTS last_accessed TIMESTAMPTZ DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS access_count INT4 DEFAULT 0,
  ADD COLUMN IF NOT EXISTS gravity_score FLOAT DEFAULT NULL;

-- Add descriptive comments for documentation
COMMENT ON COLUMN chat_turns.impact_score IS 'Holmes-Rahe Life Change Scale score (0-100): Measures life event significance';
COMMENT ON COLUMN chat_turns.intimacy_level IS 'Aron 36 Questions intimacy level (0-3): 0=Surface, 1=Facts, 2=Feelings, 3=Core Identity';
COMMENT ON COLUMN chat_turns.last_accessed IS 'Timestamp of last retrieval for rehearsal effect tracking';
COMMENT ON COLUMN chat_turns.access_count IS 'Number of times this memory has been retrieved (rehearsal bonus)';
COMMENT ON COLUMN chat_turns.gravity_score IS 'Computed relevance score: vector_similarity × importance × time_decay × rehearsal';

-- Create index for gravity score queries (DESC for ORDER BY optimization)
CREATE INDEX IF NOT EXISTS idx_chat_turns_gravity_score
  ON chat_turns(gravity_score DESC NULLS LAST)
  WHERE gravity_score IS NOT NULL;

-- Create index for access tracking (useful for rehearsal effect queries)
CREATE INDEX IF NOT EXISTS idx_chat_turns_last_accessed
  ON chat_turns(last_accessed DESC);

-- Create composite index for user-specific gravity queries
CREATE INDEX IF NOT EXISTS idx_chat_turns_user_gravity
  ON chat_turns(user_id, gravity_score DESC NULLS LAST)
  WHERE gravity_score IS NOT NULL;

-- Verify migration
DO $$
BEGIN
  -- Check that all new columns exist
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'chat_turns' AND column_name = 'impact_score'
  ) THEN
    RAISE EXCEPTION 'Migration failed: impact_score column not created';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'chat_turns' AND column_name = 'intimacy_level'
  ) THEN
    RAISE EXCEPTION 'Migration failed: intimacy_level column not created';
  END IF;

  RAISE NOTICE 'Migration successful: Gravity columns added to chat_turns';
END $$;
