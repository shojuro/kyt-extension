-- Migration: Add Anthropic Prompt Cache Token Tracking
-- Date: 2026-03-16
-- Adds cache_creation_tokens and cache_read_tokens to cost_tracking
-- Updates get_cost_summary RPC to include cache token aggregation

ALTER TABLE cost_tracking
  ADD COLUMN IF NOT EXISTS cache_creation_tokens INT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cache_read_tokens INT DEFAULT 0;

COMMENT ON COLUMN cost_tracking.cache_creation_tokens IS 'Tokens written to Anthropic prompt cache (1.25x input price)';
COMMENT ON COLUMN cost_tracking.cache_read_tokens IS 'Tokens read from Anthropic prompt cache (0.1x input price)';

-- Must drop first: return type changed (added cache token columns)
DROP FUNCTION IF EXISTS get_cost_summary(INT, TEXT);

CREATE OR REPLACE FUNCTION get_cost_summary(
  p_days INT DEFAULT 7,
  p_group_by TEXT DEFAULT 'provider'
)
RETURNS TABLE (
  group_key TEXT,
  request_count BIGINT,
  total_input_tokens BIGINT,
  total_output_tokens BIGINT,
  total_cache_creation_tokens BIGINT,
  total_cache_read_tokens BIGINT,
  total_cost_usd NUMERIC
) LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  RETURN QUERY
  SELECT
    CASE p_group_by
      WHEN 'provider' THEN ct.service
      WHEN 'operation' THEN ct.operation
      WHEN 'edge_function' THEN COALESCE(ct.edge_function, 'unknown')
      WHEN 'user' THEN COALESCE(ct.user_id::TEXT, 'anonymous')
      WHEN 'model' THEN ct.model
      ELSE ct.service
    END,
    COUNT(*)::BIGINT,
    COALESCE(SUM(ct.input_tokens), 0)::BIGINT,
    COALESCE(SUM(ct.output_tokens), 0)::BIGINT,
    COALESCE(SUM(ct.cache_creation_tokens), 0)::BIGINT,
    COALESCE(SUM(ct.cache_read_tokens), 0)::BIGINT,
    ROUND(SUM(ct.estimated_cost_usd)::numeric, 6)
  FROM cost_tracking ct
  WHERE ct.created_at >= NOW() - (p_days || ' days')::interval
  GROUP BY 1
  ORDER BY 7 DESC;
END;
$$;
