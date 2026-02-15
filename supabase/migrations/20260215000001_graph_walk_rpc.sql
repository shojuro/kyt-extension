-- Graph Walk RPC: Traverse entity relationships to find related chat_turns.
--
-- Given a set of entity IDs, finds:
-- Depth 0: Chat turns that directly mention these entities
-- Depth 1: Chat turns that mention entities RELATED to the input entities
--
-- Used by both edge (get_relevant_memories.ts) and legacy (browser-search.js)
-- retrieval pipelines to surface conceptually related content that vector
-- search alone would miss.

CREATE OR REPLACE FUNCTION graph_walk_from_entities(
  p_entity_ids UUID[],
  p_user_id UUID,
  p_max_results INT DEFAULT 10
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
  WITH
  -- Depth 0: Direct entity mentions
  depth0 AS (
    SELECT
      ct.id AS chat_turn_id,
      ct.content,
      ct.conversation_id,
      ct.platform,
      ct.start_timestamp,
      0 AS traversal_depth,
      1.0::FLOAT AS relationship_strength,
      e.entity_text AS connected_entity_text,
      e.entity_type AS connected_entity_type
    FROM entity_mentions em
    JOIN chat_turns ct ON ct.id = em.chat_turn_id
    JOIN entities e ON e.id = em.entity_id
    WHERE em.entity_id = ANY(p_entity_ids)
      AND ct.user_id = p_user_id
  ),

  -- Find related entities via entity_relationships (1-hop)
  related_entities AS (
    SELECT
      CASE
        WHEN er.entity_a_id = ANY(p_entity_ids) THEN er.entity_b_id
        ELSE er.entity_a_id
      END AS related_entity_id,
      er.relationship_strength
    FROM entity_relationships er
    WHERE er.user_id = p_user_id
      AND (er.entity_a_id = ANY(p_entity_ids) OR er.entity_b_id = ANY(p_entity_ids))
      -- Exclude self-references (entity already in input set)
      AND NOT (er.entity_a_id = ANY(p_entity_ids) AND er.entity_b_id = ANY(p_entity_ids))
  ),

  -- Depth 1: Mentions of related entities
  depth1 AS (
    SELECT
      ct.id AS chat_turn_id,
      ct.content,
      ct.conversation_id,
      ct.platform,
      ct.start_timestamp,
      1 AS traversal_depth,
      re.relationship_strength,
      e.entity_text AS connected_entity_text,
      e.entity_type AS connected_entity_type
    FROM related_entities re
    JOIN entity_mentions em ON em.entity_id = re.related_entity_id
    JOIN chat_turns ct ON ct.id = em.chat_turn_id
    JOIN entities e ON e.id = re.related_entity_id
    WHERE ct.user_id = p_user_id
  ),

  -- Union and deduplicate (keep highest relationship_strength per chat_turn)
  combined AS (
    SELECT DISTINCT ON (d.chat_turn_id)
      d.chat_turn_id,
      d.content,
      d.conversation_id,
      d.platform,
      d.start_timestamp,
      d.traversal_depth,
      d.relationship_strength,
      d.connected_entity_text,
      d.connected_entity_type
    FROM (
      SELECT * FROM depth0
      UNION ALL
      SELECT * FROM depth1
    ) d
    ORDER BY d.chat_turn_id, d.relationship_strength DESC, d.traversal_depth ASC
  )

  SELECT * FROM combined
  ORDER BY combined.relationship_strength DESC
  LIMIT p_max_results;
END;
$$;

-- Grant execute to authenticated users (RLS on chat_turns already filters by user_id)
GRANT EXECUTE ON FUNCTION graph_walk_from_entities(UUID[], UUID, INT) TO authenticated;
GRANT EXECUTE ON FUNCTION graph_walk_from_entities(UUID[], UUID, INT) TO anon;
