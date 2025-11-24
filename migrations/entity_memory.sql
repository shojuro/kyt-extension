-- ============================================
-- KYT Entity Memory Database Schema
-- ============================================
-- Purpose: Store extracted entities, mentions, and relationships for entity-aware search
-- Date: 2025-11-25
--
-- CORRECTIONS FROM ORIGINAL SPEC:
-- - Fixed embedding dimensions: 384 → 1536 (matches OpenAI text-embedding-3-small)
-- - Fixed foreign keys: References chat_turns (exists) not conversations (doesn't exist)
-- - Added missing DELETE policy for entity_relationships
-- - Removed hybrid_search_with_entities (depends on unimplemented FTS)
-- - Updated entity_mentions to reference chat_turns.id (UUID) instead of conversation_id (TEXT)
--
-- ARCHITECTURE:
-- - entities: Canonical deduplicated entities (people, orgs, locations, etc.)
-- - entity_mentions: Individual occurrences of entities in chat turns
-- - entity_relationships: Co-occurrence tracking between entities
-- - All tables have RLS for multi-tenant isolation

-- ============================================
-- ENABLE REQUIRED EXTENSIONS
-- ============================================
CREATE EXTENSION IF NOT EXISTS vector;

-- ============================================
-- ENTITIES TABLE
-- Canonical entities (deduplicated)
-- ============================================
CREATE TABLE IF NOT EXISTS entities (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

    -- Entity identification
    entity_text TEXT NOT NULL,           -- "John Smith"
    entity_type TEXT NOT NULL            -- PER, ORG, LOC, MISC, PROJ, TECH
        CHECK (entity_type IN ('PER', 'ORG', 'LOC', 'MISC', 'PROJ', 'TECH')),
    canonical_name TEXT NOT NULL,        -- Normalized: "john_smith"

    -- Embedding for similarity matching (OpenAI text-embedding-3-small)
    embedding VECTOR(1536),              -- FIXED: Was 384 (BGE-small), now 1536 (OpenAI)

    -- Metadata
    first_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    mention_count INT DEFAULT 1,

    -- Additional context (flexible JSON storage)
    metadata JSONB DEFAULT '{}'::jsonb,  -- {role: "coworker", company: "Google", etc.}

    -- Audit timestamps
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Ensure unique entities per user
    CONSTRAINT unique_user_entity UNIQUE(user_id, canonical_name, entity_type)
);

-- ============================================
-- ENTITY MENTIONS TABLE
-- Individual occurrences of entities in chat turns
-- ============================================
CREATE TABLE IF NOT EXISTS entity_mentions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    entity_id UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,

    -- FIXED: Reference chat_turns.id (UUID) instead of conversations.id
    -- conversation_id kept as TEXT for querying, but no foreign key constraint
    chat_turn_id UUID NOT NULL REFERENCES chat_turns(id) ON DELETE CASCADE,
    conversation_id TEXT,                -- For grouping mentions by conversation

    -- Mention details
    mention_text TEXT NOT NULL,          -- How it appeared: "John", "John Smith", "JS"
    context_before TEXT,                 -- 100 chars before mention
    context_after TEXT,                  -- 100 chars after mention

    -- Position in content
    position_start INT,
    position_end INT,

    -- Extraction metadata
    confidence FLOAT NOT NULL DEFAULT 0.0  -- NER confidence score (0.0-1.0)
        CHECK (confidence >= 0.0 AND confidence <= 1.0),

    -- Temporal
    timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================
-- ENTITY RELATIONSHIPS TABLE
-- Co-occurrence and relationships between entities
-- ============================================
CREATE TABLE IF NOT EXISTS entity_relationships (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

    -- Relationship endpoints (always entity_a_id < entity_b_id for consistency)
    entity_a_id UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    entity_b_id UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,

    -- Relationship metrics
    co_occurrence_count INT DEFAULT 1,
    relationship_strength FLOAT DEFAULT 0.1  -- 0-1, increases with co-occurrence
        CHECK (relationship_strength >= 0.0 AND relationship_strength <= 1.0),

    -- Temporal tracking
    first_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Ensure unique pairs and consistent ordering
    CONSTRAINT unique_entity_pair UNIQUE(entity_a_id, entity_b_id),
    CONSTRAINT entity_order CHECK (entity_a_id < entity_b_id)
);

-- ============================================
-- INDEXES FOR PERFORMANCE
-- ============================================

-- Entity lookups
CREATE INDEX IF NOT EXISTS idx_entities_user_id ON entities(user_id);
CREATE INDEX IF NOT EXISTS idx_entities_user_type ON entities(user_id, entity_type);
CREATE INDEX IF NOT EXISTS idx_entities_canonical ON entities(user_id, canonical_name);
CREATE INDEX IF NOT EXISTS idx_entities_last_seen ON entities(user_id, last_seen DESC);

-- Vector similarity search (IVFFlat for now, can upgrade to HNSW later)
CREATE INDEX IF NOT EXISTS idx_entities_embedding ON entities
    USING ivfflat (embedding vector_cosine_ops)
    WITH (lists = 100);

-- JSONB metadata search (for filtering by role, company, etc.)
CREATE INDEX IF NOT EXISTS idx_entities_metadata ON entities USING GIN (metadata);

-- Entity mentions
CREATE INDEX IF NOT EXISTS idx_mentions_entity ON entity_mentions(entity_id);
CREATE INDEX IF NOT EXISTS idx_mentions_chat_turn ON entity_mentions(chat_turn_id);
CREATE INDEX IF NOT EXISTS idx_mentions_conversation ON entity_mentions(conversation_id);
CREATE INDEX IF NOT EXISTS idx_mentions_timestamp ON entity_mentions(timestamp DESC);

-- Relationships
CREATE INDEX IF NOT EXISTS idx_relationships_user ON entity_relationships(user_id);
CREATE INDEX IF NOT EXISTS idx_relationships_entity_a ON entity_relationships(entity_a_id);
CREATE INDEX IF NOT EXISTS idx_relationships_entity_b ON entity_relationships(entity_b_id);
CREATE INDEX IF NOT EXISTS idx_relationships_strength ON entity_relationships(relationship_strength DESC);

-- ============================================
-- ROW LEVEL SECURITY (RLS)
-- ============================================
ALTER TABLE entities ENABLE ROW LEVEL SECURITY;
ALTER TABLE entity_mentions ENABLE ROW LEVEL SECURITY;
ALTER TABLE entity_relationships ENABLE ROW LEVEL SECURITY;

-- ============================================
-- ENTITIES POLICIES
-- ============================================
CREATE POLICY "Users can read own entities" ON entities
    FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own entities" ON entities
    FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own entities" ON entities
    FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own entities" ON entities
    FOR DELETE USING (auth.uid() = user_id);

-- ============================================
-- ENTITY MENTIONS POLICIES
-- Access controlled via entity ownership
-- ============================================
CREATE POLICY "Users can read own entity_mentions" ON entity_mentions
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM entities e
            WHERE e.id = entity_mentions.entity_id
            AND e.user_id = auth.uid()
        )
    );

