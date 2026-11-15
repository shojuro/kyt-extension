-- Let the whole-message search read more of the index.
--
-- The index search stops after hnsw.ef_search rows (40 by default), so the
-- function's p_candidate_pool of 50 or 100 was never reached: at most 40 rows
-- came back, before the filters that follow. Recall set, 2026-11-15: the
-- judge was handed 2 to 10 whole messages for most questions.
--
-- This sets the limit to 200 for this one function only. Nothing else changes.

alter function public.match_messages_with_gravity(
    extensions.vector, double precision, integer, integer, uuid, uuid[], uuid, text, uuid, integer
) set hnsw.ef_search = 200;
