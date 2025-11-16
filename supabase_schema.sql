-- KYT Day 2: Supabase Database Schema
-- Purpose: Store ChatGPT messages with vector embeddings for semantic search
-- Date: 2025-11-10

-- ============================================
-- 1. Enable pgvector extension
-- ============================================
CREATE EXTENSION IF NOT EXISTS vector;

-- ============================================
-- 2. Create messages table
-- ============================================
CREATE TABLE IF NOT EXISTS messages (
  -- Primary key
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Original captured data from Chrome extension
  content TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  conversation_id TEXT,
  model TEXT,
  timestamp BIGINT NOT NULL,
  message_id TEXT UNIQUE NOT NULL,

  -- Vector embedding (1536 dimensions for text-embedding-3-small)
  embedding VECTOR(1536),

  -- Metadata
  created_at TIMESTAMP DEFAULT NOW(),
  synced_from_extension TIMESTAMP DEFAULT NOW()
);

-- ============================================
-- 3. Create indexes for performance
-- ============================================

-- Index for vector similarity search using HNSW (Hierarchical Navigable Small World)
-- This enables fast approximate nearest neighbor search
CREATE INDEX IF NOT EXISTS messages_embedding_idx ON messages
USING hnsw (embedding vector_cosine_ops);

-- Index for filtering by timestamp (most recent first)
CREATE INDEX IF NOT EXISTS messages_timestamp_idx ON messages (timestamp DESC);

-- Index for grouping messages by conversation
CREATE INDEX IF NOT EXISTS messages_conversation_idx ON messages (conversation_id);

-- Index for filtering by role
CREATE INDEX IF NOT EXISTS messages_role_idx ON messages (role);

-- ============================================
-- 4. Verification queries
-- ============================================

-- Check if pgvector extension is enabled
SELECT * FROM pg_extension WHERE extname = 'vector';

-- Check if messages table exists
SELECT table_name, column_name, data_type
FROM information_schema.columns
WHERE table_name = 'messages'
ORDER BY ordinal_position;

-- Check indexes
SELECT indexname, indexdef
FROM pg_indexes
WHERE tablename = 'messages';
