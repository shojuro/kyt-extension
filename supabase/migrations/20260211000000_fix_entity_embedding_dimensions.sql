-- Migration: Ensure entities.embedding uses VECTOR(4096) to match Qwen3-Embedding-8B
-- The original entity_memory.sql created entities.embedding as VECTOR(1536) (OpenAI).
-- The alter_embedding_dimensions migration attempted to fix this conditionally,
-- but may not have been applied to the live DB. This migration is idempotent.

-- Unconditionally set entities.embedding to VECTOR(4096)
ALTER TABLE entities
  ALTER COLUMN embedding TYPE vector(4096);

-- Recreate search_entities_by_embedding to explicitly match VECTOR(4096)
CREATE OR REPLACE FUNCTION search_entities_by_embedding(
    query_embedding vector(4096),
    match_threshold float DEFAULT 0.8,
    match_count int DEFAULT 5,
    p_user_id UUID DEFAULT NULL
)
RETURNS TABLE (
    id UUID,
    entity_text TEXT,
    canonical_name TEXT,
    similarity FLOAT
)
LANGUAGE plpgsql STABLE
AS $$
BEGIN
    RETURN QUERY
    SELECT
        e.id,
        e.entity_text,
        e.canonical_name,
        (1 - (e.embedding <=> query_embedding))::FLOAT AS similarity
    FROM entities e
    WHERE
        e.user_id = p_user_id
        AND e.embedding IS NOT NULL
        AND (1 - (e.embedding <=> query_embedding)) > match_threshold
    ORDER BY e.embedding <=> query_embedding
    LIMIT match_count;
END;
$$;
