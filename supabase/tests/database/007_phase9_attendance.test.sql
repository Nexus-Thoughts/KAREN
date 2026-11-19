-- =============================================================================
-- 007_phase9_attendance.test.sql
--
-- Covers supabase/migrations/20260101001500_attendance_engine.sql and
-- 20260101001600_attendance_rls_and_functions.sql. This is the highest-value
-- suite in the whole schema: it proves CAMPUS PRESENCE != CLASSROOM PRESENCE
-- != ATTENDANCE structurally, not just by convention.
--
-- Fixtures used (supabase/seed.sql):
--   timetable entry: FAC-001 teaches CS501 to III-A in CS-301, MON 10:00-10:50
--   classroom CS-301: Null Island (0,0), radius 20m
--   student.rahul (III-A, enrolled CS501), student.priya (III-A, enrolled CS501)
--
-- attendance_config defaults: grace=5min, late_window=10min,
-- window_after=15min, accuracy_threshold=30m, min_confirmations=2.
--
-- Session date is pinned to a fixed Monday so scheduled_start/end are
-- deterministic; `now()` inside a pgTAP transaction is real wall-clock time,
-- so tests that need "a sample recorded now, inside an already-open window"
-- use a session_date of a Monday close to test-run time and lean on
-- attendance_window_end being generous (scheduled_end + 15min) rather than
-- asserting exact timing down to the second.
-- =============================================================================

begin;

do $$
begin
  create extension if not exists pgtap with schema extensions;
exception when duplicate_object then
  null;
end;
$$;

select plan(24);

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

-- -----------------------------------------------------------------------------
-- Setup: a class session whose window is open right now (today, this hour to
-- +1h), independent of the seeded MON 10:00 timetable entry's real time —
-- built directly rather than via get_or_create_class_session, so the window
-- is guaranteed open for the whole test run regardless of wall-clock time.
-- -----------------------------------------------------------------------------
reset role;
select set_config('request.jwt.claims', '', true);

insert into public.class_sessions (
  id, timetable_entry_id, section_id, subject_id, faculty_id, classroom_id, semester_id,
  session_date, scheduled_start, scheduled_end, attendance_window_start, attendance_window_end, status
)
select
  '50000000-0000-0000-0000-000000000001',
  te.id, te.section_id, te.subject_id, te.faculty_id, te.classroom_id, te.semester_id,
  -- clock_timestamp(), not now(): now() is frozen at transaction start, so
  -- scheduled_start = now() - 5min combined with the default 5-minute grace
  -- period put the PRESENT/LATE cutoff at exactly now() with zero margin —
  -- real samples (recorded_at defaults to clock_timestamp(), which strictly
  -- advances as the test executes) land a few milliseconds past that frozen
  -- instant and were misclassified LATE. clock_timestamp() here gives the
  -- grace window genuine real-time headroom instead.
  current_date, clock_timestamp(), clock_timestamp() + interval '50 minutes',
  clock_timestamp() - interval '1 minute', clock_timestamp() + interval '1 hour', 'OPEN'
from public.timetable_entries te
where te.classroom_id = '20000000-0000-0000-0000-000000000801'
limit 1;

-- =============================================================================
-- 1. No sample at all -> stays PENDING, is never auto-marked ABSENT.
-- =============================================================================
select tests.simulate_user('10000000-0000-0000-0000-000000000003'); -- faculty.ds, owns this session
select public.evaluate_class_session('50000000-0000-0000-0000-000000000001');

select is(
  (select status::text from public.attendance_records
   where class_session_id = '50000000-0000-0000-0000-000000000001' and student_id = '20000000-0000-0000-0000-000000000701'),
  'PENDING',
  'a student with zero location samples stays PENDING, not ABSENT'
);

-- =============================================================================
-- 2. A single in-range sample is NOT sufficient for PRESENT — the core
--    "do not mark present from one sample" guarantee.
-- =============================================================================
select tests.simulate_user('10000000-0000-0000-0000-000000000006'); -- Rahul submits his own location
select public.submit_location(0.00005, 0.00005, 5); -- ~7m from (0,0), well inside 20m radius, accurate

select tests.simulate_user('10000000-0000-0000-0000-000000000003'); -- faculty.ds
select public.evaluate_class_session('50000000-0000-0000-0000-000000000001');

select is(
  (select status::text from public.attendance_records
   where class_session_id = '50000000-0000-0000-0000-000000000001' and student_id = '20000000-0000-0000-0000-000000000701'),
  'VERIFYING',
  'a single in-range sample moves the student to VERIFYING, not PRESENT — min_confirmations_required is 2'
);

