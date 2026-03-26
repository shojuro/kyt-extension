-- Add content_category to chat_turns for dual-track memory pipeline.
-- Routes ingestion and scoring: emotional content uses Circumplex/gravity,
-- technical content uses entity density + medium decay.
--
-- Default 'emotional' preserves existing behavior for all current rows.
-- New ingestion classifies: emotional | technical | factual | mixed

ALTER TABLE chat_turns
  ADD COLUMN IF NOT EXISTS content_category TEXT DEFAULT 'emotional'
    CHECK (content_category IN ('emotional', 'technical', 'factual', 'mixed'));

-- Index for filtered searches (e.g. technical-only retrieval)
CREATE INDEX IF NOT EXISTS idx_chat_turns_content_category
  ON chat_turns(content_category);

-- Composite index for category-aware gravity search
CREATE INDEX IF NOT EXISTS idx_chat_turns_category_user_embedding
  ON chat_turns(user_id, content_category)
  WHERE embedding IS NOT NULL;

COMMENT ON COLUMN chat_turns.content_category IS
  'Content classification for dual-track scoring: emotional (Circumplex/gravity), technical (entity density/medium decay), factual (light entities), mixed (both paths)';
