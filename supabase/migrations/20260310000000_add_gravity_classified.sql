-- Add gravity_classified boolean to track backfill state for impact_score/intimacy_level.
-- Needed because impact_score=0 is a legitimate classification result (surface-level content),
-- so we can't use 0/0 as an "unprocessed" sentinel.

ALTER TABLE chat_turns ADD COLUMN IF NOT EXISTS gravity_classified BOOLEAN DEFAULT FALSE;

-- Mark rows that already have real impact scores as classified
UPDATE chat_turns SET gravity_classified = TRUE WHERE impact_score > 0;
