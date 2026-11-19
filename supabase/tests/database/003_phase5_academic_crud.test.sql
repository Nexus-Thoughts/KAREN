-- =============================================================================
-- 003_phase5_academic_crud.test.sql
--
-- Phase 5 — duplicate prevention and scoped-write coverage for the academic
-- CRUD surface exposed by DepartmentsPage / AcademicStructurePage /
-- StudentsPage / FacultyPage. Phase 4's suite (001_rbac_scope.test.sql)
-- already proves read isolation across roles/departments; this file adds the
-- write-side and uniqueness-constraint cases those UI forms depend on to
-- surface real Postgres error messages rather than a generic failure.
-- =============================================================================

begin;

do $$
begin
  create extension if not exists pgtap with schema extensions;
exception when duplicate_object then
  null;
end;
$$;

select plan(9);

-- See 002_auth_hardening.test.sql's copy of this same block for why it is
-- duplicated per file rather than shared.
create schema if not exists tests;
grant usage on schema tests to anon, authenticated;

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

-- -----------------------------------------------------------------------------
-- 1. Department code uniqueness — DepartmentsPage's create form relies on this
--    constraint's error message surfacing through result.error (docs/50:
--    structured errors, not swallowed ones).
-- -----------------------------------------------------------------------------
select tests.simulate_user('10000000-0000-0000-0000-000000000001'); -- admin

select throws_ok(
  $$ insert into public.departments (code, name) values ('CS', 'Duplicate Computer Science') $$,
  '23505',
  null,
  'a second department cannot reuse the code CS'
);

-- -----------------------------------------------------------------------------
-- 2. Course code uniqueness is scoped per department, not global — the same
--    code in two different departments is allowed.
-- -----------------------------------------------------------------------------
select lives_ok(
  $$ insert into public.courses (department_id, code, name, duration_years)
     values ('20000000-0000-0000-0000-000000000003', 'BTECH-CS', 'B.Tech (ECE dept variant)', 4) $$,
  'the same course code is allowed in a different department'
);

select throws_ok(
  $$ insert into public.courses (department_id, code, name, duration_years)
     values ('20000000-0000-0000-0000-000000000001', 'BTECH-CS', 'Duplicate', 4) $$,
  '23505',
  null,
  'the same course code cannot repeat within the same department'
);

-- -----------------------------------------------------------------------------
-- 3. Section uniqueness: (course, academic_year, year, name).
-- -----------------------------------------------------------------------------
select throws_ok(
  $$ insert into public.sections (department_id, course_id, academic_year_id, name, year)
     values ('20000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000101',
             '20000000-0000-0000-0000-000000000201', 'A', 3) $$,
  '23505',
  null,
  'section III-A already exists for BTECH-CS/2026-2027 and cannot be duplicated'
);

-- -----------------------------------------------------------------------------
-- 4. Subject code uniqueness is scoped per department.
-- -----------------------------------------------------------------------------
select throws_ok(
  $$ insert into public.subjects (department_id, course_id, code, name, semester_number)
     values ('20000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000101', 'CS501', 'Duplicate', 5) $$,
  '23505',
  null,
  'subject code CS501 already exists in the CS department'
);

-- -----------------------------------------------------------------------------
-- 5. Register number uniqueness (global, per docs/20_DB_SCHEMA_DETAIL.md).
-- -----------------------------------------------------------------------------
select throws_ok(
  $$ insert into public.students (department_id, course_id, academic_year_id, register_number, year, status)
     values ('20000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000101',
             '20000000-0000-0000-0000-000000000201', 'REG2023CS041', 3, 'ACTIVE') $$,
  '23505',
  null,
  'register number REG2023CS041 is already in use'
);

-- -----------------------------------------------------------------------------
-- 6. Employee ID uniqueness on faculty.
-- -----------------------------------------------------------------------------
select throws_ok(
  $$ insert into public.faculty (user_id, department_id, employee_id, designation)
     values ('10000000-0000-0000-0000-000000000004', '20000000-0000-0000-0000-000000000001', 'FAC-001', 'Lecturer') $$,
  '23505',
  null,
  'employee ID FAC-001 is already in use, even for a different user'
);

-- -----------------------------------------------------------------------------
-- 7. HOD (scoped to CS) CAN write within their own department — the positive
--    case Phase 4's suite didn't cover (it only proved HOD is REJECTED
--    writing into AI&DS).
-- -----------------------------------------------------------------------------
select tests.simulate_user('10000000-0000-0000-0000-000000000002'); -- hod.cs

select lives_ok(
  $$ insert into public.subjects (department_id, course_id, code, name, semester_number)
     values ('20000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000101', 'CS503', 'Compilers', 5) $$,
  'HOD of CS can create a subject inside their own department'
);

-- -----------------------------------------------------------------------------
-- 8. FACULTY holds no subjects.write at all (docs/03: FACULTY grants list
--    omits subjects.write) — RLS rejects it regardless of any scope match.
-- -----------------------------------------------------------------------------
select tests.simulate_user('10000000-0000-0000-0000-000000000003'); -- faculty.ds

-- Unlike UPDATE (where a failed USING clause just silently matches zero
-- rows — see 002_auth_hardening.test.sql test 2/6 and ADR-007's discussion
-- of the same distinction), a failed WITH CHECK on INSERT raises a real
-- exception: there is no existing row for USING to have silently excluded.
select throws_ok(
  $$ insert into public.subjects (department_id, course_id, code, name, semester_number)
     values ('20000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000101', 'CS504', 'Should not insert', 5) $$,
  '42501',
  null,
  'faculty cannot create a subject — subjects.write is not in the FACULTY grant list'
);

select * from finish();
rollback;
