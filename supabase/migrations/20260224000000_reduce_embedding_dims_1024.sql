-- Migration: Reduce embedding dimensions from 4096 to 1024 + HNSW indexing
--
-- WHY: pgvector 0.8.0 caps HNSW/IVFFlat indexes at 2000 dims for vector type.
-- Our 4096-dim embeddings forced sequential scans (2-8s per query on ~4,900 rows).
--
-- HOW: Qwen3-Embedding-8B supports Matryoshka Representation Learning (MRL).
-- The first 1024 dimensions of the 4096-dim vector form a valid embedding with
-- ~3-5% MTEB quality loss — invisible behind our 6-layer retrieval pipeline.
-- Client-side truncation + L2-normalization is already applied in code before
-- this migration runs.
--
-- DOWNTIME: After this migration, ALL existing embeddings are NULL until backfill
-- completes (~50 minutes for ~4,900 rows). New data syncs correctly immediately.

-- ============================================================================
-- Step 0: Drop view that depends on chat_turns.embedding
-- (Must drop before ALTER COLUMN; will recreate after)
-- ============================================================================
DROP VIEW IF EXISTS chat_turns_free;

-- ============================================================================
-- Step 1: NULL out all existing embeddings
-- (4096-dim vectors cannot be cast to 1024-dim; must re-embed from scratch)
-- ============================================================================
UPDATE chat_turns SET embedding = NULL WHERE embedding IS NOT NULL;
UPDATE entities SET embedding = NULL WHERE embedding IS NOT NULL;
UPDATE messages SET embedding = NULL WHERE embedding IS NOT NULL;

-- ============================================================================
-- Step 2: Alter column types from vector(4096) to vector(1024)
-- ============================================================================
ALTER TABLE chat_turns ALTER COLUMN embedding TYPE vector(1024);
ALTER TABLE entities ALTER COLUMN embedding TYPE vector(1024);
ALTER TABLE messages ALTER COLUMN embedding TYPE vector(1024);

-- ============================================================================
-- Step 2b: Recreate chat_turns_free view with updated column type
-- ============================================================================
CREATE VIEW chat_turns_free AS
  SELECT id,
    turn_range,
    conversation_id,
    platform,
    content,
    speakers,
    turn_count,
    start_timestamp,
    end_timestamp,
    topics,
    hypothetical_questions,
    embedding,
    created_at
  FROM chat_turns
  WHERE platform = 'chatgpt' AND user_id = auth.uid();

-- Re-grant permissions on the view
GRANT ALL ON chat_turns_free TO authenticated;
GRANT ALL ON chat_turns_free TO anon;
GRANT ALL ON chat_turns_free TO service_role;
GRANT ALL ON chat_turns_free TO postgres;

-- ============================================================================
-- Step 3: Recreate match_messages_with_gravity with vector(1024) parameter
-- (Latest version from 20260223100000, with contextual_content, question/deflection filters)
-- ============================================================================
DROP FUNCTION IF EXISTS match_messages_with_gravity(vector(4096), float, int, int, UUID, UUID[]);

CREATE OR REPLACE FUNCTION match_messages_with_gravity(
  query_embedding vector(1024),
  match_threshold float DEFAULT 0.5,
  match_count int DEFAULT 10,
  exclude_recent_seconds int DEFAULT 120,
  p_user_id UUID DEFAULT NULL,
  boost_entity_ids UUID[] DEFAULT NULL
)
RETURNS TABLE (
  id UUID,
  content TEXT,
  contextual_content TEXT,
  turn_range TEXT,
  conversation_id TEXT,
  speakers TEXT[],
  topics TEXT[],
  created_at TIMESTAMPTZ,
  vector_similarity FLOAT,
  gravity_score FLOAT,
  impact_score INT,
  intimacy_level INT,
  access_count INT,
  last_accessed TIMESTAMPTZ,
  entity_boost BOOLEAN
) AS $$
BEGIN
  IF match_threshold < 0 OR match_threshold > 1 THEN
    RAISE EXCEPTION 'match_threshold must be between 0 and 1, got %', match_threshold;
  END IF;

  IF match_count < 1 OR match_count > 100 THEN
    RAISE EXCEPTION 'match_count must be between 1 and 100, got %', match_count;
  END IF;

  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'user_id is required for security (RLS enforcement)';
  END IF;

  RETURN QUERY
  SELECT
    ct.id,
    ct.content,
    ct.contextual_content,
    ct.turn_range,
    ct.conversation_id,
    ct.speakers,
    ct.topics,
    ct.created_at::TIMESTAMPTZ,
    (1 - (ct.embedding <=> query_embedding))::FLOAT AS vector_similarity,
    calculate_gravity_score(
      1 - (ct.embedding <=> query_embedding),
      COALESCE(ct.impact_score, 0),
      COALESCE(ct.intimacy_level, 0),
      ct.created_at::TIMESTAMPTZ,
      COALESCE(ct.last_accessed, ct.created_at::TIMESTAMPTZ),
      COALESCE(ct.access_count, 0)
    )::FLOAT AS gravity_score,
    ct.impact_score::INT,
    ct.intimacy_level::INT,
    ct.access_count,
    ct.last_accessed,
    CASE
      WHEN boost_entity_ids IS NOT NULL AND EXISTS (
        SELECT 1 FROM entity_mentions em
        WHERE em.chat_turn_id = ct.id
        AND em.entity_id = ANY(boost_entity_ids)
      ) THEN TRUE
      ELSE FALSE
    END AS entity_boost
  FROM chat_turns ct
  WHERE
    ct.user_id = p_user_id
    AND (1 - (ct.embedding <=> query_embedding)) > match_threshold
    AND ct.created_at < NOW() - (exclude_recent_seconds || ' seconds')::INTERVAL
    AND (ct.is_question IS NULL OR ct.is_question = FALSE)
    AND (ct.deflection IS NULL OR ct.deflection < 0.70)
  ORDER BY
    gravity_score DESC NULLS LAST
  LIMIT match_count;
