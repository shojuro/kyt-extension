-- Fix ILIKE false positives in preference lookup with word-boundary regex
--
-- Problem: ILIKE '%' || p_category || '%' matches substrings:
--   "car" matches "car_color" (substring in category)
--   "car" matches "animals being taken care of" (substring "car" in "care")
--
-- Fix: PostgreSQL ~* with \m (word start) and \M (word end) anchors.
--   \mcar\M matches "car" as a whole word only.
--   Does NOT match "care" (\M fails — 'e' is a word char after 'r')
--   Does NOT match "car_color" (\M fails — '_' is a word char in PG regex)

CREATE OR REPLACE FUNCTION lookup_user_preferences(
    p_user_id UUID,
    p_category TEXT,
    p_limit INT DEFAULT 10
)
RETURNS TABLE (
    id UUID,
    category TEXT,
    value TEXT,
    sentiment TEXT,
    confidence FLOAT,
    source_turn_id UUID,
    source_content TEXT,
    created_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    RETURN QUERY
    SELECT DISTINCT ON (up.category, up.sentiment)
        up.id,
        up.category,
        up.value,
        up.sentiment,
        up.confidence,
        up.source_turn_id,
        ct.content AS source_content,
        up.created_at,
        up.updated_at
    FROM user_preferences up
    LEFT JOIN chat_turns ct ON ct.id = up.source_turn_id
    WHERE up.user_id = p_user_id
      AND (
          up.category ~* ('\m' || p_category || '\M')
          OR up.value ~* ('\m' || p_category || '\M')
      )
    ORDER BY up.category, up.sentiment, up.updated_at DESC
    LIMIT p_limit;
END;
$$;
