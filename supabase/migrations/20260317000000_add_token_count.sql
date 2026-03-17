-- Add token_count column to chat_turns for Anthropic token counting
ALTER TABLE chat_turns ADD COLUMN IF NOT EXISTS token_count INT;

-- Partial index for efficient backfill (only uncounted rows)
CREATE INDEX IF NOT EXISTS idx_chat_turns_token_count_null
  ON chat_turns(created_at DESC) WHERE token_count IS NULL;

-- RPC: Aggregate token stats
CREATE OR REPLACE FUNCTION get_token_stats(
  p_user_id UUID DEFAULT NULL,
  p_days INT DEFAULT 30,
  p_group_by TEXT DEFAULT 'platform'
)
RETURNS TABLE (
  group_key TEXT,
  turn_count BIGINT,
  total_tokens BIGINT,
  avg_tokens NUMERIC,
  max_tokens INT,
  min_tokens INT
) LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  RETURN QUERY
  SELECT
    CASE p_group_by
      WHEN 'platform' THEN ct.platform
      WHEN 'speaker' THEN ct.speakers[1]
      WHEN 'month' THEN to_char(ct.created_at, 'YYYY-MM')
      ELSE ct.platform
    END,
    COUNT(*)::BIGINT,
    COALESCE(SUM(ct.token_count), 0)::BIGINT,
    ROUND(AVG(ct.token_count)::numeric, 1),
    MAX(ct.token_count),
    MIN(ct.token_count)
  FROM chat_turns ct
  WHERE ct.token_count IS NOT NULL
    AND (p_user_id IS NULL OR ct.user_id = p_user_id)
    AND ct.created_at >= NOW() - (p_days || ' days')::interval
  GROUP BY 1
  ORDER BY 3 DESC;
END;
$$;
