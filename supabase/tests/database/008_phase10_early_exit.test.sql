-- =============================================================================
-- 008_phase10_early_exit.test.sql
--
-- Covers supabase/migrations/20260101001700_early_exit_monitoring.sql and
-- 20260101001800_early_exit_rls_and_functions.sql: the presence state
-- machine's false-positive protection, duplicate-alert prevention,
-- authorized-exit skip, notification fan-out, and RLS scope.
--
-- Campus geofence: none exists in seed.sql (docs/00 blocker #3 — no real
-- campus polygon). This file creates its own synthetic campus polygon
-- (a ~222m square centred on Null Island, matching 006_phase8_geofences.test.sql's
-- convention) inside its own transaction so it never touches other files'
-- state, then rolls it back like everything else here.
-- =============================================================================

begin;

do $$
begin
  create extension if not exists pgtap with schema extensions;
exception when duplicate_object then
  null;
end;
$$;

select plan(15);

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
-- Fixtures: a campus polygon covering Null Island, and presence_config set
-- to a college-hours window that safely covers "right now" for the whole
-- test run (avoids the exact class of clock_timestamp()-vs-frozen-now()
-- bugs documented in docs/22 ADR-016 — confirm_early_exit compares against
-- p_confirmed_at::time, which is the sample's own clock_timestamp()-based
-- recorded_at, so college hours just need to safely bracket the full range
-- of times this test could plausibly execute across).
-- -----------------------------------------------------------------------------
reset role;
select set_config('request.jwt.claims', '', true);

insert into public.geofences (id, type, name, boundary) values (
  '40000000-0000-0000-0000-000000000101', 'CAMPUS', 'Test Campus',
  'SRID=4326;POLYGON((-0.001 -0.001, 0.001 -0.001, 0.001 0.001, -0.001 0.001, -0.001 -0.001))'
);

update public.presence_config set college_start_time = '00:00', college_end_time = '23:59';

-- =============================================================================
-- 1. A single outside-campus sample does NOT confirm an exit (exit_confirmation_samples = 2).
-- =============================================================================
select tests.simulate_user('10000000-0000-0000-0000-000000000006'); -- Rahul
select public.submit_location(1, 1, 5); -- far outside the campus polygon

select is(
  (select state::text from public.student_presence_state where student_id = '20000000-0000-0000-0000-000000000701'),
  'EXIT_CANDIDATE',
  'a single outside-campus sample moves the student to EXIT_CANDIDATE, not a confirmed exit'
);

select is(
  (select count(*) from public.early_exit_events where student_id = '20000000-0000-0000-0000-000000000701')::int,
  0,
  'no early_exit_events row exists yet — one sample never confirms an exit'
);

-- =============================================================================
-- 2. A second consecutive outside sample confirms the exit and creates
--    exactly one event.
-- =============================================================================
select public.submit_location(1, 1.001, 5); -- still outside

select is(
  (select state::text from public.student_presence_state where student_id = '20000000-0000-0000-0000-000000000701'),
  'OUTSIDE',
  'a second consecutive outside sample confirms OUTSIDE'
);

select is(
  (select count(*) from public.early_exit_events where student_id = '20000000-0000-0000-0000-000000000701')::int,
  1,
  'exactly one early_exit_events row was created on confirmation'
);

select is(
  (select verification_state::text from public.early_exit_events where student_id = '20000000-0000-0000-0000-000000000701'),
  'EXIT_CONFIRMED',
  'the event is EXIT_CONFIRMED (not authorized — no authorized_exits row exists for Rahul today)'
);

-- =============================================================================
-- 3. Duplicate protection: further outside samples do not create a second event.
-- =============================================================================
select public.submit_location(1, 1.002, 5);
select public.submit_location(2, 2, 5);

select is(
  (select count(*) from public.early_exit_events where student_id = '20000000-0000-0000-0000-000000000701')::int,
  1,
  'repeated outside samples never create a second event while one is still open'
);

