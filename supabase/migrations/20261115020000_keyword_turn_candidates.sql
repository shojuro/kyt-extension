-- Keyword lane for whole messages (recall roadmap, phase 1).
--
-- Returns the user's messages that contain the question's words, rare words
-- counting for more than common ones. They join the meaning-search candidates
-- that a model then judges, so this function only has to FIND, not decide.
--
-- Measured read-only on 2026-11-15 before writing this: for a question the
-- meaning search missed, the right message ranked 310th by plain word overlap
-- and 2nd with this weighting; another went from 118th to 5th.
--
-- Called by the search_memories edge function with the service role only.

create or replace function public.keyword_turn_candidates(
    p_user_id uuid,
    p_terms text[],
    p_limit int default 10,
    p_project_id uuid default null,
    p_profile_id uuid default null
)
returns table (
    id uuid,
    content text,
    conversation_id text,
    speakers text[],
    created_at timestamptz,
    platform text,
    keyword_score double precision,
    keyword_hits int
)
language sql
stable
set search_path = public, extensions
set statement_timeout = '4s'
as $$
    with terms as (
        select distinct on (s.tq::text) s.tq
        from (
            select plainto_tsquery('english', k) as tq
            from unnest(p_terms[1:8]) as k
        ) s
        where numnode(s.tq) > 0
    ),
    total as (
        select greatest(count(*), 1)::double precision as n
        from chat_turns
        where user_id = p_user_id
    ),
    weighted as (
        select t.tq,
               ln(1 + (select n from total) / greatest(1, (
                   select count(*) from chat_turns c
                   where c.user_id = p_user_id and c.content_tsvector @@ t.tq
               ))) as w
        from terms t
    ),
    scored as (
        select ct.id, sum(w.w) as score, count(*)::int as hits
        from weighted w
        join chat_turns ct on ct.content_tsvector @@ w.tq
        where ct.user_id = p_user_id
          and ct.embedding is not null
          and ct.is_question is not true
          and (ct.deflection is null or ct.deflection < 0.70)
          and ct.exclude_from_search is not true
          and ct.is_injection is not true
          and ct.created_at::timestamptz < now() - interval '120 seconds'
          and (p_profile_id is null or ct.profile_id = p_profile_id)
          and (p_project_id is null or ct.project_id = p_project_id)
          and public.is_vault_excluded(p_project_id, ct.project_id)
        group by ct.id
    )
    select ct.id, ct.content, ct.conversation_id, ct.speakers,
           ct.created_at::timestamptz, ct.platform::text,
           s.score::double precision, s.hits
    from scored s
    join chat_turns ct on ct.id = s.id
    -- One shared word is not evidence when the question has several.
    where s.hits >= least(2, (select count(*) from terms))
    order by s.score desc, ct.created_at desc
    limit least(greatest(p_limit, 1), 20);
$$;

revoke all on function public.keyword_turn_candidates(uuid, text[], int, uuid, uuid) from public, anon, authenticated;
grant execute on function public.keyword_turn_candidates(uuid, text[], int, uuid, uuid) to service_role;
