-- Allow specific custom user ID (found in user's env)
-- User ID: 0499c405-3bff-4901-bc94-d5d0a0c301e4

DROP POLICY IF EXISTS messages_custom_user_access ON messages;
CREATE POLICY messages_custom_user_access ON messages
  FOR ALL
  USING (user_id = '0499c405-3bff-4901-bc94-d5d0a0c301e4'::uuid)
  WITH CHECK (user_id = '0499c405-3bff-4901-bc94-d5d0a0c301e4'::uuid);
