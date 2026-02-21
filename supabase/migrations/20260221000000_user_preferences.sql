-- Migration: user_preferences table + lookup RPC
-- Purpose: Structured preference storage for query router short-circuit
-- Date: 2026-02-21

-- =============================================================================
-- TABLE: user_preferences
-- Stores extracted user preferences (favorite car, food, etc.) as structured data
-- =============================================================================
CREATE TABLE IF NOT EXISTS user_preferences (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    category TEXT NOT NULL,         -- 'car', 'food', 'color', 'programming_language'
    value TEXT NOT NULL,            -- 'Lamborghini', 'sushi', 'blue', 'Python'
    sentiment TEXT NOT NULL DEFAULT 'positive'
        CHECK (sentiment IN ('positive', 'negative', 'neutral')),
    confidence FLOAT NOT NULL DEFAULT 0.8
        CHECK (confidence >= 0.0 AND confidence <= 1.0),
    source_turn_id UUID REFERENCES chat_turns(id) ON DELETE SET NULL,
    entity_id UUID REFERENCES entities(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT unique_user_pref UNIQUE(user_id, category, value)
);

-- Indexes for fast lookup
CREATE INDEX IF NOT EXISTS idx_user_preferences_user_category
    ON user_preferences(user_id, category);
CREATE INDEX IF NOT EXISTS idx_user_preferences_updated
    ON user_preferences(updated_at DESC);

-- =============================================================================
-- RLS: Only owner can read/write their own preferences
-- =============================================================================
ALTER TABLE user_preferences ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own preferences"
    ON user_preferences FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own preferences"
    ON user_preferences FOR INSERT
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own preferences"
    ON user_preferences FOR UPDATE
    USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own preferences"
    ON user_preferences FOR DELETE
    USING (auth.uid() = user_id);

-- =============================================================================
-- RPC: lookup_user_preferences
-- SECURITY DEFINER so edge functions (service role) can query on behalf of user.
-- Searches BOTH category and value columns so:
--   "what's my favorite car?"  → matches category='car'
--   "do I like Python?"        → matches value='Python'
-- =============================================================================
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
    SELECT
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
    ORDER BY up.updated_at DESC
    LIMIT p_limit;
END;
$$;

-- =============================================================================
-- BACKFILL TRACKING: Add preferences_extracted column to chat_turns
-- =============================================================================
ALTER TABLE chat_turns ADD COLUMN IF NOT EXISTS preferences_extracted BOOLEAN;