CREATE POLICY "Users can insert own entity_mentions" ON entity_mentions
    FOR INSERT WITH CHECK (
        EXISTS (
            SELECT 1 FROM entities e
            WHERE e.id = entity_mentions.entity_id
            AND e.user_id = auth.uid()
        )
    );

CREATE POLICY "Users can update own entity_mentions" ON entity_mentions
    FOR UPDATE USING (
        EXISTS (
            SELECT 1 FROM entities e
            WHERE e.id = entity_mentions.entity_id
            AND e.user_id = auth.uid()
        )
    );

CREATE POLICY "Users can delete own entity_mentions" ON entity_mentions
    FOR DELETE USING (
        EXISTS (
            SELECT 1 FROM entities e
            WHERE e.id = entity_mentions.entity_id
            AND e.user_id = auth.uid()
        )
    );

-- ============================================
-- ENTITY RELATIONSHIPS POLICIES
-- ============================================
CREATE POLICY "Users can read own entity_relationships" ON entity_relationships
    FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own entity_relationships" ON entity_relationships
    FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own entity_relationships" ON entity_relationships
    FOR UPDATE USING (auth.uid() = user_id);

-- FIXED: Added missing DELETE policy
CREATE POLICY "Users can delete own entity_relationships" ON entity_relationships
    FOR DELETE USING (auth.uid() = user_id);

-- ============================================
-- HELPER FUNCTIONS
-- ============================================

