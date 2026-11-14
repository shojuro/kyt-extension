-- Memory cards: one short record per important name (project, person, tool),
-- written from the user's own statements, with every spelling of the name.
-- Built by the build_memory_cards edge function, read by search_memories.
-- See supabase/functions/_shared/memory-cards.ts.

create table if not exists public.memory_cards (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null,
    card_key text not null,                       -- squashed main name, e.g. 'kyt'
    name text not null,                           -- name as shown, e.g. 'K.Y.T.'
    aliases text[] not null default '{}',         -- squashed spellings, for lookup
    alias_names text[] not null default '{}',     -- spellings as written
    pinned boolean not null default false,        -- named by the user, not picked by count
    user_note text,                               -- a fact the user states outright
    kind text,
    description text,
    key_facts jsonb not null default '[]'::jsonb,
    status text not null default 'pending' check (status in ('pending', 'ready', 'insufficient')),
    mention_count integer not null default 0,
    evidence_count integer not null default 0,
    evidence_fingerprint text,
    latest_evidence_at timestamptz,
    model text,
    built_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (user_id, card_key)
);

create index if not exists memory_cards_aliases_idx on public.memory_cards using gin (aliases);
create index if not exists memory_cards_user_status_idx on public.memory_cards (user_id, status);

alter table public.memory_cards enable row level security;

-- A signed-in user can read their own cards. All writes go through the edge
-- function with the service role, which bypasses row-level security.
drop policy if exists "memory_cards_select_own" on public.memory_cards;
create policy "memory_cards_select_own" on public.memory_cards
    for select to authenticated
    using (auth.uid() = user_id);

revoke all on public.memory_cards from anon;
revoke insert, update, delete on public.memory_cards from authenticated;

-- Every name the user's entity records hold, with spellings of one name
-- ("K.Y.T.", "KYT") grouped and their mentions added up. One JSON array, so
-- the 1,000-row API limit does not cut it short.
create or replace function public.memory_card_candidates(p_user_id uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
    select coalesce(jsonb_agg(jsonb_build_object('k', k, 'n', n, 'name', name, 'type', type)), '[]'::jsonb)
    from (
        select
            k,
            sum(mentions)::int as n,
            (array_agg(entity_text order by mentions desc, entity_text))[1] as name,
            (array_agg(entity_type order by mentions desc, entity_type))[1] as type
        from (
            select
                regexp_replace(lower(entity_text), '[^a-z0-9]', '', 'g') as k,
                entity_text,
                entity_type,
                coalesce(mention_count, 1) as mentions
            from public.entities
            where user_id = p_user_id
              and superseded_by is null
        ) e
        where length(k) between 2 and 60
        group by k
    ) g;
$$;

-- Excerpts of the user's own messages that mention a name. p_pattern is a
-- regular expression built by the edge function from escaped spellings.
-- Messages that say what the thing is come first, then the most recent.
create or replace function public.memory_card_evidence(
    p_user_id uuid,
    p_pattern text,
    p_limit integer default 40
)
returns table (id uuid, created_at timestamp, platform text, snippet text)
language sql
stable
set search_path = ''
as $$
    select
        t.id,
        t.created_at,
        t.platform,
        substr(t.content, greatest(1, regexp_instr(t.content, p_pattern, 1, 1, 0, 'i') - 400), 1400) as snippet
    from public.chat_turns t
    where t.user_id = p_user_id
      and t.content ~* p_pattern
      and coalesce(t.is_injection, false) = false
      and coalesce(t.exclude_from_search, false) = false
      and coalesce(t.is_question, false) = false
      and 'user' = any (t.speakers)
    order by
        case
            when t.content ~* (p_pattern || '[^.?!\n]{0,40}\m(stands for|means|is (a|an|my|the|our)|is going to|will)\M') then 2
            when t.content ~* (p_pattern || '[^.?!\n]{0,40}\m(is|are|was|lets|allows|helps)\M') then 1
            else 0
        end desc,
        t.created_at desc
    limit least(greatest(p_limit, 1), 80);
$$;

revoke all on function public.memory_card_candidates(uuid) from public, anon, authenticated;
revoke all on function public.memory_card_evidence(uuid, text, integer) from public, anon, authenticated;
grant execute on function public.memory_card_candidates(uuid) to service_role;
grant execute on function public.memory_card_evidence(uuid, text, integer) to service_role;
