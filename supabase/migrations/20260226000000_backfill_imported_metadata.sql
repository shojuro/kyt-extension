-- ============================================================
-- Retroactive backfill for imported chat_turns metadata
-- Ship List Item 7: Onboarding Backfill
--
-- Applies classification that import_conversation_batch now does inline:
-- 1. content_type = 'imported' for rows from import batches
-- 2. is_question for user-only turns matching question patterns
-- 3. deflection for assistant-only turns matching deflection patterns
-- 4. conversations table records for imported conversations
-- ============================================================

-- 1. Tag previously imported rows with content_type = 'imported'
-- Imported rows have import_progress records or were inserted via import_conversation_batch
-- (they have entities_extracted IS NULL or FALSE, and hypothetical_questions is not null)
-- Most reliable signal: rows whose user_id has import_progress records + entities_extracted not yet true
UPDATE public.chat_turns
SET content_type = 'imported'
WHERE content_type = 'conversation'  -- Only touch default, not already-tagged rows
  AND entities_extracted IS NOT TRUE
  AND user_id IN (
    SELECT DISTINCT user_id FROM public.import_progress
  )
  AND created_at > NOW() - INTERVAL '95 days';  -- Import window is 90 days + buffer

-- 2. Classify questions for user-only turns that haven't been classified yet
-- Uses Postgres POSIX regex (\y = word boundary, not \b)
-- Matches INTERROGATIVE_RE patterns from save_chat_turn_batch
UPDATE public.chat_turns
SET is_question = true
WHERE is_question IS NULL
  AND content_type = 'imported'
  AND speakers = ARRAY['user']  -- Single-speaker user chunks only
  AND (
    -- Ends with question mark
    content ~ '\?$'
    -- OR starts with interrogative/imperative word
    OR content ~* '^\y(what|who|where|when|why|how|which|is|are|was|were|do|does|did|can|could|would|will|shall|should|have|has|had|tell me|remind me|do you know|do you remember|list|name|give|show|find|get|provide|suggest|recommend|describe|explain|identify|compare|summarize|rank)\y'
  );

-- 3. Classify deflections for assistant-only turns that haven't been classified yet
UPDATE public.chat_turns
SET deflection = 0.80
WHERE deflection IS NULL
  AND content_type = 'imported'
  AND speakers = ARRAY['assistant']  -- Single-speaker assistant chunks only
  AND content ~* '(I don''?t (have|think|recall|remember|see|know)|I''?m not (really |entirely |exactly )?sure (really |entirely |exactly )?(what|how|if|about|which|when|where|why)|I can''?t (find|recall|remember|see)|no (specific|particular|clear).{0,30}(record|memory|data|information)|not (aware|certain) (of|about|whether)|could you (give|provide|share)|can you (give|provide|share))';

-- 4. Backfill conversations table for imported conversations not yet tracked
INSERT INTO public.conversations (external_id, user_id, platform, turn_count, first_message_at, last_message_at, is_imported)
SELECT
  conversation_id,
  user_id,
  platform,
  COUNT(*),
  MIN(to_timestamp(start_timestamp / 1000.0)),
  MAX(to_timestamp(end_timestamp / 1000.0)),
  true
FROM public.chat_turns
WHERE content_type = 'imported'
  AND conversation_id IS NOT NULL
  AND user_id IN (SELECT id FROM auth.users)  -- Skip orphan fallback UUIDs
GROUP BY conversation_id, user_id, platform
ON CONFLICT (user_id, external_id, platform)
DO UPDATE SET
  turn_count = EXCLUDED.turn_count,
  last_message_at = GREATEST(public.conversations.last_message_at, EXCLUDED.last_message_at),
  is_imported = true;
