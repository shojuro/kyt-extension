-- Add 'notebooklm' to user_history_imports platform CHECK constraint.
-- chat_turns and conversations already have it (migration 20260318000000).

ALTER TABLE user_history_imports
  DROP CONSTRAINT IF EXISTS user_history_imports_platform_check;

ALTER TABLE user_history_imports
  ADD CONSTRAINT user_history_imports_platform_check
  CHECK (platform IN ('chatgpt', 'claude', 'claude-code', 'gemini', 'notebooklm'));
