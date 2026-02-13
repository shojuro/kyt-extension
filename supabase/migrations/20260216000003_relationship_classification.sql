-- Relationship classification
--
-- Graph edges carry semantic meaning beyond co-occurrence count.
-- Adds relationship_type column to entity_relationships with types like:
-- family_of, works_with, illustrates, discussed_together, co_occurrence (default)

-- Add relationship_type column
ALTER TABLE entity_relationships
  ADD COLUMN IF NOT EXISTS relationship_type TEXT DEFAULT 'co_occurrence';

-- Index for filtering by relationship type
CREATE INDEX IF NOT EXISTS idx_relationships_type
  ON entity_relationships(relationship_type);

-- Update upsert_entity_relationship to accept relationship_type
-- On conflict: keep more-specific type (anything non-'co_occurrence' wins)
CREATE OR REPLACE FUNCTION upsert_entity_relationship(
  p_user_id UUID,
  p_entity_a UUID,
  p_entity_b UUID,
  p_relationship_type TEXT DEFAULT 'co_occurrence'
)
RETURNS VOID AS $$
DECLARE
  v_entity_a UUID;
  v_entity_b UUID;
BEGIN
  -- Ensure consistent ordering (smaller UUID first)
  IF p_entity_a < p_entity_b THEN
    v_entity_a := p_entity_a;
    v_entity_b := p_entity_b;
  ELSE
    v_entity_a := p_entity_b;
    v_entity_b := p_entity_a;
  END IF;

  INSERT INTO entity_relationships (
    user_id, entity_a_id, entity_b_id,
    co_occurrence_count, relationship_strength,
    first_seen, last_seen, relationship_type
  )
  VALUES (
    p_user_id, v_entity_a, v_entity_b,
    1, LEAST(1.0, 1.0 / 20.0),
    NOW(), NOW(), p_relationship_type
  )
  ON CONFLICT (user_id, entity_a_id, entity_b_id) DO UPDATE SET
    co_occurrence_count = entity_relationships.co_occurrence_count + 1,
    relationship_strength = LEAST(1.0, (entity_relationships.co_occurrence_count + 1)::FLOAT / 20.0),
    last_seen = NOW(),
    -- Keep more-specific type: if new type is non-default, use it; otherwise keep existing
    relationship_type = CASE
      WHEN p_relationship_type != 'co_occurrence' THEN p_relationship_type
      ELSE entity_relationships.relationship_type
    END;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Grant for new 4-arg signature
GRANT EXECUTE ON FUNCTION upsert_entity_relationship(UUID, UUID, UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION upsert_entity_relationship(UUID, UUID, UUID, TEXT) TO anon;
