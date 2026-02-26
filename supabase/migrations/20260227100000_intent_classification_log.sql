-- Intent classification log for Haiku tiebreaker decisions
-- Training data source for v3 TF-IDF classifier
--
-- Every Layer 2 (Haiku 4.5) call logs here. Fields:
--   message_preview: first 200 chars (training input for v3)
--   classification: MEMORY_QUERY | NO_RETRIEVAL (training label)
--   heuristic_scores: v2 S1-S6 scores (feature analysis)
--   source: haiku_tiebreaker | timeout | rate_limited | api_key_missing | exception
--   latency_ms: round-trip time for monitoring

CREATE TABLE IF NOT EXISTS intent_classification_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  message_preview TEXT NOT NULL,
  classification TEXT NOT NULL,
  heuristic_scores JSONB,
  source TEXT NOT NULL DEFAULT 'haiku_tiebreaker',
  latency_ms INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- RLS
ALTER TABLE intent_classification_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own classification logs"
  ON intent_classification_log FOR SELECT
  USING (user_id = auth.uid());

CREATE POLICY "Authenticated users can insert own logs"
  ON intent_classification_log FOR INSERT
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "Users can delete own classification logs"
  ON intent_classification_log FOR DELETE
  USING (user_id = auth.uid());

-- Hardcoded user fallback (matches pattern from other tables)
CREATE POLICY "Hardcoded user read intent logs"
  ON intent_classification_log FOR SELECT
  USING (user_id = '0499c405-bd49-4e5e-97e4-f546abda3b24'::UUID);

CREATE POLICY "Hardcoded user insert intent logs"
  ON intent_classification_log FOR INSERT
  WITH CHECK (user_id = '0499c405-bd49-4e5e-97e4-f546abda3b24'::UUID);

-- Index for training data export (ordered by time)
CREATE INDEX idx_intent_log_user_created
  ON intent_classification_log(user_id, created_at DESC);
