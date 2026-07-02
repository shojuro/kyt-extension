-- Keyword-augmented candidate pool — PRECISION variant (Track 1).
--
-- The universal keyword pool (reverted) was net-flat: it captured a real
-- single-session-user +24 (buried user-turn evidence) but crashed preference
-- (synthesis answers) and regressed assistant. Precision gating targets the win:
--   (1) user-speaker turns only — the win is buried USER-turn evidence; excluding
--       assistant turns removes noise on "what did you suggest" (assistant) queries;
--   (2) strong co-occurrence (filtered in get_relevant_memories: a turn must contain
--       >= max(2, ceil(0.6*nkeywords)) distinct query keywords) — a synthesis query
--       ("what kind of response would I prefer") has no single turn matching all its
--       terms, so nothing injects and preference is left untouched.
--
-- This RPC returns user-speaker keyword matches ranked by full-text relevance;
-- the co-occurrence filter is applied caller-side (it needs the raw content).

CREATE OR REPLACE FUNCTION search_turns_by_keywords(
    p_user_id uuid,
    p_query text,
    p_limit int DEFAULT 30,
    p_profile_id uuid DEFAULT NULL
)
RETURNS TABLE(
    id uuid, content text, contextual_content text, conversation_id text,
    speakers text[], created_at timestamptz, gravity_score double precision,
    platform text, keyword_rank real
)
LANGUAGE sql STABLE AS $$
    SELECT ct.id, ct.content, ct.contextual_content, ct.conversation_id,
        ct.speakers, ct.created_at, COALESCE(ct.gravity_score, 0)::double precision,
        ct.platform,
        ts_rank(to_tsvector('english', ct.content), websearch_to_tsquery('english', p_query)) AS keyword_rank
    FROM chat_turns ct
    WHERE ct.user_id = p_user_id
      AND 'user' = ANY(ct.speakers)                    -- user-turn evidence only
      AND ct.embedding IS NOT NULL
      AND (ct.is_question IS NOT TRUE)
      AND (ct.deflection < 0.70 OR ct.deflection IS NULL)
      AND (ct.exclude_from_search IS NOT TRUE)
      AND (ct.is_injection IS NOT TRUE)
      AND (p_profile_id IS NULL OR ct.profile_id = p_profile_id)
      AND websearch_to_tsquery('english', p_query) @@ to_tsvector('english', ct.content)
    ORDER BY keyword_rank DESC
    LIMIT p_limit;
$$;

CREATE INDEX IF NOT EXISTS idx_chat_turns_content_fts
    ON chat_turns USING gin (to_tsvector('english', content));
