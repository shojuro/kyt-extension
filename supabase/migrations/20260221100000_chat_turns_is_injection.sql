-- Add is_injection flag to chat_turns
-- Marks turns whose content was captured with a KYT injection prefix.
-- Used to skip entity/preference extraction on polluted turns.

ALTER TABLE chat_turns ADD COLUMN IF NOT EXISTS is_injection BOOLEAN DEFAULT FALSE;

-- Partial index: most queries only care about non-injection turns
CREATE INDEX IF NOT EXISTS idx_chat_turns_not_injection
  ON chat_turns(is_injection) WHERE is_injection = FALSE;
