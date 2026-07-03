-- Fix: upsert_entity_relationship does ON CONFLICT (user_id, entity_a_id, entity_b_id)
-- but the base table (20251125000000_entity_memory.sql) only has UNIQUE(entity_a_id,
-- entity_b_id). The RPC therefore fails with "no unique or exclusion constraint
-- matching the ON CONFLICT specification" and NO relationships ever get written —
-- which silently disables the entity graph walk (multi-hop retrieval). Add the
-- matching 3-column unique constraint so the upsert works.
ALTER TABLE entity_relationships
  ADD CONSTRAINT entity_relationships_user_pair_uniq UNIQUE (user_id, entity_a_id, entity_b_id);
