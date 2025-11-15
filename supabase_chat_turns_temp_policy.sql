-- Temporary RLS Policy for Testing (Phase 6)
-- Allows chat_turns inserts with temp UUID until Supabase Auth is implemented

-- Add policy to allow temp user (00000000-0000-0000-0000-000000000000) for testing
CREATE POLICY chat_turns_temp_user_access ON chat_turns
  FOR ALL
  USING (user_id = '00000000-0000-0000-0000-000000000000'::uuid)
  WITH CHECK (user_id = '00000000-0000-0000-0000-000000000000'::uuid);

-- Verify policies
SELECT schemaname, tablename, policyname, permissive, roles, cmd
FROM pg_policies
WHERE tablename = 'chat_turns'
ORDER BY policyname;

-- Expected output: 2 policies
-- 1. chat_turns_user_isolation (for authenticated users via auth.uid())
-- 2. chat_turns_temp_user_access (for temp UUID testing)
