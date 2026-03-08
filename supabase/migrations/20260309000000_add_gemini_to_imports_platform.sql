-- Add 'gemini' to user_history_imports platform CHECK constraint
-- The original migration (20251129000000) only allowed ('chatgpt', 'claude')

ALTER TABLE public.user_history_imports
  DROP CONSTRAINT IF EXISTS user_history_imports_platform_check;

ALTER TABLE public.user_history_imports
  ADD CONSTRAINT user_history_imports_platform_check
  CHECK (platform IN ('chatgpt', 'claude', 'gemini'));
