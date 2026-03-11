-- Migration: Granular API Cost Tracking
-- Date: 2026-03-11
-- Adds token counts, edge function source, latency tracking, fixed costs table, and aggregation RPCs

-- Add missing columns to cost_tracking (non-breaking, all have defaults)
ALTER TABLE cost_tracking
  ADD COLUMN IF NOT EXISTS input_tokens INT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS output_tokens INT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS edge_function TEXT,
  ADD COLUMN IF NOT EXISTS latency_ms INT;

-- Indexes for new query patterns
CREATE INDEX IF NOT EXISTS idx_cost_tracking_user
  ON cost_tracking(user_id, created_at) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_cost_tracking_edge_fn
  ON cost_tracking(edge_function, created_at) WHERE edge_function IS NOT NULL;

-- Fixed monthly costs table
CREATE TABLE IF NOT EXISTS fixed_costs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  provider TEXT NOT NULL,
  monthly_cost_usd DECIMAL(10,2) NOT NULL,
  start_date DATE NOT NULL,
  end_date DATE,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE fixed_costs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role full access" ON fixed_costs FOR ALL USING (true) WITH CHECK (true);

-- Seed fixed costs
INSERT INTO fixed_costs (name, provider, monthly_cost_usd, start_date, notes) VALUES
  ('Claude MAX Subscription', 'anthropic', 200.00, '2025-11-01', 'Includes Claude Code usage'),
  ('Jina Reranker Pro', 'jina', 50.00, '2025-11-01', 'Replaced by HuggingFace BGE Mar 2026'),
  ('Supabase Pro', 'supabase', 25.00, '2025-11-01', NULL);

-- RPC: Aggregated cost summary
CREATE OR REPLACE FUNCTION get_cost_summary(
  p_days INT DEFAULT 7,
  p_group_by TEXT DEFAULT 'provider'
)
RETURNS TABLE (
  group_key TEXT,
  request_count BIGINT,
  total_input_tokens BIGINT,
  total_output_tokens BIGINT,
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
    ROUND(SUM(ct.estimated_cost_usd)::numeric, 6)
  FROM cost_tracking ct
  WHERE ct.created_at >= NOW() - (p_days || ' days')::interval
  GROUP BY 1
  ORDER BY 5 DESC;
END;
$$;

-- RPC: Daily cost timeseries
CREATE OR REPLACE FUNCTION get_cost_timeseries(
  p_days INT DEFAULT 30,
  p_group_by TEXT DEFAULT 'provider'
)
RETURNS TABLE (
  day DATE,
  group_key TEXT,
  request_count BIGINT,
  total_cost_usd NUMERIC
) LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  RETURN QUERY
  SELECT
    ct.created_at::date,
    CASE p_group_by
      WHEN 'provider' THEN ct.service
      WHEN 'operation' THEN ct.operation
      ELSE ct.service
    END,
    COUNT(*)::BIGINT,
    ROUND(SUM(ct.estimated_cost_usd)::numeric, 4)
  FROM cost_tracking ct
  WHERE ct.created_at >= NOW() - (p_days || ' days')::interval
  GROUP BY 1, 2
  ORDER BY 1 DESC, 4 DESC;
END;
$$;
