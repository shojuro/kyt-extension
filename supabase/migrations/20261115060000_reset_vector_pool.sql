-- Undo 20261115050000: the wider index read did not earn its place.
-- Recall set, 2026-11-15 ("wider pool"): no question gained, several correct
-- answers ranked lower, searches took 5 to 7 s and the keyword search timed
-- out 7 times instead of once.

select '[1,2,3]'::extensions.vector <=> '[1,2,3]'::extensions.vector as load_vector_extension;

alter function public.match_messages_with_gravity(
    extensions.vector, double precision, integer, integer, uuid, uuid[], uuid, text, uuid, integer
) reset hnsw.ef_search;
