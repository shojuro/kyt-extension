-- Phase 0 Shared Schema Migration
-- Foundation for parallel worktrees: profiles, conversations, content_type
-- All three worktrees (wt-modes, wt-profile, wt-backfill) depend on these.

BEGIN;

-- ============================================================
-- 1. PROFILES TABLE
-- Extends auth.users with KYT-specific settings.
-- 1:1 with auth.users (id = auth.users.id).
-- wt-profile owns this table; wt-modes reads memory_mode.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name TEXT,
  avatar_url TEXT,
  memory_mode TEXT NOT NULL DEFAULT 'standard'
    CHECK (memory_mode IN ('standard', 'journal', 'research', 'minimal')),
  onboarding_completed BOOLEAN NOT NULL DEFAULT FALSE,
  onboarding_completed_at TIMESTAMPTZ,
  preferences JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.profiles IS 'KYT user profiles extending auth.users (1:1)';
COMMENT ON COLUMN public.profiles.memory_mode IS 'Active memory capture mode: standard (all), journal (reflective), research (technical), minimal (opt-in)';
COMMENT ON COLUMN public.profiles.preferences IS 'Flexible JSON settings (UI theme, export format, etc.)';

-- Generic updated_at trigger function (reused by conversations table)
CREATE OR REPLACE FUNCTION public.trigger_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = '';

CREATE TRIGGER profiles_updated_at
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.trigger_set_updated_at();

-- RLS
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY profiles_select_own ON public.profiles
  FOR SELECT USING (id = auth.uid());

CREATE POLICY profiles_insert_own ON public.profiles
  FOR INSERT WITH CHECK (id = auth.uid());

CREATE POLICY profiles_update_own ON public.profiles
  FOR UPDATE USING (id = auth.uid()) WITH CHECK (id = auth.uid());

-- Hardcoded user fallback (matches chat_turns pattern)
CREATE POLICY profiles_custom_user_access ON public.profiles
  FOR ALL USING (id = '0499c405-3bff-4901-bc94-d5d0a0c301e4'::uuid);

-- Auto-create profile on auth.users insert
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (id, display_name)
  VALUES (NEW.id, COALESCE(NEW.raw_user_meta_data->>'name', NEW.email))
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = '';

-- Only create trigger if it doesn't already exist
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'on_auth_user_created'
  ) THEN
    CREATE TRIGGER on_auth_user_created
      AFTER INSERT ON auth.users
      FOR EACH ROW
      EXECUTE FUNCTION public.handle_new_user();
  END IF;
END;
$$;

-- Backfill profiles for existing users
INSERT INTO public.profiles (id, display_name)
SELECT id, COALESCE(raw_user_meta_data->>'name', email)
FROM auth.users
ON CONFLICT (id) DO NOTHING;

-- ============================================================
-- 2. CONVERSATIONS TABLE
-- Proper table for grouping chat_turns by conversation.
-- Replaces the loose conversation_id TEXT field with a FK target.
-- wt-backfill owns import flow; all worktrees can read.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  external_id TEXT NOT NULL,           -- Platform-specific conversation ID (e.g., ChatGPT conv ID)
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform IN ('chatgpt', 'claude', 'cli')),
  title TEXT,                          -- Conversation title (from platform or first message)
  message_count INTEGER NOT NULL DEFAULT 0,
  turn_count INTEGER NOT NULL DEFAULT 0,
  first_message_at TIMESTAMPTZ,
  last_message_at TIMESTAMPTZ,
  is_imported BOOLEAN NOT NULL DEFAULT FALSE,  -- TRUE if from history import
  import_id UUID REFERENCES public.user_history_imports(id) ON DELETE SET NULL,
  exclude_from_search BOOLEAN NOT NULL DEFAULT FALSE,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT unique_conversation UNIQUE(user_id, external_id, platform)
);

COMMENT ON TABLE public.conversations IS 'Conversation metadata grouping chat_turns. external_id matches chat_turns.conversation_id.';
COMMENT ON COLUMN public.conversations.external_id IS 'Platform conversation ID — matches chat_turns.conversation_id';
COMMENT ON COLUMN public.conversations.import_id IS 'FK to user_history_imports if conversation was imported';

-- Indexes
CREATE INDEX IF NOT EXISTS idx_conversations_user_id ON public.conversations(user_id);
CREATE INDEX IF NOT EXISTS idx_conversations_platform ON public.conversations(user_id, platform);
CREATE INDEX IF NOT EXISTS idx_conversations_external ON public.conversations(external_id);
CREATE INDEX IF NOT EXISTS idx_conversations_last_message ON public.conversations(last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_conversations_import ON public.conversations(import_id) WHERE import_id IS NOT NULL;

-- Auto-update updated_at
CREATE TRIGGER conversations_updated_at
  BEFORE UPDATE ON public.conversations
  FOR EACH ROW
  EXECUTE FUNCTION public.trigger_set_updated_at();

-- RLS
ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;

CREATE POLICY conversations_select_own ON public.conversations
  FOR SELECT USING (user_id = auth.uid());

CREATE POLICY conversations_insert_own ON public.conversations
  FOR INSERT WITH CHECK (user_id = auth.uid());

CREATE POLICY conversations_update_own ON public.conversations
  FOR UPDATE USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

CREATE POLICY conversations_delete_own ON public.conversations
  FOR DELETE USING (user_id = auth.uid());

-- Hardcoded user fallback
CREATE POLICY conversations_custom_user_access ON public.conversations
  FOR ALL USING (user_id = '0499c405-3bff-4901-bc94-d5d0a0c301e4'::uuid);

-- ============================================================
-- 3. CONTENT_TYPE COLUMN ON CHAT_TURNS
-- Tags memory mode at capture time for filtering/routing.
-- wt-modes sets this during capture; all worktrees can filter.
-- ============================================================

ALTER TABLE public.chat_turns
  ADD COLUMN IF NOT EXISTS content_type TEXT NOT NULL DEFAULT 'conversation';

-- Add check constraint separately (IF NOT EXISTS not supported for constraints)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chat_turns_content_type_check'
  ) THEN
    ALTER TABLE public.chat_turns
      ADD CONSTRAINT chat_turns_content_type_check
      CHECK (content_type IN ('conversation', 'journal', 'note', 'research', 'imported'));
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS idx_chat_turns_content_type ON public.chat_turns(content_type);

COMMENT ON COLUMN public.chat_turns.content_type IS 'Memory mode at capture: conversation (default), journal, note, research, imported';

-- ============================================================
-- 4. HELPER: Populate conversations from existing chat_turns
-- One-time backfill so existing data has conversation records.
-- ============================================================

INSERT INTO public.conversations (external_id, user_id, platform, turn_count, first_message_at, last_message_at)
SELECT
  conversation_id,
  user_id,
  platform,
  COUNT(*),
  MIN(to_timestamp(start_timestamp / 1000.0)),
  MAX(to_timestamp(end_timestamp / 1000.0))
FROM public.chat_turns
WHERE conversation_id IS NOT NULL
  AND user_id IN (SELECT id FROM auth.users)  -- Skip orphan fallback UUIDs
GROUP BY conversation_id, user_id, platform
ON CONFLICT (user_id, external_id, platform) DO NOTHING;

-- ============================================================
-- 5. GRANTS
-- ============================================================

GRANT SELECT, INSERT, UPDATE ON public.profiles TO authenticated;
GRANT SELECT ON public.profiles TO anon;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.conversations TO authenticated;
GRANT SELECT ON public.conversations TO anon;

COMMIT;
