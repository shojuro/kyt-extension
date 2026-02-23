-- Backfill: reclassify imperative requests as questions + detect deflections
-- Follows SELECT-before-UPDATE pattern per third-party review recommendation.
--
-- Run the SELECT previews via execute_sql first to verify matches before applying.

-- Step 1: Reclassify imperative requests as questions
-- These are user-role turns starting with action verbs (list, show, find, etc.)
-- that the original INTERROGATIVE_RE missed.
UPDATE chat_turns SET is_question = true
WHERE is_question = false
  AND content ~* '^(User:\s*)?(list|name|give|show|find|get|provide|suggest|recommend|describe|explain|identify|compare|summarize|rank|top (\d+|one|two|three|four|five|six|seven|eight|nine|ten))\y';

-- Step 2: Short-content heuristic OMITTED from backfill.
-- The <60 char / no-period / no-exclamation rule catches factual statements
-- like "my favorite car is a jeep wrangler" — these must stay searchable.
-- The heuristic is applied only at ingestion time (detectIsQuestion in
-- save_chat_turn_batch + background.js) where we have the actual turn role.

-- Step 3: Set deflection scores on matching assistant responses
-- These are "I don't have/recall/know" patterns from assistant deflections
UPDATE chat_turns SET deflection = 0.80
WHERE deflection IS NULL
  AND content ~* '(?:I don''t (?:have|think|recall|remember|see|know)|I''m not (?:sure|aware|certain)|I can''t (?:find|recall|remember|see)|no (?:specific|particular|clear).{0,30}(?:record|memory|data|information)|not (?:aware|certain) (?:of|about|whether))';
