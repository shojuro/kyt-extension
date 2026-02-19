-- Migration: Retroactive cleanup of existing chat_turns
-- Tags question-only turns and injection-polluted turns as is_question=true
-- so they are excluded from vector search via match_messages_with_gravity.

-- 1. Tag turns whose user content is a question (ends with ?)
UPDATE chat_turns SET is_question = true
WHERE content ~* '(^|\n)User:.*\?\s*$'
  AND is_question = false;

-- 2. Tag injection-polluted turns (KYT block stored as content)
-- These create recursive pollution and corrupt entity extraction
UPDATE chat_turns SET is_question = true
WHERE is_question = false
  AND (content LIKE '%K.Y.T.%Personal Knowledge Base%'
    OR content LIKE '%[RETRIEVAL_CONTEXT]%'
    OR content LIKE '%[SESSION_CONTEXT]%');

-- 3. Tag turns starting with interrogative words (without trailing ?)
UPDATE chat_turns SET is_question = true
WHERE is_question = false
  AND content ~* '(^|\n)User:\s*(what|who|where|when|why|how|which|is|are|was|were|do|does|did|can|could|would|will|shall|should|have|has|had|tell me|remind me|do you know|do you remember)\b[^\n]*$';
