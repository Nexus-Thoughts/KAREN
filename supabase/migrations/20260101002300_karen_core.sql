-- =============================================================================
-- 20260101002300_karen_core
-- Phase 14/15 — KAREN conversation storage, audit wiring and rate limiting.
--
-- docs/08_AI_INTELLIGENT_SYSTEM.md, docs/09_AI_TOOLS_AND_AGENTS.md,
-- docs/22 ADR-004: the browser never talks to a model provider directly —
-- everything here backs the `karen-chat` Edge Function, which authenticates
-- as the calling user (their own JWT, not the service role) so every tool
-- read/write it makes is still subject to the RLS policies below and on
-- every other table it queries. KAREN cannot see or do anything the same
-- user could not already see or do through the ordinary UI.
-- =============================================================================

create type public.karen_message_role as enum ('user', 'assistant', 'tool', 'system');

-- -----------------------------------------------------------------------------
-- karen_conversations / karen_messages
--
-- One conversation thread per row; messages ordered by created_at within it.
-- A user only ever sees their own conversations — KAREN is a personal
-- assistant scoped to what its caller can already see, not a shared/admin
-- transcript viewer (docs/13: least privilege applies to KAREN's own data
-- too, not just the tools it calls).
-- -----------------------------------------------------------------------------
create table public.karen_conversations (
  id          uuid primary key default extensions.gen_random_uuid(),
  user_id     uuid not null references public.users (id) on delete cascade,
  title       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index karen_conversations_user_idx on public.karen_conversations (user_id, updated_at desc);

create trigger karen_conversations_set_updated_at before update on public.karen_conversations
  for each row execute function cims.set_updated_at();

create table public.karen_messages (
  id               uuid primary key default extensions.gen_random_uuid(),
  conversation_id  uuid not null references public.karen_conversations (id) on delete cascade,
  role             public.karen_message_role not null,
  content          text,
  -- Populated only on role = 'tool' rows — one row per tool call/result, kept
  -- in the same ordered stream as the surrounding user/assistant turns so
  -- the transcript replays exactly what happened (docs/09: "structured
  -- output... audit behavior" per tool call).
  tool_name        text,
  tool_args        jsonb,
  tool_result       jsonb,
  created_at       timestamptz not null default now(),

  constraint karen_messages_tool_shape check (
    (role = 'tool' and tool_name is not null) or (role <> 'tool')
  )
);

create index karen_messages_conversation_idx on public.karen_messages (conversation_id, created_at);

alter table public.karen_conversations enable row level security;
alter table public.karen_messages enable row level security;

create policy karen_conversations_own on public.karen_conversations
  for all to authenticated
  using (cims.is_active_user() and user_id = cims.current_user_id())
  with check (cims.is_active_user() and user_id = cims.current_user_id());

create policy karen_messages_own on public.karen_messages
  for all to authenticated
  using (
    cims.is_active_user()
    and exists (select 1 from public.karen_conversations c where c.id = conversation_id and c.user_id = cims.current_user_id())
  )
  with check (
    cims.is_active_user()
    and exists (select 1 from public.karen_conversations c where c.id = conversation_id and c.user_id = cims.current_user_id())
  );

grant select, insert, update on public.karen_conversations to authenticated;
grant select, insert on public.karen_messages to authenticated;

-- -----------------------------------------------------------------------------
-- Audit wiring. public.audit_action already has AI_TOOL_CALL / AI_WRITE_ACTION
-- (added in Phase 3, docs/22 ADR — this migration is the first thing that
-- actually uses them). SECURITY DEFINER wrapper around cims.write_audit so
-- the karen-chat Edge Function (running as the calling user, not service
-- role) can log without needing direct INSERT on public.audit_logs, which
-- stays unwritable from PostgREST per the audit_foundation migration.
-- -----------------------------------------------------------------------------
create or replace function public.karen_log_tool_call(
  p_tool_name  text,
  p_args       jsonb,
  p_result     jsonb,
  p_is_write   boolean default false,
  p_request_id uuid default null
)
returns bigint
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
begin
  return cims.write_audit(
    -- Explicit cast is load-bearing: a bare CASE over two string literals
    -- resolves to `text`, and Postgres does not implicitly coerce an
    -- already-`text`-typed value to a user-defined enum at a function call
    -- site (only a literal `unknown`-typed constant gets that coercion) —
    -- without this cast, every single call to this function raises
    -- "function cims.write_audit(text, ...) does not exist", i.e. KAREN
    -- could never actually log a tool call. Caught by
    -- supabase/tests/database/012_phase14_karen.test.sql run against a real
    -- Postgres instance, not by inspection.
    (case when p_is_write then 'AI_WRITE_ACTION' else 'AI_TOOL_CALL' end)::public.audit_action,
    'karen_tool',
    p_tool_name,
    null,
    jsonb_build_object('args', p_args, 'result', p_result),
    null,
    '{}'::jsonb,
    p_request_id
  );
end;
$$;

comment on function public.karen_log_tool_call is
  'The only path KAREN''s Edge Function uses to write audit rows for its own tool calls. Runs as the calling user (auth.uid() inside cims.write_audit is theirs), never the service role.';

grant execute on function public.karen_log_tool_call(text, jsonb, jsonb, boolean, uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- Rate limiting. KAREN_RATE_LIMIT_PER_MINUTE (.env.example) is enforced by
-- the Edge Function calling this function before it does any provider call —
-- a DB-backed counter rather than in-memory so it is correct across Edge
-- Function cold starts / multiple concurrent instances, per docs/21 §"rate
-- limiting... enforced inside the karen-chat Edge Function starting Phase 14".
-- -----------------------------------------------------------------------------
create or replace function public.karen_check_rate_limit(p_limit_per_minute integer)
returns boolean
language sql stable
security definer
set search_path = public, extensions, pg_temp
as $$
  select count(*) < p_limit_per_minute
  from public.karen_messages m
  join public.karen_conversations c on c.id = m.conversation_id
  where c.user_id = cims.current_user_id()
    and m.role = 'user'
    and m.created_at > now() - interval '1 minute';
$$;

comment on function public.karen_check_rate_limit is
  'Returns false when the calling user has already sent p_limit_per_minute user turns in the last 60 seconds. The Edge Function must call this before invoking the provider and reject the turn (without persisting it) if it returns false.';

grant execute on function public.karen_check_rate_limit(integer) to authenticated;
