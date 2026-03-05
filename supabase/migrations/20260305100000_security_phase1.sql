-- Security Phase 1: Critical fixes
-- 1. Drop hardcoded UUID bypass policies (6 policies across 5 tables)
-- 2. Create public.users table for stripe-webhook tier tracking
-- 3. Add WITH CHECK to UPDATE policies missing it (4 tables)
-- 4. Add service_role CRUD policies to stripe tables
--
-- IMPORTANT: After applying, browser-sync.js MUST use valid JWT (401-retry).
-- The hardcoded UUID fallback is gone.

-- ============================================================================
-- 1. DROP HARDCODED UUID BYPASS POLICIES
-- These allowed anyone with the anon key to read/write data for a specific user
-- without authentication. Each policy name matches the original migration.
-- ============================================================================

-- chat_turns: from 20260221200000_chat_turns_rls_policies.sql
DROP POLICY IF EXISTS chat_turns_custom_user_access ON chat_turns;

-- messages: from fix_rls_custom_user.sql
DROP POLICY IF EXISTS messages_custom_user_access ON messages;

-- profiles: from 20260225200000_shared_schema_phase0.sql
DROP POLICY IF EXISTS profiles_custom_user_access ON profiles;

-- conversations: from 20260225200000_shared_schema_phase0.sql
DROP POLICY IF EXISTS conversations_custom_user_access ON conversations;

-- intent_classification_log: from 20260227100000 (uses WRONG UUID too)
DROP POLICY IF EXISTS "Hardcoded user read intent logs" ON intent_classification_log;
DROP POLICY IF EXISTS "Hardcoded user insert intent logs" ON intent_classification_log;

-- ============================================================================
-- 2. CREATE public.users TABLE
-- stripe-webhook/index.ts writes to public.users for tier tracking.
-- Without this table, those writes silently fail.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.users (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  tier TEXT NOT NULL DEFAULT 'free' CHECK (tier IN ('free', 'pro', 'dev')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Auto-populate on auth signup (like profiles table)
CREATE OR REPLACE FUNCTION public.handle_new_user_record()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.users (id)
  VALUES (NEW.id)
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Only create trigger if it doesn't already exist
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'on_auth_user_created_public_users'
  ) THEN
    CREATE TRIGGER on_auth_user_created_public_users
      AFTER INSERT ON auth.users
      FOR EACH ROW
      EXECUTE FUNCTION public.handle_new_user_record();
  END IF;
END $$;

-- Backfill existing auth users
INSERT INTO public.users (id)
SELECT id FROM auth.users
ON CONFLICT (id) DO NOTHING;

-- RLS: users can read own record, only service_role can write
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;

CREATE POLICY users_select_own ON public.users
  FOR SELECT USING (id = auth.uid());

CREATE POLICY users_service_role_all ON public.users
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- updated_at trigger
CREATE TRIGGER users_updated_at
  BEFORE UPDATE ON public.users
  FOR EACH ROW
  EXECUTE FUNCTION public.trigger_set_updated_at();

-- ============================================================================
-- 3. ADD WITH CHECK TO UPDATE POLICIES
-- Without WITH CHECK on UPDATE, a user could update a row's user_id to another
-- user's ID, effectively transferring ownership. WITH CHECK prevents this.
-- ============================================================================

-- chat_turns: DROP and recreate with WITH CHECK
DROP POLICY IF EXISTS chat_turns_update_own ON chat_turns;
CREATE POLICY chat_turns_update_own ON chat_turns
  FOR UPDATE USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- messages: DROP and recreate with WITH CHECK
DROP POLICY IF EXISTS messages_update_policy ON messages;
CREATE POLICY messages_update_policy ON messages
  FOR UPDATE USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- user_preferences: DROP and recreate with WITH CHECK
DROP POLICY IF EXISTS "Users can update own preferences" ON user_preferences;
CREATE POLICY "Users can update own preferences" ON user_preferences
  FOR UPDATE USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- user_history_imports: DROP and recreate with WITH CHECK
DROP POLICY IF EXISTS "Users can update their own import history" ON user_history_imports;
CREATE POLICY "Users can update their own import history" ON user_history_imports
  FOR UPDATE USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- entities: DROP and recreate with WITH CHECK
DROP POLICY IF EXISTS "Users can update own entities" ON entities;
CREATE POLICY "Users can update own entities" ON entities
  FOR UPDATE USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- entity_relationships: DROP and recreate with WITH CHECK
DROP POLICY IF EXISTS "Users can update own entity_relationships" ON entity_relationships;
CREATE POLICY "Users can update own entity_relationships" ON entity_relationships
  FOR UPDATE USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- entity_mentions: DROP and recreate with WITH CHECK
DROP POLICY IF EXISTS "Users can update own entity_mentions" ON entity_mentions;
CREATE POLICY "Users can update own entity_mentions" ON entity_mentions
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM entities e
      WHERE e.id = entity_mentions.entity_id
      AND e.user_id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM entities e
      WHERE e.id = entity_mentions.entity_id
      AND e.user_id = auth.uid()
    )
  );

-- ============================================================================
-- 4. SERVICE_ROLE CRUD POLICIES FOR STRIPE TABLES
-- stripe-webhook runs as service_role. Without explicit policies,
-- service_role bypasses RLS anyway, but explicit policies are best practice
-- and required if we ever change to FORCE ROW LEVEL SECURITY.
-- ============================================================================

CREATE POLICY stripe_customers_service_role ON stripe_customers
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

CREATE POLICY stripe_subscriptions_service_role ON stripe_subscriptions
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

CREATE POLICY stripe_events_service_role ON stripe_events
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);
