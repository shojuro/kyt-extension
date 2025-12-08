-- 🧹 Cleanup Script
-- Run this to remove the old, conflicting 'match_messages' functions
-- We have switched to 'match_messages_v2' to avoid these collisions.

DROP FUNCTION IF EXISTS match_messages(vector(1536), float, int);
DROP FUNCTION IF EXISTS match_messages(vector(1536), float, int, jsonb);
DROP FUNCTION IF EXISTS match_messages(vector(1536), float, int, jsonb, bigint);

-- Verify they are gone
SELECT routine_name, routine_type 
FROM information_schema.routines 
WHERE routine_name = 'match_messages';
