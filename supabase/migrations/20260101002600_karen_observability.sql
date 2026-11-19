-- =============================================================================
-- 20260101002600_karen_observability
-- Phase 18 — KAREN observability.
--
-- KAREN already had an audit trail (karen_log_tool_call → audit_logs,
-- Phase 15) but two real gaps existed:
--
--   1. No latency data. audit_logs.metadata was always hardcoded to '{}' —
--      there was no way to tell "search_knowledge is slow" from "everything
--      is slow" from "Gemini itself is slow" after the fact, only from live
--      Supabase function logs (which roll off).
--   2. No record at all of a request that failed before or between tool
--      calls (PROVIDER_NOT_CONFIGURED, RATE_LIMITED, a provider timeout, an
--      uncaught exception). Every successful tool call was audited; a
--      request that failed outright left zero trace in the database.
--
-- This migration only extends karen_log_tool_call with an optional
-- duration_ms — additive (default null), so it stays backward-compatible
-- with any caller that doesn't pass it. The Edge Function
-- (karen-chat/index.ts) is what actually measures durations and calls this
-- for request-level failures too, using p_tool_name = '_request' as a
-- sentinel that is never a real tool name (tools.ts names are all
-- snake_case verbs like search_knowledge; '_request' cannot collide).
-- =============================================================================

-- CREATE OR REPLACE cannot change a function's parameter list — it only
-- replaces a function with the SAME signature. Without this explicit drop
-- first, Postgres would keep the original 5-parameter overload AND add this
-- 6-parameter one, leaving two overloads of karen_log_tool_call that any
-- 5-argument call (positional, or named args covering only the first five
-- params) resolves ambiguously between. Caught by running this migration
-- against a real Postgres instance — psql refused with "function name ...
-- is not unique" the moment anything downstream referenced the function.
drop function if exists public.karen_log_tool_call(text, jsonb, jsonb, boolean, uuid);

create or replace function public.karen_log_tool_call(
  p_tool_name   text,
  p_args        jsonb,
  p_result      jsonb,
  p_is_write    boolean default false,
  p_request_id  uuid default null,
  p_duration_ms integer default null
)
returns bigint
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
begin
  return cims.write_audit(
    (case when p_is_write then 'AI_WRITE_ACTION' else 'AI_TOOL_CALL' end)::public.audit_action,
    'karen_tool',
    p_tool_name,
    null,
    jsonb_build_object('args', p_args, 'result', p_result),
    null,
    case when p_duration_ms is null then '{}'::jsonb else jsonb_build_object('duration_ms', p_duration_ms) end,
    p_request_id
  );
end;
$$;

comment on function public.karen_log_tool_call is
  'The only path KAREN''s Edge Function uses to write audit rows for its own tool calls (and, since Phase 18, request-level failures via the p_tool_name=''_request'' sentinel). Runs as the calling user, never the service role. p_duration_ms lands in audit_logs.metadata for latency review in the Audit Center.';

grant execute on function public.karen_log_tool_call(text, jsonb, jsonb, boolean, uuid, integer) to authenticated;

-- -----------------------------------------------------------------------------
-- karen_observability_summary — a small aggregate RPC for an at-a-glance
-- health view (call volume, error rate, p50/p95 latency, per-tool
-- breakdown) rather than making an admin eyeball raw audit_logs rows to
-- notice a regression. SECURITY INVOKER over audit_logs_select — an admin
-- sees KAREN-wide numbers because is_admin() already lets them read every
-- actor's audit rows; nobody else gets a wider view of KAREN activity than
-- audit_logs already grants them (their own rows only), matching docs/13's
-- "no report widens what its caller could already see."
-- -----------------------------------------------------------------------------
create or replace function public.karen_observability_summary(
  p_since timestamptz default now() - interval '24 hours'
)
returns table (
  tool_name       text,
  call_count      bigint,
  error_count     bigint,
  avg_duration_ms numeric,
  p95_duration_ms numeric
)
language sql
stable
security invoker
set search_path = public, extensions, pg_temp
as $$
  select
    entity_id as tool_name,
    count(*) as call_count,
    count(*) filter (where (new_values -> 'result' ->> 'error') is not null) as error_count,
    round(avg((metadata ->> 'duration_ms')::numeric), 1) as avg_duration_ms,
    -- percentile_cont always returns double precision (even over a numeric
    -- sort expression — see PostgreSQL's ordered-set aggregate table), and
    -- round() has no (double precision, integer) overload, only
    -- (numeric, integer). Caught the same way as the drop above: this
    -- failed with "function round(double precision, integer) does not
    -- exist" the first time the migration actually ran.
    round(
      (percentile_cont(0.95) within group (order by (metadata ->> 'duration_ms')::numeric))::numeric,
      1
    ) as p95_duration_ms
  from public.audit_logs
  where action in ('AI_TOOL_CALL', 'AI_WRITE_ACTION')
    and occurred_at >= p_since
  group by entity_id
  order by call_count desc;
$$;

comment on function public.karen_observability_summary is
  'Per-tool call volume / error rate / latency over the trailing window, read through the caller''s own audit_logs_select RLS (admins see all of KAREN; anyone else sees only their own rows aggregated) — Phase 18.';

grant execute on function public.karen_observability_summary(timestamptz) to authenticated;
