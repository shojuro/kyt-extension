-- Migration: Temporal decay half-life 90→180 days + logarithmic relationship strength
--
-- Issue #13: Personal knowledge (people, books, places) retains relevance longer.
-- Half-life 180d means: 90 days → ~0.71 (was 0.50), 180 days → 0.50 (was 0.25)
--
-- Issue #14: Linear count/20 scaling is too slow at low counts and too generous at high.
-- Log-scale: ln(count+1)/ln(11) → 1 mention=0.29, 3=0.58, 5=0.75, 10=1.0

-- ── Issue #13: Update temporal_decay_factor default half-life ─────────────
CREATE OR REPLACE FUNCTION temporal_decay_factor(
  p_last_seen TIMESTAMPTZ,
  p_half_life_days INT DEFAULT 180
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

-- ── Issue #14: Update upsert_entity_relationship to use log-scale strength ──
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
    1, LEAST(1.0, LN(2) / LN(11)),
    NOW(), NOW(), p_relationship_type
  )
  ON CONFLICT (user_id, entity_a_id, entity_b_id) DO UPDATE SET
    co_occurrence_count = entity_relationships.co_occurrence_count + 1,
    relationship_strength = LEAST(1.0, LN(entity_relationships.co_occurrence_count + 2) / LN(11)),
    last_seen = NOW(),
    -- Keep more-specific type: if new type is non-default, use it; otherwise keep existing
    relationship_type = CASE
      WHEN p_relationship_type != 'co_occurrence' THEN p_relationship_type
      ELSE entity_relationships.relationship_type
    END;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Grant execute for updated signatures
GRANT EXECUTE ON FUNCTION upsert_entity_relationship(UUID, UUID, UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION upsert_entity_relationship(UUID, UUID, UUID, TEXT) TO anon;
GRANT EXECUTE ON FUNCTION temporal_decay_factor(TIMESTAMPTZ, INT) TO authenticated;
GRANT EXECUTE ON FUNCTION temporal_decay_factor(TIMESTAMPTZ, INT) TO anon;

-- ── Backfill existing rows with log-scale strength ──────────────────────
UPDATE entity_relationships
SET relationship_strength = LEAST(1.0, LN(co_occurrence_count + 1) / LN(11));
