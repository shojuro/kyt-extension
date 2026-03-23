-- Migration: Add Russell's Circumplex emotional dimensions + LLM emotion keywords
-- Purpose: Extend memory classification with valence/arousal axes and contextual
--          emotion synonyms for improved emotional query retrieval.
-- Context: Holmes-Rahe (impact 0-100) captures magnitude but not direction
--          (wedding=75, funeral=75). Valence/arousal distinguish positive from
--          negative and high-energy from low-energy emotional content.

-- Valence: Russell's Circumplex pleasant↔unpleasant axis
-- Range: -1.0 (devastated, enraged) to +1.0 (ecstatic, deeply grateful)
ALTER TABLE chat_turns ADD COLUMN IF NOT EXISTS valence REAL;

-- Arousal: Russell's Circumplex deactivated↔activated axis
-- Range: 0.0 (calm, disengaged) to 1.0 (panic, rage, ecstasy)
ALTER TABLE chat_turns ADD COLUMN IF NOT EXISTS arousal REAL;

-- LLM-generated contextual emotion keywords for BM25 search
-- 5-8 terms per message, e.g. ['grief', 'loss', 'mourning', 'heartbroken']
ALTER TABLE chat_turns ADD COLUMN IF NOT EXISTS emotion_keywords TEXT[];

-- Backfill sentinel (separate from gravity_classified because existing
-- gravity-classified rows still need emotional dimension classification)
ALTER TABLE chat_turns ADD COLUMN IF NOT EXISTS emotion_classified BOOLEAN DEFAULT FALSE;

-- CHECK constraints for data integrity
-- Use DO block to avoid error if constraint already exists
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_valence'
  ) THEN
    ALTER TABLE chat_turns ADD CONSTRAINT chk_valence
      CHECK (valence IS NULL OR (valence >= -1.0 AND valence <= 1.0));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_arousal'
  ) THEN
    ALTER TABLE chat_turns ADD CONSTRAINT chk_arousal
      CHECK (arousal IS NULL OR (arousal >= 0.0 AND arousal <= 1.0));
  END IF;
END $$;

-- Composite index for valence-arousal quadrant filtering
-- Example: "happy memories" → valence > 0.3 AND arousal > 0.3
CREATE INDEX IF NOT EXISTS idx_chat_turns_valence_arousal
  ON chat_turns (valence, arousal)
  WHERE valence IS NOT NULL;

-- GIN index for emotion_keywords array overlap search
-- Example: WHERE emotion_keywords && ARRAY['grief', 'loss']
CREATE INDEX IF NOT EXISTS idx_chat_turns_emotion_keywords
  ON chat_turns USING GIN (emotion_keywords)
  WHERE emotion_keywords IS NOT NULL;

-- Partial index for backfill targeting (newest first)
CREATE INDEX IF NOT EXISTS idx_chat_turns_emotion_unclassified
  ON chat_turns (created_at DESC)
  WHERE emotion_classified = FALSE;
