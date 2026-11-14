-- Sections of long turns: a long message is split at its headings and
-- paragraphs and each part gets its own embedding, so search can return the
-- part that answers a question instead of the message's opening lines.
-- Written by the backfill_sections edge function, read by search_memories.
-- See supabase/functions/_shared/turn-sections.ts.

create table if not exists public.turn_sections (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null,
    turn_id uuid not null references public.chat_turns(id) on delete cascade,
    section_index integer not null,               -- 0-based; -1 is the outline
    kind text not null default 'section' check (kind in ('section', 'outline')),
    heading text,
    content text not null,
    embedding extensions.vector(1024),
    created_at timestamptz not null default now(),
    unique (turn_id, section_index)
);

create index if not exists turn_sections_user_idx on public.turn_sections (user_id);
create index if not exists turn_sections_turn_idx on public.turn_sections (turn_id);
create index if not exists turn_sections_embedding_idx on public.turn_sections
    using hnsw (embedding extensions.vector_cosine_ops);

alter table public.turn_sections enable row level security;

-- A signed-in user can read their own sections. Writes go through the edge
-- function with the service role, which bypasses row-level security.
drop policy if exists "turn_sections_select_own" on public.turn_sections;
create policy "turn_sections_select_own" on public.turn_sections
    for select to authenticated
    using (auth.uid() = user_id);

revoke all on public.turn_sections from anon;
revoke insert, update, delete on public.turn_sections from authenticated;

-- Long turns that have not been split yet (or were split from older content
-- or by older rules). The outcome is recorded in chat_turns.metadata.sections.
create or replace function public.turns_needing_sections(
    p_user_id uuid,
    p_limit integer default 20,
    p_min_chars integer default 3000,
    p_version integer default 1
)
returns table (id uuid, content text, content_len integer)
language sql
stable
set search_path = ''
as $$
    select t.id, t.content, length(t.content)
    from public.chat_turns t
    where t.user_id = p_user_id
      and length(t.content) >= p_min_chars
      and coalesce(t.is_injection, false) = false
      and coalesce(t.exclude_from_search, false) = false
      and (
          t.metadata -> 'sections' is null
          or coalesce((t.metadata -> 'sections' ->> 'v')::int, 0) < p_version
          or (t.metadata -> 'sections' ->> 'len')::int is distinct from length(t.content)
      )
      -- a turn that failed three times is left alone until its content changes
      and coalesce((t.metadata -> 'sections' ->> 'failed')::int, 0) < 3
    order by t.created_at desc
    limit least(greatest(p_limit, 1), 100);
$$;

create or replace function public.count_turns_needing_sections(
    p_user_id uuid,
    p_min_chars integer default 3000,
    p_version integer default 1
)
returns integer
language sql
stable
set search_path = ''
as $$
    select count(*)::int
    from public.chat_turns t
    where t.user_id = p_user_id
      and length(t.content) >= p_min_chars
      and coalesce(t.is_injection, false) = false
      and coalesce(t.exclude_from_search, false) = false
      and (
          t.metadata -> 'sections' is null
          or coalesce((t.metadata -> 'sections' ->> 'v')::int, 0) < p_version
          or (t.metadata -> 'sections' ->> 'len')::int is distinct from length(t.content)
      )
      and coalesce((t.metadata -> 'sections' ->> 'failed')::int, 0) < 3;
$$;

-- Record the outcome of splitting one turn, without touching the other keys of
-- chat_turns.metadata (another function keeps its own marker there).
create or replace function public.mark_turn_sections(
    p_user_id uuid,
    p_turn_id uuid,
    p_info jsonb
)
returns void
language sql
set search_path = ''
as $$
    update public.chat_turns
    set metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('sections', p_info)
    where id = p_turn_id and user_id = p_user_id;
$$;

-- Sections closest to a query embedding, with the same exclusions as the turn
-- search (match_messages_with_gravity): deflections, excluded and injected
-- turns, vault scoping, and the last two minutes (the conversation in progress).
create or replace function public.match_turn_sections(
    p_user_id uuid,
    query_embedding extensions.vector(1024),
    match_threshold double precision default 0.5,
    match_count integer default 8,
    p_project_id uuid default null,
    exclude_recent_seconds integer default 120
)
returns table (
    id uuid,
    turn_id uuid,
    kind text,
    section_index integer,
    heading text,
    content text,
    similarity double precision,
    platform text,
    speakers text[],
    created_at timestamptz
)
language sql
stable
set search_path = public, extensions
as $$
    with nearest as (
        select s.id, s.turn_id, s.kind, s.section_index, s.heading, s.content,
               (1 - (s.embedding <=> query_embedding))::double precision as similarity
        from public.turn_sections s
        where s.user_id = p_user_id
          and s.embedding is not null
        order by s.embedding <=> query_embedding
        limit least(greatest(match_count, 1), 50) * 4
    )
    select n.id, n.turn_id, n.kind, n.section_index, n.heading, n.content, n.similarity,
           t.platform, t.speakers, t.created_at::timestamptz
    from nearest n
    join public.chat_turns t on t.id = n.turn_id
    where t.user_id = p_user_id
      and n.similarity >= match_threshold
      and (t.deflection is null or t.deflection < 0.70)
      and coalesce(t.exclude_from_search, false) = false
      and coalesce(t.is_injection, false) = false
      and public.is_vault_excluded(p_project_id, t.project_id)
      and t.created_at < (now() at time zone 'utc') - make_interval(secs => exclude_recent_seconds)
    order by n.similarity desc
    limit least(greatest(match_count, 1), 50);
$$;

revoke all on function public.turns_needing_sections(uuid, integer, integer, integer) from public, anon, authenticated;
revoke all on function public.count_turns_needing_sections(uuid, integer, integer) from public, anon, authenticated;
revoke all on function public.mark_turn_sections(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.mark_turn_sections(uuid, uuid, jsonb) to service_role;
revoke all on function public.match_turn_sections(uuid, extensions.vector, double precision, integer, uuid, integer) from public, anon, authenticated;
grant execute on function public.turns_needing_sections(uuid, integer, integer, integer) to service_role;
grant execute on function public.count_turns_needing_sections(uuid, integer, integer) to service_role;
grant execute on function public.match_turn_sections(uuid, extensions.vector, double precision, integer, uuid, integer) to service_role;