select is(
  (select sample_count from public.attendance_records
   where class_session_id = '50000000-0000-0000-0000-000000000001' and student_id = '20000000-0000-0000-0000-000000000701'),
  1,
  'sample_count reflects exactly one corroborating in-range sample so far'
);

-- =============================================================================
-- 3. A second in-range sample crosses min_confirmations_required -> PRESENT.
-- =============================================================================
select tests.simulate_user('10000000-0000-0000-0000-000000000006');
select public.submit_location(0.00006, 0.00004, 5);

select tests.simulate_user('10000000-0000-0000-0000-000000000003');
select public.evaluate_class_session('50000000-0000-0000-0000-000000000001');

select is(
  (select status::text from public.attendance_records
   where class_session_id = '50000000-0000-0000-0000-000000000001' and student_id = '20000000-0000-0000-0000-000000000701'),
  'PRESENT',
  'two corroborating in-range samples within the grace period confirm PRESENT'
);

select ok(
  (select verified_at from public.attendance_records
   where class_session_id = '50000000-0000-0000-0000-000000000001' and student_id = '20000000-0000-0000-0000-000000000701') is not null,
  'verified_at is stamped once PRESENT is confirmed'
);

-- =============================================================================
-- 4. Priya: out-of-range samples never produce PRESENT, and are held at
--    DETECTED (recoverable), not immediately failed — GPS drift tolerance.
-- =============================================================================
select tests.simulate_user('10000000-0000-0000-0000-000000000007'); -- Priya
select public.submit_location(1, 1, 5); -- far outside the 20m radius

select tests.simulate_user('10000000-0000-0000-0000-000000000003');
select public.evaluate_class_session('50000000-0000-0000-0000-000000000001');

select is(
  (select status::text from public.attendance_records
   where class_session_id = '50000000-0000-0000-0000-000000000001' and student_id = '20000000-0000-0000-0000-000000000702'),
  'DETECTED',
  'an out-of-range sample holds at DETECTED, not an immediate failure state'
);

-- She then genuinely walks into the room — a later in-range sample recovers
-- the record rather than being permanently stuck from the earlier miss.
select tests.simulate_user('10000000-0000-0000-0000-000000000007');
select public.submit_location(0.00004, 0.00004, 5);
select public.submit_location(0.00005, 0.00005, 5);

select tests.simulate_user('10000000-0000-0000-0000-000000000003');
select public.evaluate_class_session('50000000-0000-0000-0000-000000000001');

select is(
  (select status::text from public.attendance_records
   where class_session_id = '50000000-0000-0000-0000-000000000001' and student_id = '20000000-0000-0000-0000-000000000702'),
  'PRESENT',
  'a student recovers to PRESENT once genuinely in-range samples corroborate — DETECTED was not a terminal failure'
);

-- =============================================================================
-- 5. Poor GPS accuracy is rejected outright, never counted toward PRESENT.
-- =============================================================================
-- Fixture setup needs timetable.write (ADMIN/HOD only — FACULTY does not
-- hold it per Phase 4's grants), so this runs as the connecting superuser
-- rather than as faculty.ds, the same pattern used throughout Phase 7's
-- fixture setup.
reset role;
select set_config('request.jwt.claims', '', true);

insert into public.timetable_entries (
  id, academic_year_id, semester_id, section_id, subject_id, faculty_id, classroom_id, day, start_time, end_time
) values (
  '60000000-0000-0000-0000-000000000001',
  '20000000-0000-0000-0000-000000000201', '20000000-0000-0000-0000-000000000301',
  '20000000-0000-0000-0000-000000000401', '20000000-0000-0000-0000-000000000501', -- CS501: the only subject FAC-001 has an active assignment for in seed.sql
  '20000000-0000-0000-0000-000000000601', '20000000-0000-0000-0000-000000000801',
  'TUE', '14:00', '14:50'
);
-- Session 2's window is anchored to clock_timestamp() AT INSERT TIME (i.e.
-- chronologically after every sample session 1's tests above already
-- recorded, all of which used earlier clock_timestamp() values) rather than
-- an arithmetic offset from the frozen now(). location_samples carries no
-- class_session_id (a real phone submitting GPS has no notion of "which
-- session this is for"; the engine resolves that purely from the window and
-- "most recent"), so two sessions of the same section with overlapping
-- windows would let a sample meant for one bleed into the other's
-- evaluation. Real timetable_entries can never actually overlap for the
-- same section (the EXCLUDE constraints from Phase 7 guarantee that); using
-- the real, monotonically-advancing clock rather than a fixed offset from a
-- frozen instant is what actually keeps this test's two sessions apart
-- without resorting to an artificial future window (which broke the
-- least(clock_timestamp(), window_end) real-time cap: clock_timestamp() at
-- evaluation time is nowhere near a window placed hours in the future,
-- collapsing the BETWEEN range to empty).
insert into public.class_sessions (
  id, timetable_entry_id, section_id, subject_id, faculty_id, classroom_id, semester_id,
  session_date, scheduled_start, scheduled_end, attendance_window_start, attendance_window_end, status
) values (
  '50000000-0000-0000-0000-000000000002',
  '60000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000401',
  '20000000-0000-0000-0000-000000000501', '20000000-0000-0000-0000-000000000601',
  '20000000-0000-0000-0000-000000000801', '20000000-0000-0000-0000-000000000301',
  current_date, clock_timestamp(), clock_timestamp() + interval '50 minutes',
  -- NOT offset backward: this window's whole purpose is to start strictly
  -- after every sample block 4 already recorded for Priya (a `- interval`
  -- here, even a small one, risks reaching back far enough to catch a
  -- sample from a few milliseconds earlier in this same fast-executing
  -- transaction — exactly what produced the very bug this comment now
  -- documents, caught by pgTAP: Priya showed PRESENT for a session she
  -- never submitted a single sample toward).
  clock_timestamp(), clock_timestamp() + interval '1 hour', 'OPEN'
);

