-- Add ingested_at column to chat_turns
-- Separates "when content was originally said" (created_at) from "when K.Y.T. learned about it" (ingested_at)
-- This fixes gravity decay corruption when users revisit old conversations

ALTER TABLE chat_turns ADD COLUMN IF NOT EXISTS ingested_at TIMESTAMPTZ DEFAULT NOW();

-- Backfill: for existing rows, ingestion time = created_at (best we have)
UPDATE chat_turns SET ingested_at = created_at WHERE ingested_at IS NULL;

-- Make NOT NULL after backfill
ALTER TABLE chat_turns ALTER COLUMN ingested_at SET NOT NULL;

-- Index for "recently ingested" queries (revisited signal)
CREATE INDEX IF NOT EXISTS idx_chat_turns_ingested_at ON chat_turns(ingested_at DESC);

-- RPC for re-ingestion rate limiting: count distinct old conversations resurfaced recently
CREATE OR REPLACE FUNCTION count_resurfaced_conversations(
  p_user_id UUID,
  p_window_days INT DEFAULT 90,
  p_gap_seconds BIGINT DEFAULT 7776000
)
RETURNS INT
LANGUAGE sql
STABLE
AS $$
  SELECT COUNT(DISTINCT conversation_id)::INT
  FROM chat_turns
  WHERE user_id = p_user_id
    AND ingested_at > NOW() - (p_window_days || ' days')::INTERVAL
    AND EXTRACT(EPOCH FROM (ingested_at - created_at)) > p_gap_seconds;
$$;
