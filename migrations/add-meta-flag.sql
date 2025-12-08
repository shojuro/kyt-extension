-- Add meta flag column to messages table
-- Meta-flagged messages are excluded from retrieval to prevent pollution

ALTER TABLE messages 
ADD COLUMN IF NOT EXISTS meta BOOLEAN DEFAULT FALSE;

-- Create index for faster filtering
CREATE INDEX IF NOT EXISTS idx_messages_meta ON messages(meta) WHERE meta = FALSE;

-- Mark existing polluted memories as meta
-- These are conversations about K.Y.T. system development/testing

UPDATE messages 
SET meta = TRUE
WHERE 
    content ILIKE '%xylophone dust%' OR
    content ILIKE '%K.Y.T. MEMORY INJECTION%' OR
    content ILIKE '%[Memory Context%' OR
    content ILIKE '%taxonomy%boosting%' OR
    content ILIKE '%MMR%reranking%' OR
    content ILIKE '%retrieval%pollution%';

-- Show summary
SELECT 
    COUNT(*) FILTER (WHERE meta = TRUE) as meta_messages,
    COUNT(*) FILTER (WHERE meta = FALSE) as active_messages,
    COUNT(*) as total_messages
FROM messages;
