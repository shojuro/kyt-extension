-- Create table for tracking import history
CREATE TABLE IF NOT EXISTS public.user_history_imports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform IN ('chatgpt', 'claude')),
  
  -- Status tracking
  status TEXT NOT NULL CHECK (status IN ('pending', 'in_progress', 'completed', 'failed'))
    DEFAULT 'pending',
  
  -- Progress tracking
  conversations_total INTEGER DEFAULT 0,
  conversations_processed INTEGER DEFAULT 0,
  messages_imported INTEGER DEFAULT 0,
  messages_skipped INTEGER DEFAULT 0,        -- Duplicates, too old
  
  -- Resume capability (for interrupted imports)
  last_conversation_id TEXT,                 -- Resume from this conversation
  
  -- Duplicate detection
  file_hash TEXT,                            -- SHA-256 of ZIP (null for API imports)
  import_method TEXT CHECK (import_method IN ('api', 'zip')),
  
  -- Date range coverage
  date_range_start TIMESTAMPTZ,              -- Oldest message imported
  date_range_end TIMESTAMPTZ,                -- Newest message imported
  
  -- Cost tracking
  estimated_cost_usd FLOAT DEFAULT 0.0,
  
  -- Timestamps
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  
  -- Prevent exact duplicate ZIP imports
  UNIQUE(user_id, platform, file_hash)
);

-- Enable Row Level Security
ALTER TABLE public.user_history_imports ENABLE ROW LEVEL SECURITY;

-- Create policies
DROP POLICY IF EXISTS "Users can view their own import history" ON public.user_history_imports;
CREATE POLICY "Users can view their own import history"
  ON public.user_history_imports
  FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert their own import history" ON public.user_history_imports;
CREATE POLICY "Users can insert their own import history"
  ON public.user_history_imports
  FOR INSERT
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update their own import history" ON public.user_history_imports;
CREATE POLICY "Users can update their own import history"
  ON public.user_history_imports
  FOR UPDATE
  USING (auth.uid() = user_id);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_user_history_imports_user_platform 
  ON public.user_history_imports(user_id, platform);

CREATE INDEX IF NOT EXISTS idx_user_history_imports_status
  ON public.user_history_imports(user_id, status);
