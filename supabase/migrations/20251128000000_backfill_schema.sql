-- Migration: Backfill Schema Support
-- Date: 2025-11-28

-- 1. Create backfill_progress table to track resumability
CREATE TABLE IF NOT EXISTS backfill_progress (
    id TEXT PRIMARY KEY,  -- 'embeddings' or 'entities'
    last_processed_id UUID,
    processed_count INT DEFAULT 0,
    total_count INT DEFAULT 0,
    status TEXT DEFAULT 'pending',  -- 'pending', 'running', 'completed', 'failed'
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    error_message TEXT
);

-- Enable RLS
ALTER TABLE backfill_progress ENABLE ROW LEVEL SECURITY;

-- Allow service role full access (for Edge Functions)
-- (Service role bypasses RLS, but good practice to have policies if exposed)
CREATE POLICY "Service role full access" ON backfill_progress
    FOR ALL USING (true) WITH CHECK (true);


-- 2. Add entities_extracted column to chat_turns
ALTER TABLE chat_turns 
ADD COLUMN IF NOT EXISTS entities_extracted BOOLEAN DEFAULT FALSE;

-- Index for faster querying of unprocessed rows
CREATE INDEX IF NOT EXISTS idx_chat_turns_entities_extracted 
ON chat_turns(entities_extracted) 
WHERE entities_extracted = FALSE;

-- 3. Helper function to update backfill progress
CREATE OR REPLACE FUNCTION update_backfill_progress(
    p_id TEXT,
    p_last_id UUID,
    p_increment INT,
    p_status TEXT DEFAULT NULL,
    p_error TEXT DEFAULT NULL
)
RETURNS VOID AS $$
BEGIN
    INSERT INTO backfill_progress (id, last_processed_id, processed_count, status, updated_at, error_message)
    VALUES (p_id, p_last_id, p_increment, COALESCE(p_status, 'running'), NOW(), p_error)
    ON CONFLICT (id) DO UPDATE SET
        last_processed_id = COALESCE(EXCLUDED.last_processed_id, backfill_progress.last_processed_id),
        processed_count = backfill_progress.processed_count + EXCLUDED.processed_count,
        status = COALESCE(EXCLUDED.status, backfill_progress.status),
        updated_at = NOW(),
        error_message = COALESCE(EXCLUDED.error_message, backfill_progress.error_message);
END;
$$ LANGUAGE plpgsql;
