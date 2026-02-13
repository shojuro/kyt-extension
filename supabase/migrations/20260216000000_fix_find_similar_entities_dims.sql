-- Fix find_similar_entities: VECTOR(1536) → VECTOR(4096)
--
-- Entity embeddings use Qwen3-Embedding-8B (4096 dimensions) since the
-- Nov 27 entity_search_rpcs migration, but find_similar_entities was
-- never updated from the original 1536-dim (OpenAI text-embedding-3-small).
-- Entity resolution (Phase 5) depends on this RPC working correctly.

CREATE OR REPLACE FUNCTION find_similar_entities(
    p_user_id UUID,
    p_entity_type TEXT,
    p_embedding VECTOR(4096),
    p_canonical_name TEXT,
    p_similarity_threshold FLOAT DEFAULT 0.85
)
RETURNS TABLE (
    id UUID,
    entity_text TEXT,
    canonical_name TEXT,
    mention_count INT,
    last_seen TIMESTAMPTZ,
    similarity FLOAT
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        e.id,
        e.entity_text,
        e.canonical_name,
        e.mention_count,
        e.last_seen,
        1 - (e.embedding <=> p_embedding) AS similarity
    FROM entities e
    WHERE e.user_id = p_user_id
      AND e.entity_type = p_entity_type
      AND e.canonical_name != p_canonical_name
      AND e.embedding IS NOT NULL
      AND 1 - (e.embedding <=> p_embedding) >= p_similarity_threshold
    ORDER BY e.embedding <=> p_embedding
    LIMIT 5;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Re-grant permissions (function signature changed)
GRANT EXECUTE ON FUNCTION find_similar_entities(UUID, TEXT, VECTOR(4096), TEXT, FLOAT) TO authenticated;
GRANT EXECUTE ON FUNCTION find_similar_entities(UUID, TEXT, VECTOR(4096), TEXT, FLOAT) TO anon;
