-- Migration: Statement timeouts for search RPCs
-- Purpose: Capture timeout settings in migration so they survive branch reset / new environments.
-- Without this, functions fall back to the default 8s statement_timeout, causing vector
-- searches on 4096d embeddings to fail silently.

ALTER FUNCTION match_messages_with_gravity SET statement_timeout = '45s';
ALTER FUNCTION graph_walk_from_entities SET statement_timeout = '30s';
ALTER FUNCTION get_newest_turns_for_entities SET statement_timeout = '15s';
