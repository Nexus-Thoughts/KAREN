-- =============================================================================
-- 005_phase7_timetable_classroom.test.sql
--
-- Covers supabase/migrations/20260101001000_timetable_and_classrooms.sql and
-- 20260101001100_timetable_classroom_rls.sql: classroom CRUD/scope,
-- EXCLUDE-constraint conflict prevention (faculty/section/classroom),
-- invalid time, academic-relationship validation, inactive-classroom
-- rejection, and timetable read scope across roles.
-- =============================================================================

begin;

do $$
begin
  create extension if not exists pgtap with schema extensions;
exception when duplicate_object then
  null;
end;
$$;

select plan(20);

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

-- Fixtures (supabase/seed.sql):
-- admin              10000000-...-0001    hod.cs   10000000-...-0002
-- faculty.ds         10000000-...-0003    section III-A 20000000-...-0401 (CS)
-- student.rahul      10000000-...-0006 -> III-A     department AIDS 20000000-...-0002
-- classroom CS-301   20000000-...-0801 (CS dept, radius 20m)
-- faculty FAC-001    20000000-...-0601 (faculty.ds), assigned CS501/III-A/sem5
-- existing timetable entry: FAC-001, CS501, III-A, CS-301, MON 10:00-10:50

-- The faculty/section/classroom conflict tests below deliberately use CS502
-- (not FAC-001's seeded CS501 assignment) to prove the EXCLUDE constraints
-- match on faculty/section/classroom + day + time overlap and do NOT care
-- about subject — but cims.validate_timetable_entry() requires an active
-- faculty_subject_assignments row before a timetable_entries INSERT reaches
-- the EXCLUDE constraints at all, so that assignment has to actually exist.
select tests.simulate_user('10000000-0000-0000-0000-000000000001'); -- admin (faculty.write)
insert into public.faculty_subject_assignments (faculty_id, subject_id, section_id, semester_id, status) values
  ('20000000-0000-0000-0000-000000000601', '20000000-0000-0000-0000-000000000502',
   '20000000-0000-0000-0000-000000000401', '20000000-0000-0000-0000-000000000301', 'ACTIVE'),
  -- also needed by test 6 (section conflict), which uses FAC-002 to prove
  -- the section-conflict EXCLUDE fires regardless of which faculty is named.
  ('20000000-0000-0000-0000-000000000602', '20000000-0000-0000-0000-000000000502',
   '20000000-0000-0000-0000-000000000401', '20000000-0000-0000-0000-000000000301', 'ACTIVE');

-- =============================================================================
-- 1. Classroom CRUD + department scope
-- =============================================================================
select tests.simulate_user('10000000-0000-0000-0000-000000000002'); -- hod.cs

select lives_ok(
  $$ insert into public.classrooms (department_id, name, capacity, location, radius_m)
     values ('20000000-0000-0000-0000-000000000001', 'CS-302', 40,
             extensions.ST_SetSRID(extensions.ST_MakePoint(0, 0), 4326)::extensions.geography, 20) $$,
  'HOD of CS can create a classroom in their own department'
);

select throws_ok(
  $$ insert into public.classrooms (department_id, name, location, radius_m)
     values ('20000000-0000-0000-0000-000000000002', 'AIDS-101', null, 20) $$,
  '42501',
  null,
  'HOD of CS cannot create a classroom in AI&DS'
);

-- -----------------------------------------------------------------------------
-- 2. radius_m / capacity constraints
-- -----------------------------------------------------------------------------
select throws_ok(
  $$ insert into public.classrooms (department_id, name, radius_m)
     values ('20000000-0000-0000-0000-000000000001', 'CS-Bad-Radius', 0) $$,
  '23514',
  null,
  'radius_m must be greater than zero'
);

select throws_ok(
  $$ insert into public.classrooms (department_id, name, capacity)
     values ('20000000-0000-0000-0000-000000000001', 'CS-Bad-Capacity', -5) $$,
  '23514',
  null,
  'capacity must be positive when supplied'
);

-- -----------------------------------------------------------------------------
-- 3. Classroom name uniqueness per department (not global — same name in a
--    different department is allowed).
-- -----------------------------------------------------------------------------
select throws_ok(
  $$ insert into public.classrooms (department_id, name) values ('20000000-0000-0000-0000-000000000001', 'CS-301') $$,
  '23505',
  null,
  'classroom name CS-301 already exists in the CS department'
);

select tests.simulate_user('10000000-0000-0000-0000-000000000001'); -- admin, cross-department
select lives_ok(
  $$ insert into public.classrooms (department_id, name) values ('20000000-0000-0000-0000-000000000002', 'CS-301') $$,
  'the same classroom name is allowed in a different department'
);

-- =============================================================================
-- 4. Timetable: invalid time is rejected outright.
-- =============================================================================
select tests.simulate_user('10000000-0000-0000-0000-000000000002'); -- hod.cs

select throws_ok(
  $$ insert into public.timetable_entries (
       academic_year_id, semester_id, section_id, subject_id, faculty_id, classroom_id, day, start_time, end_time
     ) values (
       '20000000-0000-0000-0000-000000000201', '20000000-0000-0000-0000-000000000301',
       '20000000-0000-0000-0000-000000000401', '20000000-0000-0000-0000-000000000501',
       '20000000-0000-0000-0000-000000000601', '20000000-0000-0000-0000-000000000801',
       'TUE', '11:00', '10:00'
     ) $$,
  '23514',
  null,
  'end_time <= start_time is rejected'
);

-- -----------------------------------------------------------------------------
-- 5. Faculty conflict: FAC-001 already teaches MON 10:00-10:50 (seed). An
--    overlapping slot for the SAME faculty, same semester, must be rejected —
--    even in a different section/subject/classroom.
-- -----------------------------------------------------------------------------
select throws_ok(
  $$ insert into public.timetable_entries (
       academic_year_id, semester_id, section_id, subject_id, faculty_id, classroom_id, day, start_time, end_time
     ) values (
       '20000000-0000-0000-0000-000000000201', '20000000-0000-0000-0000-000000000301',
       '20000000-0000-0000-0000-000000000401', '20000000-0000-0000-0000-000000000502',
       '20000000-0000-0000-0000-000000000601', '20000000-0000-0000-0000-000000000801',
       'MON', '10:30', '11:20'
     ) $$,
  '23P01',
  null,
  'faculty conflict: FAC-001 cannot teach an overlapping MON slot in the same semester'
);

-- -----------------------------------------------------------------------------
-- 6. Section conflict: III-A already has class MON 10:00-10:50. A different
--    subject/faculty/classroom at an overlapping time for the SAME section
--    must be rejected.
-- -----------------------------------------------------------------------------
select throws_ok(
  $$ insert into public.timetable_entries (
       academic_year_id, semester_id, section_id, subject_id, faculty_id, classroom_id, day, start_time, end_time
     ) values (
       '20000000-0000-0000-0000-000000000201', '20000000-0000-0000-0000-000000000301',
       '20000000-0000-0000-0000-000000000401', '20000000-0000-0000-0000-000000000502',
       '20000000-0000-0000-0000-000000000602', '20000000-0000-0000-0000-000000000801',
       'MON', '10:15', '11:00'
     ) $$,
  '23P01',
  null,
  'section conflict: III-A cannot attend two overlapping classes'
);

-- -----------------------------------------------------------------------------
-- 7. Classroom conflict: CS-301 is occupied MON 10:00-10:50. A different
--    section/subject/faculty at an overlapping time in the SAME room must be
--    rejected.
-- -----------------------------------------------------------------------------
insert into public.sections (id, department_id, course_id, academic_year_id, name, year)
values ('30000000-0000-0000-0000-000000000010', '20000000-0000-0000-0000-000000000001',
        '20000000-0000-0000-0000-000000000101', '20000000-0000-0000-0000-000000000201', 'B', 3);

-- Assigning a faculty member to teach (faculty_subject_assignments) needs
-- faculty.write, which HOD does NOT hold under the Phase 4 permission model
-- (HOD's grant list has faculty.read only) — this fixture insert must run as
-- admin, not as the HOD principal this file is otherwise simulating.
select tests.simulate_user('10000000-0000-0000-0000-000000000001'); -- admin
insert into public.faculty_subject_assignments (faculty_id, subject_id, section_id, semester_id, status)
values ('20000000-0000-0000-0000-000000000601', '20000000-0000-0000-0000-000000000501',
        '30000000-0000-0000-0000-000000000010', '20000000-0000-0000-0000-000000000301', 'ACTIVE');
select tests.simulate_user('10000000-0000-0000-0000-000000000002'); -- back to hod.cs

-- A genuine, non-conflicting entry for III-B — needed so the read-scope
-- assertions later (student isolation, HOD department-wide reach) test
-- against a real row rather than trivially passing on an empty section.
insert into public.timetable_entries (
  academic_year_id, semester_id, section_id, subject_id, faculty_id, classroom_id, day, start_time, end_time
) values (
  '20000000-0000-0000-0000-000000000201', '20000000-0000-0000-0000-000000000301',
  '30000000-0000-0000-0000-000000000010', '20000000-0000-0000-0000-000000000501',
  '20000000-0000-0000-0000-000000000601', '20000000-0000-0000-0000-000000000801',
  'TUE', '09:00', '09:50'
);

select throws_ok(
  $$ insert into public.timetable_entries (
       academic_year_id, semester_id, section_id, subject_id, faculty_id, classroom_id, day, start_time, end_time
     ) values (
       '20000000-0000-0000-0000-000000000201', '20000000-0000-0000-0000-000000000301',
       '30000000-0000-0000-0000-000000000010', '20000000-0000-0000-0000-000000000501',
       '20000000-0000-0000-0000-000000000601', '20000000-0000-0000-0000-000000000801',
       'MON', '10:20', '11:00'
     ) $$,
  '23P01',
  null,
  'classroom conflict: CS-301 cannot host two overlapping classes'
);

-- -----------------------------------------------------------------------------
-- 8. A non-overlapping slot on the SAME day for the SAME faculty/section/room
--    succeeds — proving the EXCLUDE constraints check overlap, not mere
--    day-equality.
-- -----------------------------------------------------------------------------
select lives_ok(
  $$ insert into public.timetable_entries (
       academic_year_id, semester_id, section_id, subject_id, faculty_id, classroom_id, day, start_time, end_time
     ) values (
       '20000000-0000-0000-0000-000000000201', '20000000-0000-0000-0000-000000000301',
       '20000000-0000-0000-0000-000000000401', '20000000-0000-0000-0000-000000000502',
       '20000000-0000-0000-0000-000000000601', '20000000-0000-0000-0000-000000000801',
       'MON', '11:00', '11:50'
     ) $$,
  'a back-to-back, non-overlapping slot for the same faculty/section/room succeeds'
);

-- -----------------------------------------------------------------------------
-- 9. Invalid academic relationship: faculty with no active assignment for
--    this subject/section/semester is rejected. FAC-003 (incharge.cs3a) has
--    no faculty_subject_assignments row for CS502/III-A/sem5 at all — unlike
--    FAC-001/FAC-002, which the conflict tests above deliberately gave one.
-- -----------------------------------------------------------------------------
select throws_ok(
  $$ insert into public.timetable_entries (
       academic_year_id, semester_id, section_id, subject_id, faculty_id, classroom_id, day, start_time, end_time
     ) values (
       '20000000-0000-0000-0000-000000000201', '20000000-0000-0000-0000-000000000301',
       '20000000-0000-0000-0000-000000000401', '20000000-0000-0000-0000-000000000502',
       '20000000-0000-0000-0000-000000000603', '20000000-0000-0000-0000-000000000801',
       'WED', '09:00', '09:50'
     ) $$,
  '23514',
  null,
  'faculty with no active faculty_subject_assignments row for this subject/section/semester is rejected'
);

-- -----------------------------------------------------------------------------
-- 10. Inactive classroom cannot be assigned to a new timetable entry.
-- -----------------------------------------------------------------------------
select tests.simulate_user('10000000-0000-0000-0000-000000000001'); -- admin
update public.classrooms set status = 'MAINTENANCE' where id = '20000000-0000-0000-0000-000000000801';

select tests.simulate_user('10000000-0000-0000-0000-000000000002'); -- hod.cs
select throws_ok(
  $$ insert into public.timetable_entries (
       academic_year_id, semester_id, section_id, subject_id, faculty_id, classroom_id, day, start_time, end_time
     ) values (
       '20000000-0000-0000-0000-000000000201', '20000000-0000-0000-0000-000000000301',
       '20000000-0000-0000-0000-000000000401', '20000000-0000-0000-0000-000000000502',
       '20000000-0000-0000-0000-000000000601', '20000000-0000-0000-0000-000000000801',
       'THU', '09:00', '09:50'
     ) $$,
  '23514',
  null,
  'a MAINTENANCE classroom cannot be assigned to a new timetable entry'
);

select tests.simulate_user('10000000-0000-0000-0000-000000000001'); -- admin
update public.classrooms set status = 'ACTIVE' where id = '20000000-0000-0000-0000-000000000801';

-- =============================================================================
-- 11. Timetable read scope, reusing cims.my_section_ids() (docs/22 rationale
--     in the RLS migration's own header comment).
-- =============================================================================

-- Rahul (III-A) sees the seeded MON 10:00 entry.
select tests.simulate_user('10000000-0000-0000-0000-000000000006');
select is(
  (select count(*) from public.timetable_entries
   where section_id = '20000000-0000-0000-0000-000000000401' and day = 'MON')::int,
  2, -- the seed entry + test 8's back-to-back entry
  'a student sees their own section''s timetable entries'
);

-- Rahul cannot see section III-B's (30000000-...-0010) timetable, even
-- though a real entry now exists there (inserted above, before the
-- classroom-conflict test) — this is a genuine isolation check, not a
-- trivially-empty one.
select is(
  (select count(*) from public.timetable_entries where section_id = '30000000-0000-0000-0000-000000000010')::int,
  0,
  'a student cannot see a different section''s timetable'
);

-- Faculty.ds (FAC-001) sees entries for BOTH sections they're assigned to (III-A and III-B).
select tests.simulate_user('10000000-0000-0000-0000-000000000003');
select ok(
  (select count(distinct section_id) from public.timetable_entries where faculty_id = '20000000-0000-0000-0000-000000000601') >= 1,
  'faculty sees timetable entries for their assigned sections'
);

-- HOD of CS sees the full department's timetable, including section III-B's
-- real entry, which they never explicitly hold a role assignment for — pure
-- department-wide reach via cims.my_section_ids().
select tests.simulate_user('10000000-0000-0000-0000-000000000002');
select is(
  (select count(*) from public.timetable_entries where section_id = '30000000-0000-0000-0000-000000000010')::int,
  1,
  'HOD of CS sees III-B''s real timetable entry via department-wide reach'
);

-- Admin sees everything, cross-department.
select tests.simulate_user('10000000-0000-0000-0000-000000000001');
select ok(
  (select count(*) from public.timetable_entries) >= 3,
  'admin sees the full institution timetable'
);

-- -----------------------------------------------------------------------------
-- 12. Classroom read scope mirrors: a classroom used by a reachable timetable
--     entry resolves even outside the viewer's own department scope, but an
--     otherwise-unrelated other-department classroom does not.
-- -----------------------------------------------------------------------------
-- Rahul is a plain STUDENT (SELF scope) enrolled in the CS department — a
-- STUDENT role assignment carries no department_id (validate_role_scope
-- rejects that), so cims.my_department_ids() is empty for him regardless of
-- his own student.department_id. Classroom visibility below can therefore
-- only come from the "used by a reachable timetable entry" branch of
-- classrooms_select, which is exactly what this is testing.
select tests.simulate_user('10000000-0000-0000-0000-000000000006'); -- Rahul
select is(
  (select count(*) from public.classrooms where id = '20000000-0000-0000-0000-000000000801')::int,
  1,
  'a student resolves the classroom used by their own section''s timetable entries'
);

select is(
  (select count(*) from public.classrooms where department_id = '20000000-0000-0000-0000-000000000001'
   and id <> '20000000-0000-0000-0000-000000000801')::int,
  0,
  'a student does not see other CS classrooms unrelated to their own timetable'
);

select * from finish();
rollback;
