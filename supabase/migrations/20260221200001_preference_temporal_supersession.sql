-- Preference temporal supersession: dedup by (category, sentiment)
--
-- Problem: When user has 3 "car" preferences (red Lamborghini, Lamborghini FenoMeno,
-- red Lamborghinis), all 3 get injected. Even after "Bugatti" is extracted, old entries
-- appear alongside it — the AI must guess which is current.
--
-- Fix: DISTINCT ON (category, sentiment) returns only the most recently updated
-- preference per (category, sentiment) pair. "Favorite car" → 1 result (newest positive).
-- "Disliked car" → 1 result (newest negative). Multiple categories each get their own entry.
--
-- NOTE: source_content included for debugging/admin only.
-- Must NOT be sent to AI (feedback loop risk).

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
          up.category ILIKE '%' || p_category || '%'
          OR up.value ILIKE '%' || p_category || '%'
      )
    ORDER BY up.category, up.sentiment, up.updated_at DESC
    LIMIT p_limit;
END;
$$;
