-- Migration: Enable Row Level Security on messages table
-- Purpose: Prevent users from accessing other users' messages (CRITICAL SECURITY FIX)
-- Date: 2025-11-25

-- Enable RLS on messages table
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;

-- Policy: Users can only SELECT their own messages
DROP POLICY IF EXISTS messages_select_policy ON messages;
CREATE POLICY messages_select_policy ON messages
  FOR SELECT USING (user_id = auth.uid());

-- Policy: Users can only INSERT messages for themselves
DROP POLICY IF EXISTS messages_insert_policy ON messages;
CREATE POLICY messages_insert_policy ON messages
  FOR INSERT WITH CHECK (user_id = auth.uid());

-- Policy: Users can only UPDATE their own messages
DROP POLICY IF EXISTS messages_update_policy ON messages;
CREATE POLICY messages_update_policy ON messages
  FOR UPDATE USING (user_id = auth.uid());

-- Policy: Users can only DELETE their own messages
DROP POLICY IF EXISTS messages_delete_policy ON messages;
CREATE POLICY messages_delete_policy ON messages
  FOR DELETE USING (user_id = auth.uid());

-- Note: Service role key bypasses RLS for Edge Functions that need admin access
-- For semantic search, the Edge Function uses service role and filters by user_id in query
