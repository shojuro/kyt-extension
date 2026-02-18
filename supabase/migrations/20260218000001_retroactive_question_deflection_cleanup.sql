-- Migration: Retroactive cleanup of existing question and deflection pollution
-- Tags existing user questions so they are excluded from vector search (match_messages_v2).
-- Backfills deflection scores on assistant messages matching known deflection patterns.

-- 1. Tag user messages ending with '?' as questions
UPDATE messages SET is_question = true
WHERE role = 'user' AND TRIM(content) LIKE '%?';

-- 2. Tag user messages starting with interrogative words as questions
-- (catches questions without trailing '?' like "Tell me my favorite car")
UPDATE messages SET is_question = true
WHERE role = 'user'
  AND is_question = false
  AND content ~* '^\s*(what|who|where|when|why|how|which|is|are|was|were|do|does|did|can|could|would|will|shall|should|have|has|had|tell me|remind me|do you know|do you remember)\b';

-- 3. Backfill deflection scores on existing assistant messages matching known patterns
-- These match the high-confidence patterns from src/assistant-quality-detector.js
-- Score 0.85 = high confidence deflection (will be filtered at sync/search time)
UPDATE messages SET deflection = 0.85
WHERE role = 'assistant'
  AND deflection IS NULL
  AND (
    content ~* 'i don''?t have access to'
    OR content ~* 'i don''?t have (any )?(information|data|records?) (about|on|regarding)'
    OR content ~* 'i (can''?t|cannot|am unable to) (access|retrieve|find|locate|look up)'
    OR content ~* 'i''?m (not able|unable) to (access|retrieve|find|provide)'
    OR content ~* 'i don''?t (know|recall|remember) (what|the|any|about)'
    OR content ~* 'i don''?t have (enough|sufficient) (context|information)'
    OR content ~* 'there''?s no (record|information|data|mention) of'
    OR content ~* 'unfortunately,? i (can''?t|cannot|don''?t|am not able)'
    OR content ~* 'i''?m (sorry|afraid),? (but )?i (don''?t|can''?t|cannot)'
    OR content ~* 'as an ai,? i (don''?t|can''?t|cannot)'
  );
