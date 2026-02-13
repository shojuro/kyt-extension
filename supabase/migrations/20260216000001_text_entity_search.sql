-- Text-based entity search fallback
--
-- When embedding-based entity search returns 0 results, fall back to
-- trigram/keyword text matching on entity names. This directly fixes
-- the "walking analogy" → walking_analogy_for_learning lookup problem.

-- Enable pg_trgm for fuzzy text matching
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- GIN trigram indexes for fast text search on entity name fields
CREATE INDEX IF NOT EXISTS idx_entities_canonical_name_trgm
  ON entities USING GIN (canonical_name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_entities_normalized_name_trgm
  ON entities USING GIN (normalized_name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_entities_entity_text_trgm
  ON entities USING GIN (entity_text gin_trgm_ops);

-- search_entities_by_text: trigram + keyword fallback for entity lookup
--
-- Search strategy (in priority order):
-- 1. Trigram similarity on canonical_name, normalized_name, entity_text
-- 2. ILIKE substring match on all three fields
-- 3. Individual keyword matching against canonical_name (underscored tokens)
--
-- Returns same shape as search_entities_by_embedding plus entity_type, normalized_name
CREATE OR REPLACE FUNCTION search_entities_by_text(
  p_query_text TEXT,
  p_user_id UUID,
  p_match_count INT DEFAULT 5
)
RETURNS TABLE (
  id UUID,
  entity_text TEXT,
  canonical_name TEXT,
  normalized_name TEXT,
  entity_type TEXT,
  mention_count INT,
  last_seen TIMESTAMPTZ,
  similarity FLOAT
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_query_lower TEXT;
  v_query_underscored TEXT;
BEGIN
  -- Normalize query for matching
  v_query_lower := LOWER(TRIM(p_query_text));
  -- Convert spaces to underscores to match canonical_name format
  v_query_underscored := REPLACE(v_query_lower, ' ', '_');

  RETURN QUERY
  WITH
  -- Strategy 1: Trigram similarity (best for fuzzy matches)
  trgm_matches AS (
    SELECT
      e.id,
      e.entity_text,
      e.canonical_name,
      e.normalized_name,
      e.entity_type::TEXT,
      e.mention_count,
      e.last_seen,
      GREATEST(
        similarity(e.canonical_name, v_query_underscored),
        similarity(e.normalized_name, v_query_underscored),
        similarity(e.entity_text, v_query_lower)
      ) AS sim
    FROM entities e
    WHERE e.user_id = p_user_id
      AND (
        similarity(e.canonical_name, v_query_underscored) > 0.15
        OR similarity(e.normalized_name, v_query_underscored) > 0.15
        OR similarity(e.entity_text, v_query_lower) > 0.15
      )
  ),

  -- Strategy 2: ILIKE substring (catches partial matches)
  ilike_matches AS (
    SELECT
      e.id,
      e.entity_text,
      e.canonical_name,
      e.normalized_name,
      e.entity_type::TEXT,
      e.mention_count,
      e.last_seen,
      0.3::FLOAT AS sim  -- Fixed score for substring matches
    FROM entities e
    WHERE e.user_id = p_user_id
      AND e.id NOT IN (SELECT tm.id FROM trgm_matches tm)
      AND (
        e.canonical_name ILIKE '%' || v_query_underscored || '%'
        OR e.normalized_name ILIKE '%' || v_query_underscored || '%'
        OR e.entity_text ILIKE '%' || v_query_lower || '%'
      )
  ),

  -- Strategy 3: Keyword splitting (matches individual words against canonical_name tokens)
  -- Split query into words, match each against canonical_name
  keyword_matches AS (
    SELECT
      e.id,
      e.entity_text,
      e.canonical_name,
      e.normalized_name,
      e.entity_type::TEXT,
      e.mention_count,
      e.last_seen,
      -- Score = fraction of query keywords found in canonical_name
      (
        SELECT COUNT(*)::FLOAT / GREATEST(array_length(string_to_array(v_query_lower, ' '), 1), 1)
        FROM unnest(string_to_array(v_query_lower, ' ')) AS kw
        WHERE LENGTH(kw) >= 3
          AND e.canonical_name ILIKE '%' || REPLACE(kw, ' ', '_') || '%'
      ) * 0.5 AS sim  -- Scale keyword matches to max 0.5
    FROM entities e
    WHERE e.user_id = p_user_id
      AND e.id NOT IN (SELECT tm.id FROM trgm_matches tm)
      AND e.id NOT IN (SELECT im.id FROM ilike_matches im)
      AND EXISTS (
        SELECT 1
        FROM unnest(string_to_array(v_query_lower, ' ')) AS kw
        WHERE LENGTH(kw) >= 3
          AND e.canonical_name ILIKE '%' || REPLACE(kw, ' ', '_') || '%'
      )
  ),

  -- Combine all strategies
  all_matches AS (
    SELECT * FROM trgm_matches
    UNION ALL
    SELECT * FROM ilike_matches
    UNION ALL
    SELECT * FROM keyword_matches
  ),

  -- Deduplicate by entity id, keep highest similarity
  deduped AS (
    SELECT DISTINCT ON (am.id)
      am.id,
      am.entity_text,
      am.canonical_name,
      am.normalized_name,
      am.entity_type,
      am.mention_count,
      am.last_seen,
      am.sim AS similarity
    FROM all_matches am
    ORDER BY am.id, am.sim DESC
  )

  SELECT d.id, d.entity_text, d.canonical_name, d.normalized_name,
         d.entity_type, d.mention_count, d.last_seen, d.similarity
  FROM deduped d
  ORDER BY d.similarity DESC, d.mention_count DESC
  LIMIT p_match_count;
END;
$$;

GRANT EXECUTE ON FUNCTION search_entities_by_text(TEXT, UUID, INT) TO authenticated;
GRANT EXECUTE ON FUNCTION search_entities_by_text(TEXT, UUID, INT) TO anon;
