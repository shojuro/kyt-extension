-- Migration: Cost Tracking for Production Hardening
-- Date: 2025-11-28

CREATE TABLE IF NOT EXISTS cost_tracking (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    service TEXT NOT NULL,           -- 'huggingface', 'openai'
    model TEXT NOT NULL,             -- 'Qwen3-Embedding-8B', 'gpt-4o-mini'
    operation TEXT NOT NULL,         -- 'embedding', 'rerank', 'entity_extraction'
    request_count INT DEFAULT 1,
    estimated_cost_usd FLOAT DEFAULT 0.0,
    request_id TEXT,
    user_id UUID,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for monitoring queries
CREATE INDEX IF NOT EXISTS idx_cost_tracking_daily ON cost_tracking(created_at);
CREATE INDEX IF NOT EXISTS idx_cost_tracking_service ON cost_tracking(service, created_at);

-- RLS
ALTER TABLE cost_tracking ENABLE ROW LEVEL SECURITY;

-- Service role full access
CREATE POLICY "Service role full access" ON cost_tracking
    FOR ALL USING (true) WITH CHECK (true);

-- Optional: Read access for authenticated users (own data only)
CREATE POLICY "Users can read own cost data" ON cost_tracking
    FOR SELECT USING (auth.uid() = user_id);
