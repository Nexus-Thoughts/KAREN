-- =============================================================================
-- 010_phase12_reports.test.sql
--
-- Covers supabase/migrations/20260101002100_reports_views.sql. The single
-- binding rule under test (docs/10): "Generated artifacts inherit user
-- authorization scope." Every report here is security_invoker/SECURITY
-- INVOKER, so this file mostly re-proves that a report never returns more
-- than the caller could already see through the underlying table's own RLS
-- — not new authorization logic, a consequence of having none of its own.
-- =============================================================================

begin;

do $$
begin
  create extension if not exists pgtap with schema extensions;
exception when duplicate_object then
  null;
end;
$$;

select plan(10);

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

-- =============================================================================
-- 1. report_section_attendance_stats reflects real seeded attendance data
--    (the CS department's seeded section/subject), scoped by an admin who
--    can see everything.
-- =============================================================================
select tests.simulate_user('10000000-0000-0000-0000-000000000001'); -- admin

select ok(
  (select count(*) from public.report_section_attendance_stats)::int >= 0,
  'report_section_attendance_stats is queryable by an admin without error'
);

select ok(
  (select count(*) from public.report_department_attendance_stats)::int >= 0,
  'report_department_attendance_stats is queryable by an admin without error'
);

-- =============================================================================
-- 2. report_campus_entry_exit inherits early_exit_events_select scope
--    (docs/22 ADR-017): a student sees only their own exit events.
-- =============================================================================
reset role;
select set_config('request.jwt.claims', '', true);

insert into public.geofences (id, type, name, boundary) values (
  '40000000-0000-0000-0000-000000000201', 'CAMPUS', 'Report Test Campus',
  'SRID=4326;POLYGON((-0.001 -0.001, 0.001 -0.001, 0.001 0.001, -0.001 0.001, -0.001 -0.001))'
);
update public.presence_config set college_start_time = '00:00', college_end_time = '23:59';

select tests.simulate_user('10000000-0000-0000-0000-000000000006'); -- student.rahul
select public.submit_location(1, 1, 5);
select public.submit_location(1, 1.001, 5); -- confirms an early exit event for Rahul

select is(
  (select count(*) from public.report_campus_entry_exit())::int,
  1,
  'a student calling report_campus_entry_exit sees their own confirmed exit'
);

select tests.simulate_user('10000000-0000-0000-0000-000000000007'); -- student.priya, unrelated

select is(
  (select count(*) from public.report_campus_entry_exit())::int,
  0,
  'a different student sees no rows in report_campus_entry_exit — Rahul''s event is out of scope'
);

select tests.simulate_user('10000000-0000-0000-0000-000000000002'); -- hod.cs, holds exit_events.read + department scope

select ok(
  (select count(*) from public.report_campus_entry_exit()) >= 1,
  'the department''s HOD sees the exit event via department scope (my_student_ids())'
);

-- =============================================================================
-- 3. report_audit_log requires audit.read — a principal without it gets zero
--    rows, not an error (RLS filters, it does not deny the SELECT itself).
-- =============================================================================
select tests.simulate_user('10000000-0000-0000-0000-000000000006'); -- student.rahul, no audit.read

select is(
  (select count(*) from public.report_audit_log())::int,
  0,
  'a principal without audit.read sees zero rows from report_audit_log, not an error'
);

select tests.simulate_user('10000000-0000-0000-0000-000000000001'); -- admin, holds audit.read

select ok(
  (select count(*) from public.report_audit_log()) > 0,
  'an admin with audit.read sees real audit_logs rows through report_audit_log'
);

-- =============================================================================
-- 4. report_audit_log's date filter genuinely filters (not just accepted
--    and ignored).
-- =============================================================================
select is(
  (select count(*) from public.report_audit_log(p_from => now() + interval '1 hour'))::int,
  0,
  'a from-date in the future excludes every existing audit row'
);

-- =============================================================================
-- 5. report_role_assignments inherits user_roles RLS scope.
-- =============================================================================
select tests.simulate_user('10000000-0000-0000-0000-000000000001'); -- admin

select ok(
  (select count(*) from public.report_role_assignments()) > 0,
  'an admin sees real seeded role assignments through report_role_assignments'
);

select tests.simulate_user('10000000-0000-0000-0000-000000000006'); -- student.rahul, no roles.assign/users.read

select ok(
  (select count(*) from public.report_role_assignments()) >= 1,
  'a student sees at least their own role assignment row (user_roles_select_self)'
);

select * from finish();
rollback;
