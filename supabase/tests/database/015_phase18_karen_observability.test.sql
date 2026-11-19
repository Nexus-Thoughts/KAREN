-- =============================================================================
-- 015_phase18_karen_observability.test.sql
--
-- Covers supabase/migrations/20260101002600_karen_observability.sql:
-- karen_log_tool_call's new p_duration_ms lands in audit_logs.metadata, the
-- old call signature (no duration) still works unchanged, and
-- karen_observability_summary aggregates what karen_log_tool_call wrote.
-- =============================================================================

begin;

do $$
begin
  create extension if not exists pgtap with schema extensions;
exception when duplicate_object then
  null;
end;
$$;

select plan(5);

create schema if not exists tests;
grant usage on schema tests to anon, authenticated;

create or replace function tests.simulate_user(p_user_id uuid)
returns void
language sql
as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_user_id, 'role', 'authenticated')::text, true);
  select set_config('role', 'authenticated', true);
$$;

grant execute on function tests.simulate_user(uuid) to anon, authenticated;

reset role;
select set_config('request.jwt.claims', '', true);

-- Fixtures (supabase/seed.sql): faculty.ds (...0003) is an ordinary
-- authenticated actor for this purpose — karen_log_tool_call runs as
-- whoever calls it, no special permission required (it's not a report).

select tests.simulate_user('10000000-0000-0000-0000-000000000003'); -- faculty.ds

-- =============================================================================
-- 1. Backward compatibility — the pre-Phase-18 call shape (no p_duration_ms)
--    still works. Every existing call site that hasn't been touched must
--    keep working exactly as before.
-- =============================================================================
select lives_ok(
  $$ select public.karen_log_tool_call('get_attendance_summary', '{}'::jsonb, '{"ok":true}'::jsonb, false, gen_random_uuid()) $$,
  'karen_log_tool_call still works with no p_duration_ms argument (backward compatible)'
);

-- =============================================================================
-- 2. p_duration_ms lands in audit_logs.metadata.
-- =============================================================================
do $$
declare v_id bigint;
begin
  v_id := public.karen_log_tool_call('get_attendance_summary', '{}'::jsonb, '{"ok":true}'::jsonb, false, gen_random_uuid(), 842);
  perform set_config('tests.log_id', v_id::text, false);
end;
$$;

-- audit_logs_select (20260101000700) requires audit.read on TOP of
-- actor_id = auth.uid() — faculty.ds, who just wrote this row, does not
-- hold that permission, so (same lesson as 012_phase14_karen.test.sql) the
-- read-back has to run as an actor who does. Ada Admin (...0001) does.
select tests.simulate_user('10000000-0000-0000-0000-000000000001'); -- admin

select is(
  (select (metadata ->> 'duration_ms')::int from public.audit_logs where id = current_setting('tests.log_id')::bigint),
  842,
  'p_duration_ms is recorded in audit_logs.metadata.duration_ms'
);

-- =============================================================================
-- 3. A null duration keeps metadata as the original empty object, not
--    {"duration_ms": null} — a null value stored explicitly would make
--    "was latency ever measured for this row" ambiguous with "it was
--    measured at exactly zero/unknown".
-- =============================================================================
do $$
declare v_id bigint;
begin
  v_id := public.karen_log_tool_call('get_attendance_summary', '{}'::jsonb, '{"ok":true}'::jsonb, false, gen_random_uuid());
  perform set_config('tests.log_id_null', v_id::text, false);
end;
$$;

select is(
  (select metadata from public.audit_logs where id = current_setting('tests.log_id_null')::bigint),
  '{}'::jsonb,
  'omitting p_duration_ms leaves metadata as {} rather than storing an explicit null'
);

-- =============================================================================
-- 4/5. karen_observability_summary aggregates what was just logged for this
-- tool: at least the 2 successful calls above plus 1 forced error below.
-- =============================================================================
select public.karen_log_tool_call('get_attendance_summary', '{}'::jsonb, '{"error":"TOOL_FAILED","message":"boom"}'::jsonb, false, gen_random_uuid(), 100);

select ok(
  (select call_count >= 3 from public.karen_observability_summary(now() - interval '1 hour') where tool_name = 'get_attendance_summary'),
  'karen_observability_summary counts every karen_log_tool_call row for this tool in the window'
);

select ok(
  (select error_count >= 1 from public.karen_observability_summary(now() - interval '1 hour') where tool_name = 'get_attendance_summary'),
  'karen_observability_summary counts the one forced-error row as an error'
);

select * from finish();
rollback;