-- Find similar entities for linking/deduplication
CREATE OR REPLACE FUNCTION find_similar_entities(
    p_user_id UUID,
    p_entity_type TEXT,
    p_embedding VECTOR(1536),           -- FIXED: Was 384, now 1536
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
      AND (
          e.canonical_name = p_canonical_name  -- Exact canonical match
          OR 1 - (e.embedding <=> p_embedding) > p_similarity_threshold  -- Semantic match
      )
    ORDER BY similarity DESC
    LIMIT 5;
END;
$$ LANGUAGE plpgsql;

-- Upsert entity relationship (handles ordering and increments)
CREATE OR REPLACE FUNCTION upsert_entity_relationship(
    p_user_id UUID,
    p_entity_a UUID,
    p_entity_b UUID
)
RETURNS VOID AS $$
DECLARE
    v_first UUID;
    v_second UUID;
BEGIN
    -- Ensure consistent ordering (smaller UUID first)
    IF p_entity_a < p_entity_b THEN
        v_first := p_entity_a;
        v_second := p_entity_b;
    ELSE
        v_first := p_entity_b;
        v_second := p_entity_a;
    END IF;

    INSERT INTO entity_relationships (
        user_id,
        entity_a_id,
        entity_b_id,
        co_occurrence_count,
        first_seen,
        last_seen
    ) VALUES (
        p_user_id,
        v_first,
        v_second,
        1,
        NOW(),
        NOW()
    )
    ON CONFLICT (entity_a_id, entity_b_id)
    DO UPDATE SET
        co_occurrence_count = entity_relationships.co_occurrence_count + 1,
        last_seen = NOW(),
        relationship_strength = LEAST(
            1.0,
            (entity_relationships.co_occurrence_count + 1)::FLOAT / 20.0
        );
END;
$$ LANGUAGE plpgsql;

-- Get related entities (for query expansion)
CREATE OR REPLACE FUNCTION get_related_entities(
    p_entity_id UUID,
    p_limit INT DEFAULT 10
)
RETURNS TABLE (
    entity_id UUID,
    entity_text TEXT,
    entity_type TEXT,
    relationship_strength FLOAT
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        CASE
            WHEN er.entity_a_id = p_entity_id THEN er.entity_b_id
            ELSE er.entity_a_id
        END AS entity_id,
        e.entity_text,
        e.entity_type,
        er.relationship_strength
    FROM entity_relationships er
    JOIN entities e ON e.id = CASE
        WHEN er.entity_a_id = p_entity_id THEN er.entity_b_id
        ELSE er.entity_a_id
    END
    WHERE er.entity_a_id = p_entity_id OR er.entity_b_id = p_entity_id
    ORDER BY er.relationship_strength DESC
    LIMIT p_limit;
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- TABLE COMMENTS (Documentation)
-- ============================================
COMMENT ON TABLE entities IS 'Canonical deduplicated entities extracted from conversations. Uses semantic embeddings for similarity matching.';
COMMENT ON TABLE entity_mentions IS 'Individual occurrences of entities within chat turns. Tracks context and position for entity resolution.';
COMMENT ON TABLE entity_relationships IS 'Co-occurrence relationships between entities. Strength increases with repeated co-occurrences.';

COMMENT ON COLUMN entities.canonical_name IS 'Normalized entity name for exact matching (e.g., "john_smith")';
COMMENT ON COLUMN entities.embedding IS 'OpenAI text-embedding-3-small (1536 dimensions) for semantic similarity';
COMMENT ON COLUMN entities.metadata IS 'Flexible JSON storage for entity attributes (role, company, location, etc.)';

COMMENT ON COLUMN entity_mentions.chat_turn_id IS 'References chat_turns.id - links mention to specific conversation turn';
COMMENT ON COLUMN entity_mentions.conversation_id IS 'TEXT copy of chat_turns.conversation_id for grouping (no FK constraint)';
COMMENT ON COLUMN entity_mentions.confidence IS 'NER model confidence score (0.0-1.0)';

COMMENT ON COLUMN entity_relationships.relationship_strength IS 'Normalized strength (0-1) based on co_occurrence_count / 20';

-- ============================================
-- VERIFICATION QUERIES
-- ============================================

-- Check tables exist
SELECT table_name, table_type
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN ('entities', 'entity_mentions', 'entity_relationships')
ORDER BY table_name;

-- Check columns and types
SELECT table_name, column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name IN ('entities', 'entity_mentions', 'entity_relationships')
ORDER BY table_name, ordinal_position;

-- Check indexes
SELECT tablename, indexname, indexdef
FROM pg_indexes
WHERE tablename IN ('entities', 'entity_mentions', 'entity_relationships')
ORDER BY tablename, indexname;

-- Check RLS policies
SELECT schemaname, tablename, policyname, permissive, roles, cmd
FROM pg_policies
WHERE tablename IN ('entities', 'entity_mentions', 'entity_relationships')
ORDER BY tablename, policyname;

-- Check functions exist
SELECT routine_name, routine_type
FROM information_schema.routines
WHERE routine_schema = 'public'
  AND routine_name IN ('find_similar_entities', 'upsert_entity_relationship', 'get_related_entities')
ORDER BY routine_name;

-- ============================================
-- ROLLBACK PROCEDURE
-- ============================================
-- To remove this migration, execute:
--
-- DROP FUNCTION IF EXISTS get_related_entities(UUID, INT);
-- DROP FUNCTION IF EXISTS upsert_entity_relationship(UUID, UUID, UUID);
-- DROP FUNCTION IF EXISTS find_similar_entities(UUID, TEXT, VECTOR(1536), TEXT, FLOAT);
-- DROP TABLE IF EXISTS entity_relationships CASCADE;
-- DROP TABLE IF EXISTS entity_mentions CASCADE;
-- DROP TABLE IF EXISTS entities CASCADE;
--
-- Note: This will delete all entity data. Backup first if needed.
