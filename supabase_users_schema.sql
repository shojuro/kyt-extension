-- KYT Phase 6: Users & Chats Schema (The "Glass Box")
-- Purpose: Define Users (with Tiers) and Chats (Metadata) for the "Anti-Theater" architecture.
-- Date: 2025-11-21

-- ============================================
-- 1. Users Table (Tier Management)
-- ============================================
-- This table extends the default auth.users table with application-specific data.
-- It is the "Single Source of Truth" for user tiers.

CREATE TABLE IF NOT EXISTS public.users (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  tier TEXT NOT NULL DEFAULT 'free' CHECK (tier IN ('free', 'pro', 'dev')),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Enable RLS
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;

-- Policy: Users can read their own data
CREATE POLICY "Users can view own profile" ON public.users
  FOR SELECT USING (auth.uid() = id);

-- Policy: Users can update their own profile (e.g. for future settings)
-- Note: Tier updates should ideally be handled by a secure server-side process (e.g. Stripe webhook),
-- but for MVP/Dev we might allow self-update or manual admin update.
-- For now, strictly limit to reading. Updates via Edge Functions/Admin only.

-- Trigger to automatically create a public.users entry when a new auth.user is created
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.users (id, tier)
  VALUES (new.id, 'free');
  RETURN new;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Trigger execution
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();


-- ============================================
-- 2. Chats Table (Conversation Metadata)
-- ============================================
-- Stores metadata for conversations (Title, timestamps) to avoid scanning chat_turns.

CREATE TABLE IF NOT EXISTS public.chats (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL, -- The external ID (e.g. from ChatGPT)
  title TEXT,
  platform TEXT NOT NULL DEFAULT 'chatgpt',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  
  -- Ensure unique conversation per user
  UNIQUE(user_id, conversation_id)
);

-- Enable RLS
ALTER TABLE public.chats ENABLE ROW LEVEL SECURITY;

-- Policy: Users can CRUD their own chats
CREATE POLICY "Users can view own chats" ON public.chats
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own chats" ON public.chats
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own chats" ON public.chats
  FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own chats" ON public.chats
  FOR DELETE USING (auth.uid() = user_id);

-- Indexes
CREATE INDEX IF NOT EXISTS chats_user_id_idx ON public.chats(user_id);
CREATE INDEX IF NOT EXISTS chats_conversation_id_idx ON public.chats(conversation_id);
CREATE INDEX IF NOT EXISTS chats_updated_at_idx ON public.chats(updated_at DESC);

-- ============================================
-- 3. Verification Queries
-- ============================================
-- SELECT * FROM public.users;
-- SELECT * FROM public.chats;
