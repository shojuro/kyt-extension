-- Migration: Broaden deflection detection for missed patterns
-- Date: 2026-02-25
--
-- Problem: "I'm not sure exactly what 'KYT' refers to" and similar patterns
-- with adverbs between "not" and "sure" (exactly, really, entirely) bypassed
-- both the JS regex and the SQL backfill regex. These rows have deflection=NULL
-- and pass through RPC filters (deflection IS NULL OR deflection < 0.70).
--
-- Fix: Backfill deflection scores for rows matching the broadened pattern.
-- The JS regex in assistant-quality-detector.js line 48 was also updated
-- to prevent future misses at ingestion time.

-- Step 1: Backfill "I'm not [adverb] sure [adverb] what/how/if/about/which/when/where/why"
-- Catches: "I'm not sure exactly what", "I'm not really sure how", etc.
-- Allows adverb on either side of "sure".
-- Uses Postgres POSIX regex (~*). Note: \y is Postgres word boundary (\b is PCRE).
UPDATE chat_turns SET deflection = 0.80
WHERE deflection IS NULL
  AND content ~* 'I''?m not (?:really |entirely |exactly )?sure (?:really |entirely |exactly )?(?:what|how|if|about|which|when|where|why)';

-- Step 2: Backfill "Could/Can you give me [more] context/information/details"
-- Deferral pattern missing "give me" in the original regex (only had clarify/elaborate/etc.)
UPDATE chat_turns SET deflection = 0.80
WHERE deflection IS NULL
  AND content ~* '(?:could|can) you (?:please )?(?:give me|give us) (?:a bit )?(?:more|some|additional) (?:context|information|details)';
