-- The graph has not saved a relationship since 2026-03-04. Production's
-- upsert_entity_relationship (4 arguments) writes entity_relationships.relationship_type,
-- but the column is missing there, so every call failed; the calling code did
-- not check the result, so nothing was logged. These are the first two
-- statements of 20260216000003_relationship_classification.sql, safe to repeat.
ALTER TABLE public.entity_relationships
  ADD COLUMN IF NOT EXISTS relationship_type TEXT DEFAULT 'co_occurrence';

CREATE INDEX IF NOT EXISTS idx_relationships_type
  ON public.entity_relationships (relationship_type);
