-- Sections backfill: the "which turns still need splitting" query took 10 s
-- and hit the statement timeout (2026-11-14). length(content) has to unpack
-- every stored turn; octet_length(content) reads the stored size instead
-- (measured: 10.1 s -> 1.0 s on 22,000 turns).
--
-- Sizes are therefore in bytes from here on: the minimum is compared in bytes
-- (never smaller than the character count, so no long turn is missed; a turn
-- that turns out shorter in characters is marked as not split), and the size
-- recorded in metadata.sections.len is the byte size.

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
    select t.id, t.content, octet_length(t.content)
    from public.chat_turns t
    where t.user_id = p_user_id
      and octet_length(t.content) >= p_min_chars
      and coalesce(t.is_injection, false) = false
      and coalesce(t.exclude_from_search, false) = false
      and (
          t.metadata -> 'sections' is null
          or coalesce((t.metadata -> 'sections' ->> 'v')::int, 0) < p_version
          or (t.metadata -> 'sections' ->> 'len')::int is distinct from octet_length(t.content)
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
      and octet_length(t.content) >= p_min_chars
      and coalesce(t.is_injection, false) = false
      and coalesce(t.exclude_from_search, false) = false
      and (
          t.metadata -> 'sections' is null
          or coalesce((t.metadata -> 'sections' ->> 'v')::int, 0) < p_version
          or (t.metadata -> 'sections' ->> 'len')::int is distinct from octet_length(t.content)
      )
      and coalesce((t.metadata -> 'sections' ->> 'failed')::int, 0) < 3;
$$;

revoke all on function public.turns_needing_sections(uuid, integer, integer, integer) from public, anon, authenticated;
revoke all on function public.count_turns_needing_sections(uuid, integer, integer) from public, anon, authenticated;
grant execute on function public.turns_needing_sections(uuid, integer, integer, integer) to service_role;
grant execute on function public.count_turns_needing_sections(uuid, integer, integer) to service_role;