END;
$$ LANGUAGE plpgsql STABLE;

-- ============================================================================
-- Step 4: Recreate search_entities_by_embedding with vector(1024) parameter
-- (From 20251127000001, stable since creation)
-- ============================================================================
DROP FUNCTION IF EXISTS search_entities_by_embedding(vector(4096), float, int, UUID);

CREATE OR REPLACE FUNCTION search_entities_by_embedding(
  query_embedding vector(1024),
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
    AND (1 - (e.embedding <=> query_embedding)) > match_threshold
  ORDER BY e.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

-- ============================================================================
-- Step 5: Recreate match_messages_v2 with vector(1024) parameter
-- (From 20260218000000, with is_question filter)
-- ============================================================================
DROP FUNCTION IF EXISTS match_messages_v2(vector(4096), float, int, jsonb, bigint);

CREATE OR REPLACE FUNCTION match_messages_v2(
  query_embedding vector(1024),
  match_threshold float DEFAULT 0.6,
  match_count int DEFAULT 5,
  filter jsonb DEFAULT '{}'::jsonb,
  min_timestamp bigint DEFAULT 0
)
RETURNS TABLE (
  id uuid,
  content text,
  role text,
  conversation_id text,
  model text,
  msg_timestamp bigint,
  message_id text,
  source text,
  created_at timestamp,
  synced_from_extension timestamp,
  embedding vector(1024),
  distance float
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    m.id,
    m.content,
    m.role,
    m.conversation_id,
    m.model,
    m."timestamp" as msg_timestamp,
    m.message_id,
    m.source,
    m.created_at,
    m.synced_from_extension,
    m.embedding,
    (m.embedding <=> query_embedding) as distance
  FROM public.messages m
  WHERE (m.embedding <=> query_embedding) < match_threshold
    AND (min_timestamp = 0 OR m."timestamp" >= min_timestamp)
    AND (filter->>'role' IS NULL OR m.role = filter->>'role')
    AND (filter->>'source' IS NULL OR m.source = filter->>'source')
    AND (filter->>'conversation_id' IS NULL OR m.conversation_id = filter->>'conversation_id')
    AND (filter->>'user_id' IS NULL OR m.user_id = (filter->>'user_id')::uuid)
    AND (m.is_question IS NULL OR m.is_question = FALSE)
  ORDER BY m.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

-- ============================================================================
-- Step 6: Create HNSW indexes (now possible at 1024 dims!)
-- m=16: moderate connectivity (good recall/speed tradeoff for <10K rows)
-- ef_construction=64: standard build quality
-- ============================================================================
CREATE INDEX IF NOT EXISTS idx_chat_turns_embedding_hnsw
  ON chat_turns USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

CREATE INDEX IF NOT EXISTS idx_entities_embedding_hnsw
  ON entities USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- Note: messages table does not get HNSW index — it's the legacy table,
-- chat_turns is the primary search target. messages.match_messages_v2 is
-- only used as a fallback path and has ~1.3K rows.

-- ============================================================================
-- Step 7: Re-apply statement timeouts (from 20260223100001)
-- These survive ALTER FUNCTION but DROP+CREATE removes them.
-- ============================================================================
ALTER FUNCTION match_messages_with_gravity SET statement_timeout = '45s';
ALTER FUNCTION graph_walk_from_entities SET statement_timeout = '30s';
ALTER FUNCTION get_newest_turns_for_entities SET statement_timeout = '15s';

-- ============================================================================
-- Step 8: Re-grant permissions (DROP removes grants)
-- ============================================================================
GRANT EXECUTE ON FUNCTION match_messages_with_gravity(vector(1024), float, int, int, UUID, UUID[]) TO authenticated;
GRANT EXECUTE ON FUNCTION match_messages_with_gravity(vector(1024), float, int, int, UUID, UUID[]) TO anon;
GRANT EXECUTE ON FUNCTION search_entities_by_embedding(vector(1024), float, int, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION search_entities_by_embedding(vector(1024), float, int, UUID) TO anon;
GRANT EXECUTE ON FUNCTION match_messages_v2(vector(1024), float, int, jsonb, bigint) TO authenticated;
GRANT EXECUTE ON FUNCTION match_messages_v2(vector(1024), float, int, jsonb, bigint) TO anon;
