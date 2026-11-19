-- =============================================================================
-- 001_rbac_scope.test.sql
--
-- pgTAP suite proving the RLS/scope model actually isolates data between
-- roles, not just that policies exist. Run with `supabase test db`.
--
-- Technique: auth.uid() (Supabase's own function) reads
-- `current_setting('request.jwt.claims')::json->>'sub'`, exactly what
-- PostgREST sets from a real JWT. `simulate_user()` reproduces that without
-- needing a real token, then every subsequent query in the transaction runs
-- exactly as RLS would evaluate it for that principal.
--
-- Depends on supabase/seed.sql's fixtures (all synthetic — docs/00 §15).
-- =============================================================================

begin;

-- Whether `supabase test db` has already installed pgtap by this point is
-- inconsistent across a fresh `db reset` (observed both "already installed"
-- and "plan() does not exist" on different runs). CREATE EXTENSION IF NOT
-- EXISTS is not safe under a genuine concurrent race (observed once: 23505
-- duplicate_object on pg_extension_name_index), so the guard is explicit
-- rather than relying on IF NOT EXISTS alone.
do $$
begin
  create extension if not exists pgtap with schema extensions;
exception when duplicate_object then
  null;
end;
$$;

select plan(27);

-- -----------------------------------------------------------------------------
-- Helper: switch the transaction's simulated principal.
-- -----------------------------------------------------------------------------
create schema if not exists tests;
-- Every subsequent call in this file runs as anon/authenticated (that is the
-- whole point of the simulation), so the helper functions themselves — and
-- the schema they live in — need to stay callable after the role switch.
grant usage on schema tests to anon, authenticated;

-- NOT security definer: `SET ROLE` (which is what setting the special
-- "role" GUC performs) is disallowed inside a security-definer function
-- ("cannot set parameter "role" within security-definer function"). Plain
-- SQL functions plus the USAGE/EXECUTE grants above are what let a session
-- currently running as anon/authenticated still call these to switch again.
create or replace function tests.simulate_user(p_user_id uuid)
returns void
language sql
as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_user_id, 'role', 'authenticated')::text, true);
  select set_config('role', 'authenticated', true);
$$;

create or replace function tests.simulate_anon()
returns void
language sql
as $$
  select set_config('request.jwt.claims', '', true);
  select set_config('role', 'anon', true);
$$;

grant execute on function tests.simulate_user(uuid) to anon, authenticated;
grant execute on function tests.simulate_anon() to anon, authenticated;

-- Fixture ids from supabase/seed.sql
-- admin              10000000-0000-0000-0000-000000000001
-- hod.cs              10000000-0000-0000-0000-000000000002
-- faculty.ds          10000000-0000-0000-0000-000000000003
-- mentor.cs           10000000-0000-0000-0000-000000000004
-- incharge.cs3a       10000000-0000-0000-0000-000000000005
-- student.rahul       10000000-0000-0000-0000-000000000006 -> student id ...701
-- student.priya       10000000-0000-0000-0000-000000000007 -> student id ...702
-- department CS       20000000-0000-0000-0000-000000000001
-- section III-A       20000000-0000-0000-0000-000000000401

-- =============================================================================
-- 1. Anonymous access is denied outright.
-- =============================================================================
select tests.simulate_anon();

-- anon has no GRANT at all on these tables (migration 20260101000700 revokes
-- every privilege from anon as belt-and-braces on top of RLS), so Postgres
-- refuses the query outright with "permission denied" rather than returning
-- an empty, RLS-filtered result set. That is a stronger guarantee than "RLS
-- filters to zero rows" would be, so we assert the actual (better) behaviour.
select throws_ok(
  $$ select count(*) from public.students $$,
  '42501', null,
  'anon has no grant on students at all — not even an RLS-filtered empty read'
);

select throws_ok(
  $$ select count(*) from public.departments $$,
  '42501', null,
  'anon has no grant on departments at all'
);

-- =============================================================================
-- 2. Student sees only their own record, never a classmate's.
-- =============================================================================
select tests.simulate_user('10000000-0000-0000-0000-000000000006'); -- Rahul

select is(
  (select count(*) from public.students)::int, 1,
  'student sees exactly one student row'
);

select is(
  (select register_number from public.students limit 1), 'REG2023CS041',
  'the one row a student sees is their own'
);

select is(
  (select count(*) from public.students where id = '20000000-0000-0000-0000-000000000702')::int, 0,
  'a student cannot read a classmate''s record even though they share a section'
);

