-- Migration: Phase 3b retroactive deflection tagging for chat_turns
-- Purpose: Catch non-first-person deflections missed by Phase 3 patterns.
-- Phase 3 patterns were all first-person-gated ("I don't..."). Real ChatGPT/Claude
-- deflections use impersonal, passive, and second-person constructions.
-- Guard: all patterns require '\nAssistant:' to limit scope to assistant text.

-- 1. Impersonal/passive deflections: "no answer was captured", "no preference was found"
UPDATE chat_turns SET deflection = 0.85
WHERE deflection IS NULL
  AND content ~* '\nAssistant:'
  AND content ~* '(?:no|zero) (?:(?:answer|preference|record|information|data) (?:or )?)+(?:was |has been |were )(?:\w+ )?(?:captured|stored|recorded|saved|found)';

-- 2. Subject-agnostic "don't have answer/record": "Your stored conversations don't have..."
UPDATE chat_turns SET deflection = 0.85
WHERE deflection IS NULL
  AND content ~* '\nAssistant:'
  AND content ~* '(?:don''t|doesn''t|do not) have (?:a |an )?(?:direct )?(?:answer|record|information|data|preference) (?:about|for|regarding|on)';

-- 3. Stored-data lookup failure: "stored conversations still don't have"
UPDATE chat_turns SET deflection = 0.85
WHERE deflection IS NULL
  AND content ~* '\nAssistant:'
  AND content ~* 'stored (?:data|conversations?|items?) (?:still )?(?:don''t|doesn''t|do not) have';

-- 4. Empty retrieval echo: "only contains the question" / "retrieved items are just"
UPDATE chat_turns SET deflection = 0.80
WHERE deflection IS NULL
  AND content ~* '\nAssistant:'
  AND (content ~* 'only contains? the question'
    OR content ~* '(?:retrieved|stored) (?:items?|entries?) (?:are|is|were) (?:just|only)');

-- 5. Adjective-tolerant "there's no X record/answer": "there's no stored record of..."
UPDATE chat_turns SET deflection = 0.80
WHERE deflection IS NULL
  AND content ~* '\nAssistant:'
  AND content ~* 'there''s no \w+ (?:record|information|data|answer|preference) (?:of|about|for|regarding)';
