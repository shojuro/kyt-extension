-- Migration: Drop orphaned 5-param match_messages_with_gravity overload
-- The old 5-param version (without boost_entity_ids) lacks the is_question filter
-- added in 20260219000000_chat_turns_question_filter.sql. It could return question
-- turns if called directly or via match_messages_with_gravity_and_update.
-- The edge function (get_relevant_memories.ts) always passes boost_entity_ids,
-- resolving to the 6-param version, but the orphan should be removed for safety.

DROP FUNCTION IF EXISTS match_messages_with_gravity(vector, double precision, integer, integer, uuid);