-- A student cannot write their own core academic fields. The USING clause
-- of students_update requires students.write, which STUDENT never holds, so
-- the row is simply not selected for the update — Postgres does not raise an
-- exception for an UPDATE that matches zero rows, it just updates zero of
-- them. That is still "the write was blocked"; asserting on the affected row
-- count is the correct check here, not throws_ok. A data-modifying WITH must
-- be the top-level statement, so it is captured into a temp table rather
-- than nested inside is()'s scalar-subquery argument.
create temp table _t_student_write_attempt as
with attempt as (
  update public.students set register_number = 'HACKED'
  where id = '20000000-0000-0000-0000-000000000701'
  returning 1
)
select * from attempt;

select is(
  (select count(*) from _t_student_write_attempt)::int, 0,
  'student cannot self-edit register_number (RLS silently updates zero rows, no matching policy grants it)'
);

drop table _t_student_write_attempt;

-- =============================================================================
-- 3. Faculty sees only students enrolled in a subject they are assigned to
--    teach, in the section they teach it to — not the whole section roster.
-- =============================================================================
select tests.simulate_user('10000000-0000-0000-0000-000000000003'); -- faculty.ds, assigned to CS501/section A

select is(
  (select count(*) from public.students)::int, 2,
  'faculty sees the students enrolled in their assigned subject'
);

select is(
  (select count(*) from public.faculty_subject_assignments)::int, 1,
  'faculty sees their own teaching assignment'
);

-- =============================================================================
-- 4. Mentor sees only their explicit mentees.
-- =============================================================================
select tests.simulate_user('10000000-0000-0000-0000-000000000004'); -- mentor.cs, mentors both seed students

select is(
  (select count(*) from public.students)::int, 2,
  'mentor sees both assigned mentees'
);

select ok(
  (select bool_and(mentor_id = '20000000-0000-0000-0000-000000000602') from public.students),
  'every student a mentor can see is actually assigned to them'
);

-- =============================================================================
-- 5. Class in-charge sees their whole section, HOD sees the whole department.
-- =============================================================================
select tests.simulate_user('10000000-0000-0000-0000-000000000005'); -- incharge.cs3a

select is(
  (select count(*) from public.students where section_id = '20000000-0000-0000-0000-000000000401')::int, 2,
  'class in-charge sees the full roster of their assigned section'
);

select tests.simulate_user('10000000-0000-0000-0000-000000000002'); -- hod.cs

select is(
  (select count(*) from public.students where department_id = '20000000-0000-0000-0000-000000000001')::int, 2,
  'HOD sees every student in their department'
);

select is(
  (select count(*) from public.sections where department_id = '20000000-0000-0000-0000-000000000001')::int, 1,
  'HOD sees sections in their own department'
);

-- HOD writes are department-scoped: creating a section in a foreign
-- department must fail the WITH CHECK clause.
select throws_ok(
  $$ insert into public.sections (department_id, course_id, academic_year_id, name, year)
     values ('20000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000102',
             '20000000-0000-0000-0000-000000000201', 'X', 1) $$,
  null, null,
  'HOD of CS cannot create a section in the AI&DS department'
);

-- =============================================================================
-- 6. Cross-department isolation: seed a second department/section/student
--    that none of the CS-scoped principals should ever see.
-- =============================================================================
-- `reset role` back to the connecting (superuser) role for fixture setup: the
-- `authenticated` role — which is what tests.simulate_user() switches to —
-- has no INSERT grant on `auth.users` (only Supabase's own admin roles do),
-- so building this fixture "as" the admin principal fails outright rather
-- than being scope-restricted. Fixture setup happens as the real connecting
-- role; RLS is what's under test on the *read* side below, not on setup.
reset role;
select set_config('request.jwt.claims', '', true);

insert into public.sections (id, department_id, course_id, academic_year_id, name, year)
values ('30000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000002',
        '20000000-0000-0000-0000-000000000102', '20000000-0000-0000-0000-000000000201', 'A', 3);

-- email_change/email_change_token_new set explicitly — see supabase/seed.sql
-- header comment and docs/22_ARCHITECTURE_DECISIONS.md ADR-006.
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, confirmation_token, recovery_token, email_change, email_change_token_new)
values ('00000000-0000-0000-0000-000000000000', '30000000-0000-0000-0000-000000000002', 'authenticated', 'authenticated',
        'outsider@cims.test', crypt('x', gen_salt('bf')), now(), now(), now(), '', '', '', '');

