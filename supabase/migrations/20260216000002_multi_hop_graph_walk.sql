-- Multi-hop graph walk with temporal decay
--
-- Replaces the depth-0/1 hardcoded graph walk with WITH RECURSIVE traversal.
-- New params: p_max_depth (configurable hop count), p_max_intermediate (fan-out cap)
-- Temporal decay: recently-exercised connections rank higher than stale ones.
-- Backward compatible: old callers passing 3 args still work (new params have defaults).

-- Temporal decay helper: exponential decay based on age
-- Formula: 0.5 ^ (age_seconds / (half_life_days * 86400))
-- Examples: 30 days → ~0.79, 90 days → 0.50, 180 days → 0.25
CREATE OR REPLACE FUNCTION temporal_decay_factor(
  p_last_seen TIMESTAMPTZ,
  p_half_life_days INT DEFAULT 90
)
RETURNS FLOAT
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN p_last_seen IS NULL THEN 0.5  -- Unknown age gets half-life value
    ELSE POWER(0.5, EXTRACT(EPOCH FROM (NOW() - p_last_seen)) / (p_half_life_days * 86400.0))
  END;
$$;

-- Replace graph_walk_from_entities with recursive multi-hop version
-- Drop old signatures first to avoid overload conflicts
DROP FUNCTION IF EXISTS graph_walk_from_entities(UUID[], UUID, INT);

CREATE OR REPLACE FUNCTION graph_walk_from_entities(
  p_entity_ids UUID[],
  p_user_id UUID,
  p_max_results INT DEFAULT 10,
  p_max_depth INT DEFAULT 1,
  p_max_intermediate INT DEFAULT 20
)
RETURNS TABLE (
  chat_turn_id UUID,
  content TEXT,
  conversation_id TEXT,
  platform TEXT,
  start_timestamp BIGINT,
  traversal_depth INT,
  relationship_strength FLOAT,
  connected_entity_text TEXT,
  connected_entity_type TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN QUERY
  WITH RECURSIVE
  -- Seed: input entities at depth 0 with strength 1.0
  entity_walk(entity_id, depth, cumulative_strength) AS (
    -- Base case: seed entities
    SELECT unnest(p_entity_ids), 0, 1.0::FLOAT

    UNION ALL

    -- Recursive case: traverse relationships
    SELECT
      CASE
        WHEN er.entity_a_id = ew.entity_id THEN er.entity_b_id
        ELSE er.entity_a_id
      END,
      ew.depth + 1,
      -- Cumulative strength = parent strength * edge strength * temporal decay
      ew.cumulative_strength
        * er.relationship_strength
        * temporal_decay_factor(er.last_seen)
    FROM entity_walk ew
    JOIN entity_relationships er
      ON er.user_id = p_user_id
      AND (er.entity_a_id = ew.entity_id OR er.entity_b_id = ew.entity_id)
    WHERE ew.depth < p_max_depth
      -- Don't traverse back to seed entities
      AND CASE
        WHEN er.entity_a_id = ew.entity_id THEN er.entity_b_id
        ELSE er.entity_a_id
      END != ALL(p_entity_ids)
  ),

  -- Deduplicate entities: keep highest cumulative_strength per entity
  -- Cap at p_max_intermediate to control fan-out
  best_entities AS (
    SELECT DISTINCT ON (ew.entity_id)
      ew.entity_id,
      ew.depth,
      ew.cumulative_strength
    FROM entity_walk ew
    ORDER BY ew.entity_id, ew.cumulative_strength DESC
    LIMIT p_max_intermediate
  ),

  -- Resolve chat_turns via entity_mentions
  turn_results AS (
    SELECT
      ct.id AS chat_turn_id,
      ct.content,
      ct.conversation_id,
      ct.platform,
      ct.start_timestamp,
      be.depth AS traversal_depth,
      be.cumulative_strength AS relationship_strength,
      e.entity_text AS connected_entity_text,
      e.entity_type AS connected_entity_type
    FROM best_entities be
    JOIN entity_mentions em ON em.entity_id = be.entity_id
    JOIN chat_turns ct ON ct.id = em.chat_turn_id
    JOIN entities e ON e.id = be.entity_id
    WHERE ct.user_id = p_user_id
  ),

  -- Deduplicate chat_turns: keep highest relationship_strength
  deduped AS (
    SELECT DISTINCT ON (tr.chat_turn_id)
      tr.chat_turn_id,
      tr.content,
      tr.conversation_id,
      tr.platform,
      tr.start_timestamp,
      tr.traversal_depth,
      tr.relationship_strength,
      tr.connected_entity_text,
      tr.connected_entity_type
    FROM turn_results tr
    ORDER BY tr.chat_turn_id, tr.relationship_strength DESC, tr.traversal_depth ASC
  )

  SELECT * FROM deduped
  ORDER BY deduped.relationship_strength DESC
  LIMIT p_max_results;
END;
$$;

-- Grant execute for new signature
GRANT EXECUTE ON FUNCTION graph_walk_from_entities(UUID[], UUID, INT, INT, INT) TO authenticated;
GRANT EXECUTE ON FUNCTION graph_walk_from_entities(UUID[], UUID, INT, INT, INT) TO anon;

-- Grant execute on temporal_decay_factor (useful for debugging)
GRANT EXECUTE ON FUNCTION temporal_decay_factor(TIMESTAMPTZ, INT) TO authenticated;
GRANT EXECUTE ON FUNCTION temporal_decay_factor(TIMESTAMPTZ, INT) TO anon;
