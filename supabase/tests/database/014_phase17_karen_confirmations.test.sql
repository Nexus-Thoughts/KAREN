-- =============================================================================
-- 014_phase17_karen_confirmations.test.sql
--
-- Covers supabase/migrations/20260101002500_karen_confirmations.sql:
-- karen_pending_actions RLS (a user only ever sees their own proposed
-- actions) and karen_send_notification's reachability check — the
-- SECURITY DEFINER re-derivation of students_select_scoped's own predicate.
-- =============================================================================

begin;

do $$
begin
  create extension if not exists pgtap with schema extensions;
exception when duplicate_object then
  null;
end;
$$;

select plan(6);

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

-- Fixtures (supabase/seed.sql): faculty.ds (...0003) teaches CS501 to
-- III-A, which student.rahul (...0006) is enrolled in. faculty.hod (a HOD,
-- ...0002) is outside that department/section reach.

-- =============================================================================
-- 1. Faculty within reach can notify their own student.
-- =============================================================================
select tests.simulate_user('10000000-0000-0000-0000-000000000003'); -- faculty.ds

select lives_ok(
  $$ select public.karen_send_notification(
       (select id from public.students where user_id = '10000000-0000-0000-0000-000000000006'),
       'Class rescheduled', 'Tomorrow''s CS501 session moves to 2pm.'
     ) $$,
  'faculty.ds can notify rahul, a student they teach'
);

-- notifications_select_self (20260101001800) only lets a recipient read
-- their own notifications — faculty.ds, who just sent it, is not the
-- recipient, so this check must run as rahul, the actual recipient.
select tests.simulate_user('10000000-0000-0000-0000-000000000006'); -- rahul

select is(
  (select count(*)::int from public.notifications
   where recipient_id = '10000000-0000-0000-0000-000000000006' and type = 'ADMINISTRATIVE' and title = 'Class rescheduled'),
  1,
  'the notification actually lands, addressed to the right recipient'
);

-- =============================================================================
-- 2. A caller with no reach to the student is rejected — not silently
--    ignored, and no notification row is created either way.
--
-- student.priya (...0007) is in the same section as rahul but, as a plain
-- STUDENT, has no students.read permission at all, so she is the realistic
-- "authenticated, but cannot reach this other student" case.
-- =============================================================================
select tests.simulate_user('10000000-0000-0000-0000-000000000007'); -- student.priya

select throws_ok(
  $$ select public.karen_send_notification(
       (select id from public.students where user_id = '10000000-0000-0000-0000-000000000006'),
       'Should not send', 'x'
     ) $$,
  '42501'::character(5),
  null,
  'a student cannot notify a classmate — no students.read permission, no reach'
);

-- Same notifications_select_self constraint as test 1: check as rahul (the
-- only recipient a successful call here could possibly have targeted),
-- not as priya, who could never see it either way and would make this
-- assertion pass trivially regardless of whether the rejection actually
-- prevented the write.
select tests.simulate_user('10000000-0000-0000-0000-000000000006'); -- rahul

select is(
  (select count(*)::int from public.notifications where title = 'Should not send'),
  0,
  'the rejected attempt created no notification row'
);

-- =============================================================================
-- 3. karen_pending_actions RLS: a user only ever sees their own proposals.
-- =============================================================================
select tests.simulate_user('10000000-0000-0000-0000-000000000003'); -- faculty.ds

do $$
declare v_convo uuid;
begin
  insert into public.karen_conversations (user_id, title) values ('10000000-0000-0000-0000-000000000003', 'karen test')
  returning id into v_convo;
  insert into public.karen_pending_actions (user_id, conversation_id, tool_name, args, summary)
  values ('10000000-0000-0000-0000-000000000003', v_convo, 'notify_student',
          jsonb_build_object('studentId', 'x'), 'Send "hi" to rahul');
  perform set_config('tests.pending_id', (select id::text from public.karen_pending_actions order by created_at desc limit 1), false);
end;
$$;

select ok(
  (select count(*) from public.karen_pending_actions where id = current_setting('tests.pending_id')::uuid) = 1,
  'faculty.ds sees the pending action they just proposed'
);

select tests.simulate_user('10000000-0000-0000-0000-000000000006'); -- rahul, unrelated

select is(
  (select count(*)::int from public.karen_pending_actions where id = current_setting('tests.pending_id')::uuid),
  0,
  'a different user cannot see faculty.ds''s pending action'
);

select * from finish();
rollback;
