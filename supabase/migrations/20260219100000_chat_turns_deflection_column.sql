-- Migration: Add deflection column to chat_turns
-- Purpose: Store max assistant deflection score per chat_turn chunk,
-- enabling SQL-level filtering of deflection responses in RPCs.
-- Complements the existing is_question column (Phase 1/2) which only flags
-- turns where ALL user messages are questions with ALL assistants deflecting.

-- 1. Add deflection FLOAT column (nullable — most turns have no deflection)
ALTER TABLE chat_turns ADD COLUMN IF NOT EXISTS deflection FLOAT;

-- 2. Partial index: only index rows with deflection scores (same pattern as is_question)
CREATE INDEX IF NOT EXISTS idx_chat_turns_deflection
  ON chat_turns(deflection) WHERE deflection IS NOT NULL;
