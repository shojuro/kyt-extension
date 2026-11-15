-- Keyword lane, second version: fast enough to use.
--
-- The first version (20261115020000) timed out at 4 s on most questions in the
-- recall set run of 2026-11-15. Measured cause: one common word ("memory",
-- 3,478 messages) costs 1.7 s to read from the table, and every word was
-- read twice (once to count, once to score).
--
-- This version reads each word once, stops reading a word after 200 matches
-- and then leaves that word out: a word found in more than 200 messages does
-- not help find one message. Scoring is unchanged for the words that remain:
-- rarer words count for more, and a message needs two of them when the
-- question has two or more.
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
language plpgsql
stable
set search_path = public, extensions
set statement_timeout = '4s'
as $$
#variable_conflict use_column
declare
    c_cap constant int := 200;
    v_term text;
    v_tq tsquery;
    v_ids uuid[];
    v_total double precision;
    v_all_ids uuid[] := '{}';
    v_all_w double precision[] := '{}';
    v_rare int := 0;
    v_seen text[] := '{}';
begin
    if p_user_id is null then
        raise exception 'user_id is required';
    end if;

    -- Table size from the planner's statistics: an estimate is enough for a weight.
    select greatest(c.reltuples, 1)::double precision into v_total
    from pg_class c where c.oid = 'public.chat_turns'::regclass;

    foreach v_term in array coalesce(p_terms[1:8], '{}'::text[]) loop
        v_tq := plainto_tsquery('english', v_term);
        continue when numnode(v_tq) = 0 or v_tq::text = any(v_seen);
        v_seen := v_seen || v_tq::text;

        select array_agg(x.id) into v_ids
        from (
            select ct.id
            from chat_turns ct
            where ct.user_id = p_user_id
              and ct.content_tsvector @@ v_tq
            limit c_cap + 1
        ) x;

        continue when v_ids is null or cardinality(v_ids) > c_cap;
        v_rare := v_rare + 1;
        v_all_ids := v_all_ids || v_ids;
        v_all_w := v_all_w || array_fill(ln(1 + v_total / cardinality(v_ids)), array[cardinality(v_ids)]);
    end loop;

    if v_rare = 0 then
        return;
    end if;

    return query
    with scored as (
        select u.id as turn_id, sum(u.w) as score, count(*)::int as hits
        from unnest(v_all_ids, v_all_w) as u(id, w)
        group by u.id
        -- One shared word is not evidence when the question has several.
        having count(*) >= least(2, v_rare)
        order by sum(u.w) desc
        limit 60
    )
    select ct.id, ct.content, ct.conversation_id, ct.speakers,
           ct.created_at::timestamptz, ct.platform::text,
           s.score::double precision, s.hits
    from scored s
    join chat_turns ct on ct.id = s.turn_id
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
    order by s.score desc, ct.created_at desc
    limit least(greatest(p_limit, 1), 20);
end;
$$;

revoke all on function public.keyword_turn_candidates(uuid, text[], int, uuid, uuid) from public, anon, authenticated;
grant execute on function public.keyword_turn_candidates(uuid, text[], int, uuid, uuid) to service_role;
