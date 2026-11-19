-- =============================================================================
-- 004_phase6_views.test.sql
--
-- Covers supabase/migrations/20260101000900_department_stats_and_hod.sql —
-- the security_invoker views DepartmentsPage's detail modal reads.
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

-- department CS   20000000-0000-0000-0000-000000000001
-- department AIDS 20000000-0000-0000-0000-000000000002
-- hod.cs           10000000-0000-0000-0000-000000000002 (scoped to CS)

-- -----------------------------------------------------------------------------
-- 1. ADMIN sees real, non-zero counts for CS (2 seeded active students).
-- -----------------------------------------------------------------------------
select tests.simulate_user('10000000-0000-0000-0000-000000000001'); -- admin

select is(
  (select active_student_count::int from public.department_stats
   where department_id = '20000000-0000-0000-0000-000000000001'),
  2,
  'admin sees the real active student count for CS'
);

-- -----------------------------------------------------------------------------
-- 2. HOD of CS sees the same real count for their own department —
--    security_invoker means students_select_scoped applies underneath,
--    and CS is exactly what cims.my_student_ids() grants an HOD of CS.
-- -----------------------------------------------------------------------------
select tests.simulate_user('10000000-0000-0000-0000-000000000002'); -- hod.cs

select is(
  (select active_student_count::int from public.department_stats
   where department_id = '20000000-0000-0000-0000-000000000001'),
  2,
  'HOD of CS sees the real active student count for their own department'
);

-- -----------------------------------------------------------------------------
-- 3. The SAME HOD querying AI&DS gets a row (departments themselves are
--    globally listable — departments_select has no scope predicate), but its
--    student count reads 0, not the real out-of-scope count: security_invoker
--    scopes each joined table independently, so the view never leaks another
--    department's headcount through this HOD's session, even though the
--    department row itself is visible. Documented in ADR (this file's header
--    comment references the migration; see also docs/20's department_stats entry).
-- -----------------------------------------------------------------------------
select is(
  (select active_student_count::int from public.department_stats
   where department_id = '20000000-0000-0000-0000-000000000002'),
  0,
  'HOD of CS sees zero (not the real count) for AI&DS students — scoped by the underlying RLS, not by hiding the row'
);

-- -----------------------------------------------------------------------------
-- 4. department_hods: HOD of CS can see themself listed as CS's HOD.
-- -----------------------------------------------------------------------------
select is(
  (select full_name from public.department_hods
   where department_id = '20000000-0000-0000-0000-000000000001'),
  'Harish Odedra',
  'department_hods resolves the active HOD assignment for CS'
);

-- -----------------------------------------------------------------------------
-- 5. A student (no users.read) sees no rows in department_hods at all — the
--    view is built on user_roles, whose SELECT policies require users.read
--    or the caller's own row; a bare STUDENT grant list has neither for
--    someone else's role assignment.
-- -----------------------------------------------------------------------------
select tests.simulate_user('10000000-0000-0000-0000-000000000006'); -- Rahul, student

select is(
  (select count(*) from public.department_hods where department_id = '20000000-0000-0000-0000-000000000001')::int,
  0,
  'a student cannot resolve another user''s HOD role assignment via department_hods'
);

select * from finish();
rollback;