-- =============================================================================
-- 4. Notification fan-out: mentor, class in-charge and HOD (all real seeded
--    relationships for Rahul) each received a notification.
-- =============================================================================
select tests.simulate_user('10000000-0000-0000-0000-000000000004'); -- mentor.cs (Rahul's mentor)
select ok(
  exists (select 1 from public.notifications where recipient_id = '10000000-0000-0000-0000-000000000004' and type = 'EARLY_EXIT'),
  'the mentor received an early-exit notification'
);

select tests.simulate_user('10000000-0000-0000-0000-000000000005'); -- incharge.cs3a (Rahul's class in-charge)
select ok(
  exists (select 1 from public.notifications where recipient_id = '10000000-0000-0000-0000-000000000005' and type = 'EARLY_EXIT'),
  'the class in-charge received an early-exit notification'
);

select tests.simulate_user('10000000-0000-0000-0000-000000000002'); -- hod.cs (HOD of Rahul's department)
select ok(
  exists (select 1 from public.notifications where recipient_id = '10000000-0000-0000-0000-000000000002' and type = 'EARLY_EXIT'),
  'the HOD received an early-exit notification'
);

-- =============================================================================
-- 5. Re-entry: two consecutive inside samples close the open event and
--    return the student to INSIDE.
-- =============================================================================
select tests.simulate_user('10000000-0000-0000-0000-000000000006'); -- Rahul
select public.submit_location(0.0001, 0.0001, 5); -- back inside the campus polygon

select is(
  (select state::text from public.student_presence_state where student_id = '20000000-0000-0000-0000-000000000701'),
  'REENTRY_CANDIDATE',
  'a single inside sample after OUTSIDE moves to REENTRY_CANDIDATE, not immediately INSIDE'
);

select public.submit_location(0.0001, 0.0001, 5); -- second corroborating inside sample

select is(
  (select state::text from public.student_presence_state where student_id = '20000000-0000-0000-0000-000000000701'),
  'INSIDE',
  'a second corroborating inside sample confirms re-entry'
);

select is(
  (select re_entered_at is not null from public.early_exit_events where student_id = '20000000-0000-0000-0000-000000000701'),
  true,
  're-entry closes the SAME event row (re_entered_at set), not a new row'
);

-- =============================================================================
-- 6. Authorized early exit: an approved authorized_exits row skips the
--    notification fan-out entirely.
-- =============================================================================
select tests.simulate_user('10000000-0000-0000-0000-000000000002'); -- hod.cs, exit_events.authorize
insert into public.authorized_exits (student_id, exit_date, permitted_exit_time, reason, status, approved_by)
values ('20000000-0000-0000-0000-000000000702', current_date, '00:00', 'Medical appointment, approved in advance.', 'APPROVED', '10000000-0000-0000-0000-000000000002');

select tests.simulate_user('10000000-0000-0000-0000-000000000007'); -- Priya
select public.submit_location(1, 1, 5);
select public.submit_location(1, 1.001, 5);

select is(
  (select verification_state::text from public.early_exit_events where student_id = '20000000-0000-0000-0000-000000000702'),
  'AUTHORIZED_EARLY_EXIT',
  'an approved authorized_exits row marks the confirmed event AUTHORIZED_EARLY_EXIT'
);

select tests.simulate_user('10000000-0000-0000-0000-000000000004'); -- mentor.cs (also Priya's mentor)
select is(
  (select count(*) from public.notifications
   where recipient_id = '10000000-0000-0000-0000-000000000004'
     and related_entity_id = (select id::text from public.early_exit_events where student_id = '20000000-0000-0000-0000-000000000702'))::int,
  0,
  'an authorized early exit does not trigger an alert notification'
);

-- =============================================================================
-- 7. RLS scope: a student sees only their own presence/exit records.
-- =============================================================================
select tests.simulate_user('10000000-0000-0000-0000-000000000006'); -- Rahul
select is(
  (select count(*) from public.early_exit_events where student_id = '20000000-0000-0000-0000-000000000702')::int,
  0,
  'a student cannot see a classmate''s early-exit event'
);

select * from finish();
rollback;
