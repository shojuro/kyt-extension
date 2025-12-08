-- Add deduplication constraint to chat_turns table
-- This prevents duplicate message imports by ensuring uniqueness on
-- (user_id, conversation_id, platform, start_timestamp)

-- First, check for and remove any existing duplicates before adding constraint
-- Keep the row with the lowest id (first inserted)
DELETE FROM public.chat_turns a
WHERE EXISTS (
    SELECT 1 FROM public.chat_turns b
    WHERE a.user_id = b.user_id
      AND a.conversation_id = b.conversation_id
      AND a.platform = b.platform
      AND a.start_timestamp = b.start_timestamp
      AND a.id > b.id
);

-- Create unique index for deduplication
-- This allows ON CONFLICT handling in the Edge Function
CREATE UNIQUE INDEX IF NOT EXISTS chat_turns_dedup_idx
ON public.chat_turns (user_id, conversation_id, platform, start_timestamp);

-- Add a comment explaining the constraint
COMMENT ON INDEX public.chat_turns_dedup_idx IS
'Prevents duplicate message imports. Used by save_chat_turn_batch with ON CONFLICT DO NOTHING.';
