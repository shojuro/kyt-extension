-- Temporary RLS Policy for Messages (Testing/Validation)
-- Allows messages inserts with temp UUID until Supabase Auth is implemented
-- Date: 2025-11-28

-- Add policy to allow temp user (00000000-0000-0000-0000-000000000000) for testing
-- This matches the default userId used in browser-sync.js when no user is configured
DROP POLICY IF EXISTS messages_temp_user_access ON messages;
CREATE POLICY messages_temp_user_access ON messages
  FOR ALL
  USING (user_id = '00000000-0000-0000-0000-000000000000'::uuid)
  WITH CHECK (user_id = '00000000-0000-0000-0000-000000000000'::uuid);

-- Verify policies
SELECT schemaname, tablename, policyname, permissive, roles, cmd
FROM pg_policies
WHERE tablename = 'messages'
ORDER BY policyname;
