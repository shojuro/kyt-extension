-- KYT Day 2: Multi-Source Memory Enhancement
-- Add source column to track where memories originated
-- Run this in Supabase SQL Editor after supabase_schema.sql

-- Add source column (defaults to 'chatgpt' for existing records)
ALTER TABLE messages ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'chatgpt';

-- Add index for filtering by source
CREATE INDEX IF NOT EXISTS messages_source_idx ON messages (source);

-- Update existing records to explicitly mark as chatgpt source
UPDATE messages SET source = 'chatgpt' WHERE source IS NULL;

-- Verify column was added
SELECT column_name, data_type, column_default
FROM information_schema.columns
WHERE table_name = 'messages' AND column_name = 'source';

-- Test query: Get counts by source
SELECT source, COUNT(*) as count
FROM messages
GROUP BY source
ORDER BY count DESC;