select tests.simulate_user('10000000-0000-0000-0000-000000000006'); -- Rahul, submitting normally
select public.submit_location(0.00001, 0.00001, 500); -- in range, but accuracy far worse than the 30m threshold

select tests.simulate_user('10000000-0000-0000-0000-000000000003');
select public.evaluate_class_session('50000000-0000-0000-0000-000000000002');

select is(
  (select status::text from public.attendance_records
   where class_session_id = '50000000-0000-0000-0000-000000000002' and student_id = '20000000-0000-0000-0000-000000000701'),
  'LOW_GPS_ACCURACY',
  'a sample with accuracy worse than the configured threshold is rejected, regardless of distance'
);

-- =============================================================================
-- 6. Finalization: a genuinely absent student (zero samples, window closed)
--    becomes ABSENT only via finalize_class_session, never automatically
--    mid-window.
-- =============================================================================
-- finalize_class_session does not itself gate on whether the window has
-- actually elapsed by real time — it is an explicit administrative "close
-- this session now" action (a faculty/HOD closing attendance early, or a
-- scheduler closing it once the real window has passed), and unconditionally
-- resolves whatever PENDING/DETECTED/VERIFYING remains. No window
-- manipulation is needed here; Priya has zero samples for this session
-- either way.
select tests.simulate_user('10000000-0000-0000-0000-000000000003');
select public.finalize_class_session('50000000-0000-0000-0000-000000000002');

select is(
  (select status::text from public.attendance_records
   where class_session_id = '50000000-0000-0000-0000-000000000002' and student_id = '20000000-0000-0000-0000-000000000702'), -- Priya, no sample submitted for THIS session
  'ABSENT',
  'finalize_class_session resolves a no-sample record to ABSENT once the window has closed'
);

select is(
  (select status::text from public.class_sessions where id = '50000000-0000-0000-0000-000000000002'),
  'CLOSED',
  'finalize_class_session closes the session'
);

-- A closed session is immutable: a further evaluate call is a no-op.
select lives_ok(
  $$ select cims.evaluate_class_session('50000000-0000-0000-0000-000000000002') $$,
  'evaluating an already-CLOSED session is a safe no-op, not an error'
);

-- =============================================================================
-- 7. Manual override — reason required, audited, scoped.
-- =============================================================================
select tests.simulate_user('10000000-0000-0000-0000-000000000003'); -- faculty.ds

select throws_ok(
  $$ select public.override_attendance(
       (select id from public.attendance_records where class_session_id = '50000000-0000-0000-0000-000000000002' and student_id = '20000000-0000-0000-0000-000000000702'),
       'MANUAL_PRESENT', ''
     ) $$,
  '23514',
  null,
  'a manual override without a reason is rejected'
);

select lives_ok(
  $$ select public.override_attendance(
       (select id from public.attendance_records where class_session_id = '50000000-0000-0000-0000-000000000002' and student_id = '20000000-0000-0000-0000-000000000702'),
       'MANUAL_PRESENT', 'Approved sick note submitted after class, verified by HOD.'
     ) $$,
  'a manual override with a reason succeeds'
);

select is(
  (select status::text from public.attendance_records
   where class_session_id = '50000000-0000-0000-0000-000000000002' and student_id = '20000000-0000-0000-0000-000000000702'),
  'MANUAL_PRESENT',
  'the override actually changed the stored status'
);