insert into public.students (id, user_id, department_id, course_id, section_id, academic_year_id, register_number, year, status)
values ('30000000-0000-0000-0000-000000000003', '30000000-0000-0000-0000-000000000002',
        '20000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000102',
        '30000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000201',
        'REG2023AIDS001', 3, 'ACTIVE');

select tests.simulate_user('10000000-0000-0000-0000-000000000002'); -- hod.cs
select is(
  (select count(*) from public.students where id = '30000000-0000-0000-0000-000000000003')::int, 0,
  'HOD of CS cannot see a student in the AI&DS department'
);

select tests.simulate_user('10000000-0000-0000-0000-000000000003'); -- faculty.ds
select is(
  (select count(*) from public.students where id = '30000000-0000-0000-0000-000000000003')::int, 0,
  'faculty of CS cannot see a student in the AI&DS department'
);

select tests.simulate_user('10000000-0000-0000-0000-000000000004'); -- mentor.cs
select is(
  (select count(*) from public.students where id = '30000000-0000-0000-0000-000000000003')::int, 0,
  'mentor with CS mentees cannot see an unrelated AI&DS student'
);

select tests.simulate_user('10000000-0000-0000-0000-000000000006'); -- Rahul (student)
select is(
  (select count(*) from public.students where id = '30000000-0000-0000-0000-000000000003')::int, 0,
  'a student cannot see a student in a different department'
);

-- =============================================================================
-- 7. Admin reach is global, but still capability-gated (not an RLS bypass).
-- =============================================================================
select tests.simulate_user('10000000-0000-0000-0000-000000000001');

select is(
  (select count(*) from public.students)::int, 3,
  'admin sees every student across every department'
);

select ok(
  (select cims.has_permission('audit.read')),
  'admin holds audit.read'
);

-- =============================================================================
-- 8. cims.my_permissions / has_permission never grant capability without an
--    active, in-window role assignment.
-- =============================================================================
select tests.simulate_user('10000000-0000-0000-0000-000000000006');
select ok(
  not cims.has_permission('students.write'),
  'a student never holds students.write'
);
select ok(
  cims.has_permission('attendance.read'),
  'a student holds attendance.read (their own)'
);

-- Expire the student's role assignment and confirm derived capability
-- disappears. Note what this does NOT claim: students_select_scoped and
-- cims.my_student_ids() both carry a deliberate, separate `user_id =
-- auth.uid()` clause so a principal can always read the row that IS their
-- own identity, independent of role-administration timing — the actual
-- kill switch for a student's standing is public.users.status /
-- public.students.status (checked by cims.is_active_user() and enforced
-- everywhere), not a STUDENT role assignment's valid_until. That split is
-- intentional (docs/04: "Students see their own data" is not conditioned on
-- an active role grant) and applied consistently, so this test asserts the
-- capability-level effect of expiry, not a blanket loss of the own-row read.
select tests.simulate_user('10000000-0000-0000-0000-000000000001');
update public.user_roles set valid_until = now() - interval '1 second'
where user_id = '10000000-0000-0000-0000-000000000006';

select tests.simulate_user('10000000-0000-0000-0000-000000000006');
select ok(
  not cims.has_permission('attendance.read'),
  'an expired role assignment loses derived capability (attendance.read)'
);
select is(
  (select count(*) from public.students)::int, 1,
  'the student can still read their own row by identity even with an expired role assignment (own-record access is not gated by role currency — see comment above)'
);
-- Restore for any later test files running in the same reset.
select tests.simulate_user('10000000-0000-0000-0000-000000000001');
update public.user_roles set valid_until = null
where user_id = '10000000-0000-0000-0000-000000000006';

-- =============================================================================
-- 9. Role-scope validation trigger.
-- =============================================================================
select throws_ok(
  $$ insert into public.user_roles (user_id, role_id, department_id)
     select '10000000-0000-0000-0000-000000000006', id, '20000000-0000-0000-0000-000000000001'
     from public.roles where key = 'ADMIN' $$,
  null, null,
  'a GLOBAL-scope role (ADMIN) rejects a department_id'
);

select throws_ok(
  $$ insert into public.user_roles (user_id, role_id)
     select '10000000-0000-0000-0000-000000000006', id from public.roles where key = 'HOD' $$,
  null, null,
  'a DEPARTMENT-scope role (HOD) requires a department_id'
);

-- =============================================================================
-- 10. Audit hash chain integrity.
-- =============================================================================
select is(
  (select count(*) from cims.verify_audit_chain())::int, 0,
  'the audit hash chain has no detected tampering after all of the above writes'
);

select * from finish();
rollback;
