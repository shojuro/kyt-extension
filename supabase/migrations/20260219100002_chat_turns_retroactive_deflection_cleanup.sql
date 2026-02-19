-- Migration: Retroactive deflection tagging for existing chat_turns
-- Purpose: Tag chat_turns that contain assistant deflection responses synced
-- before Phase 3 deflection tracking was added. Uses content pattern matching
-- on the "Assistant: ..." blocks within chat_turn content.

-- 1. Tag turns containing common deflection phrases in assistant blocks
-- These patterns match the assistant-quality-detector.js DEFLECTION_PATTERNS
UPDATE chat_turns
SET deflection = 0.85
WHERE deflection IS NULL
  AND content ~* '\nAssistant:'
  AND content ~* '(?:I don''t have (?:a record|access|information|any (?:stored|previous))|I wasn''t able to find|no (?:stored|saved) (?:memories|conversations|data)|I couldn''t find any|I don''t see any (?:relevant|matching))';

-- 2. Tag turns with "I don't have" + "about" pattern (catches "I don't have info about your...")
UPDATE chat_turns
SET deflection = 0.80
WHERE deflection IS NULL
  AND content ~* '\nAssistant:'
  AND content ~* 'I don''t (?:have|recall|remember) (?:any )?(?:information|data|details|records|context) (?:about|regarding|on|for)';

-- 3. Tag turns with inability/lack-of-access phrasing
UPDATE chat_turns
SET deflection = 0.80
WHERE deflection IS NULL
  AND content ~* '\nAssistant:'
  AND content ~* '(?:I (?:don''t|do not) (?:currently )?have (?:the ability|any way) to (?:access|retrieve|look up)|(?:not|no) (?:able|available) (?:to )?(?:access|retrieve|find) (?:your|any|the))';
