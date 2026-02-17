-- Migration: Entity Timeline Guarantee RPC
-- Date: 2026-02-17
--
-- Purpose: For each entity in a candidate set, ensure the most recent chat_turn
-- mentioning that entity is included in retrieval results.
-- This prevents the "Jerry problem" where semantic search returns an older,
-- richer document instead of the newest factual correction.
--
-- Usage: Called by get_relevant_memories.ts after vector search + RRF merge.
-- Input: list of entity IDs + list of already-retrieved chat_turn IDs
-- Output: newest chat_turns per entity that are NOT already in the candidate set

CREATE OR REPLACE FUNCTION get_newest_turns_for_entities(
    p_entity_ids UUID[],
    p_user_id UUID,
    p_exclude_turn_ids UUID[] DEFAULT '{}'::UUID[],
    p_max_per_entity INT DEFAULT 1
)
RETURNS TABLE (
    chat_turn_id UUID,
    content TEXT,
    created_at TIMESTAMP,
    entity_id UUID,
    canonical_name TEXT,
    entity_type TEXT
)
LANGUAGE plpgsql STABLE
AS $$
BEGIN
    RETURN QUERY
    WITH ranked_mentions AS (
        SELECT
            em.chat_turn_id,
            ct.content,
            ct.created_at,
            em.entity_id,
            e.canonical_name,
            e.entity_type,
            ROW_NUMBER() OVER (
                PARTITION BY em.entity_id
                ORDER BY ct.created_at DESC
            ) AS rn
        FROM entity_mentions em
        JOIN chat_turns ct ON ct.id = em.chat_turn_id
        JOIN entities e ON e.id = em.entity_id
        WHERE em.entity_id = ANY(p_entity_ids)
          AND ct.user_id = p_user_id
          AND em.chat_turn_id != ALL(p_exclude_turn_ids)
    )
    SELECT
        rm.chat_turn_id,
        rm.content,
        rm.created_at,
        rm.entity_id,
        rm.canonical_name,
        rm.entity_type
    FROM ranked_mentions rm
    WHERE rm.rn <= p_max_per_entity;
END;
$$;

COMMENT ON FUNCTION get_newest_turns_for_entities IS
    'Entity timeline guarantee: returns the most recent chat_turn per entity that is not already in the candidate set. '
    'Prevents semantic search bias toward long/rich content from hiding short factual corrections.';
