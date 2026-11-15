-- Stop the keyword search from switching to a slow plan.
--
-- Symptom, recall set 2026-11-15: the keyword search timed out (4 s) on 1 to
-- 7 questions per run, including a question with two rare words that takes
-- under 0.2 s when run by hand.
--
-- Cause, confirmed with EXPLAIN under plan_cache_mode = force_generic_plan:
-- after a database connection has run the function a few times, Postgres
-- reuses one plan for every word. That plan cannot know how rare the word
-- is, so it reads all of the user's messages through the user index and
-- tests each one, instead of using the word index.
--
-- Fix: plan each call for the actual word. Planning costs a few milliseconds.

alter function public.keyword_turn_candidates(uuid, text[], int, uuid, uuid)
    set plan_cache_mode = force_custom_plan;
