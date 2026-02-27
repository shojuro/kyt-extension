-- Add 'gemini' platform to CHECK constraints on chat_turns and conversations
-- This enables the Chrome extension to save Gemini conversation data with a distinct platform value.

ALTER TABLE chat_turns DROP CONSTRAINT IF EXISTS chat_turns_platform_check;
ALTER TABLE chat_turns ADD CONSTRAINT chat_turns_platform_check
  CHECK (platform IN ('chatgpt', 'claude', 'cli', 'claude-code', 'gemini'));

ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_platform_check;
ALTER TABLE conversations ADD CONSTRAINT conversations_platform_check
  CHECK (platform IN ('chatgpt', 'claude', 'cli', 'claude-code', 'gemini'));
