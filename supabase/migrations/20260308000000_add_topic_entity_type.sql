-- Migration: Add TOPIC entity type
-- Date: 2026-03-08
-- Purpose: Broad topic labels ("health", "career", "music") for improved retrieval
-- TOPIC entities get embeddings, co-occurrence, and graph walk for free via existing infra.

-- 1. Drop and recreate the entity_type CHECK constraint to include TOPIC
ALTER TABLE entities DROP CONSTRAINT IF EXISTS entities_entity_type_check;
ALTER TABLE entities ADD CONSTRAINT entities_entity_type_check
  CHECK (entity_type IN (
    'PERSON', 'ORG', 'LOCATION', 'PROJECT', 'TECH', 'MISC',
    'CONCEPT', 'ANALOGY', 'THEME', 'TOPIC'
  ));
