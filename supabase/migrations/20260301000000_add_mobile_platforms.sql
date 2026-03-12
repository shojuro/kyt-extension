-- Add 'mobile' platform to CHECK constraints on chat_turns and conversations
-- This enables the Android app (Voice, Keyboard, Share Sheet) to save data with a distinct platform value.

ALTER TABLE chat_turns DROP CONSTRAINT IF EXISTS chat_turns_platform_check;
ALTER TABLE chat_turns ADD CONSTRAINT chat_turns_platform_check
  CHECK (platform IN ('chatgpt', 'claude', 'cli', 'claude-code', 'gemini', 'mobile'));

ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_platform_check;
ALTER TABLE conversations ADD CONSTRAINT conversations_platform_check
  CHECK (platform IN ('chatgpt', 'claude', 'cli', 'claude-code', 'gemini', 'mobile'));
