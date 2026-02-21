-- Add RLS policies for chat_turns
-- These were missing after 20260211000001_remove_temp_rls_policies.sql dropped
-- chat_turns_temp_user_access but never created replacement policies.
-- RLS enabled + 0 policies = DENY ALL → every browser-sync chat_turns write failed.

-- JWT-authenticated users: standard auth.uid() matching
-- TODO(auth): these are only effective when browser-sync sends the JWT access_token.
-- Until proper token refresh is implemented, the hardcoded user policy below
-- is the actual auth path.
CREATE POLICY chat_turns_select_own ON chat_turns
  FOR SELECT USING (user_id = auth.uid());

CREATE POLICY chat_turns_insert_own ON chat_turns
  FOR INSERT WITH CHECK (user_id = auth.uid());

CREATE POLICY chat_turns_update_own ON chat_turns
  FOR UPDATE USING (user_id = auth.uid());

CREATE POLICY chat_turns_delete_own ON chat_turns
  FOR DELETE USING (user_id = auth.uid());

-- Safety net: allow the known single user even if JWT is expired/missing.
-- Matches the existing fix_rls_custom_user.sql pattern for messages table.
-- Remove this when proper token refresh is implemented.
CREATE POLICY chat_turns_custom_user_access ON chat_turns
  FOR ALL
  USING (user_id = '0499c405-3bff-4901-bc94-d5d0a0c301e4'::uuid)
  WITH CHECK (user_id = '0499c405-3bff-4901-bc94-d5d0a0c301e4'::uuid);
