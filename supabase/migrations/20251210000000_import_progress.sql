-- Day 4: Import Progress Tracking Table
-- Enables auto-resume capability for large history imports
-- Competitive moat: unlimited history import without timeouts

CREATE TABLE IF NOT EXISTS public.import_progress (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    total_messages INTEGER NOT NULL DEFAULT 0,
    processed_messages INTEGER NOT NULL DEFAULT 0,
    last_processed_index INTEGER NOT NULL DEFAULT 0,
    resume_data JSONB DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'in_progress', 'completed', 'failed')),
    error_message TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable RLS
ALTER TABLE import_progress ENABLE ROW LEVEL SECURITY;

-- Service role has full access (for Edge Functions)
CREATE POLICY "Service role full access" ON import_progress
    FOR ALL USING (true) WITH CHECK (true);

-- Users can view their own progress
CREATE POLICY "Users can view own progress" ON import_progress
    FOR SELECT USING (auth.uid() = user_id);

-- Index for efficient lookups by user_id and status
CREATE INDEX IF NOT EXISTS idx_import_progress_user_status
    ON import_progress(user_id, status);

-- Index for finding in-progress imports to resume
CREATE INDEX IF NOT EXISTS idx_import_progress_pending
    ON import_progress(status) WHERE status IN ('pending', 'in_progress');

COMMENT ON TABLE import_progress IS 'Tracks history import progress for auto-resume capability';
COMMENT ON COLUMN import_progress.resume_data IS 'JSON data for resuming: chunk positions, partial results, etc.';
COMMENT ON COLUMN import_progress.last_processed_index IS 'Index of last successfully processed chunk (0-based)';
