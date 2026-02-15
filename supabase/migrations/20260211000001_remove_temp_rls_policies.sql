-- Migration: Remove temporary RLS bypass policies and harden security
-- These policies were created for development/testing and must be removed
-- before multi-user deployment or Chrome Web Store distribution.

-- 1. Remove temp user access policies (UUID 00000000-0000-0000-0000-000000000000)
DROP POLICY IF EXISTS messages_temp_user_access ON messages;
DROP POLICY IF EXISTS chat_turns_temp_user_access ON chat_turns;

-- 2. Remove hardcoded custom user access policy
DROP POLICY IF EXISTS messages_custom_user_access ON messages;

-- 3. Replace overly permissive "Service role full access" policies
--    These used USING (true) WITH CHECK (true) on the {public} role,
--    meaning ANY anon-key user could read/write these tables.
--    Fix: Restrict to service_role only (service role already bypasses RLS,
--    but this prevents anon-key access if RLS is enabled).

-- backfill_progress: restrict to service_role + user's own data
DROP POLICY IF EXISTS "Service role full access" ON backfill_progress;
CREATE POLICY "Service role full access" ON backfill_progress
    FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "Users can view own backfill progress" ON backfill_progress
    FOR SELECT USING (auth.uid() = user_id);

-- cost_tracking: restrict to service_role + user's own data (SELECT policy already exists)
DROP POLICY IF EXISTS "Service role full access" ON cost_tracking;
CREATE POLICY "Service role full access" ON cost_tracking
    FOR ALL TO service_role USING (true) WITH CHECK (true);

-- import_progress: restrict to service_role + user's own data (SELECT policy already exists)
DROP POLICY IF EXISTS "Service role full access" ON import_progress;
CREATE POLICY "Service role full access" ON import_progress
    FOR ALL TO service_role USING (true) WITH CHECK (true);