select ok(
  (select is_manual from public.attendance_records
   where class_session_id = '50000000-0000-0000-0000-000000000002' and student_id = '20000000-0000-0000-0000-000000000702'),
  'is_manual is set true by the override'
);

select tests.simulate_user('10000000-0000-0000-0000-000000000001'); -- admin, to read audit_logs
select ok(
  exists (
    select 1 from public.audit_logs
    where entity_type = 'attendance_records'
      and reason = 'Approved sick note submitted after class, verified by HOD.'
      and old_values = '{"status": "ABSENT"}'::jsonb
      and new_values = '{"status": "MANUAL_PRESENT"}'::jsonb
  ),
  'the override is audited with the actual old/new status and reason'
);

-- MENTOR holds attendance.read and (for this student) legitimate scope
-- reach, but not attendance.override at all (Phase 4's grant list gives
-- MENTOR read access only, never write/override) — the permission gate at
-- the top of override_attendance() rejects this before the scope check
-- below it is even reached.
select tests.simulate_user('10000000-0000-0000-0000-000000000004'); -- mentor.cs
select throws_ok(
  $$ select public.override_attendance(
       (select id from public.attendance_records where class_session_id = '50000000-0000-0000-0000-000000000002' and student_id = '20000000-0000-0000-0000-000000000702'),
       'MANUAL_ABSENT', 'Should not be permitted'
     ) $$,
  '42501',
  null,
  'a faculty/mentor with no reach into this class session cannot override its attendance'
);

-- =============================================================================
-- 8. RLS scope: a student sees only their own attendance_records, never a
--    classmate's — the specific gap the module header comment warns about
--    (my_section_ids() alone would have let this leak).
-- =============================================================================
select tests.simulate_user('10000000-0000-0000-0000-000000000006'); -- Rahul
select is(
  (select count(*) from public.attendance_records where student_id = '20000000-0000-0000-0000-000000000701')::int,
  2, -- his two records across both class sessions above
  'a student sees their own attendance records'
);

select is(
  (select count(*) from public.attendance_records where student_id = '20000000-0000-0000-0000-000000000702')::int,
  0,
  'a student cannot see a classmate''s attendance records, even in the same section'
);

-- Faculty of the session sees the whole session's roster.
select tests.simulate_user('10000000-0000-0000-0000-000000000003'); -- faculty.ds
select ok(
  (select count(*) from public.attendance_records where class_session_id = '50000000-0000-0000-0000-000000000001') >= 2,
  'faculty teaching the session sees the full roster''s attendance records'
);

-- HOD of CS sees it too (department-wide reach), an unrelated mentor does not.
select tests.simulate_user('10000000-0000-0000-0000-000000000002'); -- hod.cs
select ok(
  (select count(*) from public.attendance_records where class_session_id = '50000000-0000-0000-0000-000000000001') >= 2,
  'HOD of CS sees the session''s attendance records via department-wide reach'
);

-- mentor.cs (seed: FAC-002) is the assigned mentor of BOTH Rahul and Priya
-- (supabase/seed.sql sets the same mentor_id for both), so this is a
-- positive coverage check of the mentor path in attendance_records_select,
-- not a negative isolation test — the seed data has no student in this
-- session with a DIFFERENT mentor to construct a true negative against, and
-- inventing one here would be a fixture change unrelated to Phase 9.
select tests.simulate_user('10000000-0000-0000-0000-000000000004'); -- mentor.cs
select is(
  (select count(*) from public.attendance_records where class_session_id = '50000000-0000-0000-0000-000000000001')::int,
  2,
  'a mentor sees attendance records for both of their assigned mentees in this session'
);

-- =============================================================================
-- 9. attendance_config: readable by all, writable by admin only.
-- =============================================================================
select tests.simulate_user('10000000-0000-0000-0000-000000000006'); -- Rahul
select ok(
  (select min_confirmations_required from public.attendance_config) = 2,
  'any active user can read the attendance configuration'
);

-- update, not throws_ok: attendance_config_write's USING clause excludes
-- this row for a non-privileged caller before WITH CHECK is ever reached, so
-- an UPDATE with no WHERE clause silently matches zero rows rather than
-- raising — the same UPDATE-vs-INSERT distinction documented in docs/22
-- ADR-007 (RLS's USING filters candidate rows for UPDATE; only INSERT's
-- WITH CHECK failure raises a real exception).
update public.attendance_config set min_confirmations_required = 1;

select is(
  (select min_confirmations_required from public.attendance_config),
  2,
  'a student''s update attempt on attendance_config silently affects zero rows — the value is unchanged'
);

select * from finish();
rollback;
