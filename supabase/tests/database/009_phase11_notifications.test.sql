-- =============================================================================
-- 009_phase11_notifications.test.sql
--
-- Covers supabase/migrations/20260101001900_notifications_engine.sql and
-- 20260101002000_notifications_engine_functions.sql: the enqueue/deliver
-- lifecycle, deduplication, retry/exhaustion, the self-update column guard,
-- and RLS scope.
--
-- notifications_select_self is deliberately recipient-only (no admin
-- bypass) — a caller enqueuing/failing/retrying a notification on someone
-- else's behalf (as every real caller here does, since enqueue always runs
-- SECURITY DEFINER from an engine function, never from the recipient) can
-- never read the row back through ordinary RLS. State assertions in
-- sections 1-3 therefore run after `reset role` (as the connecting
-- superuser, which bypasses RLS entirely) to check actual persisted state;
-- sections 4-5 re-simulate the real recipient/non-recipient specifically to
-- exercise RLS and the self-update guard themselves.
-- =============================================================================

begin;

do $$
begin
  create extension if not exists pgtap with schema extensions;
exception when duplicate_object then
  null;
end;
$$;

select plan(14);

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
-- 1. Enqueue delivers synchronously (no external channel exists in this
--    environment — see 20260101002000's header comment).
-- =============================================================================
select tests.simulate_user('10000000-0000-0000-0000-000000000001'); -- admin, service-style caller

do $$
declare
  v_id uuid;
begin
  v_id := cims.enqueue_notification(
    '10000000-0000-0000-0000-000000000004', 'SYSTEM', 'Test notification', 'body text',
    'test_entity', 'abc123', 'test:enqueue-1'
  );
  perform set_config('tests.notif_id_1', v_id::text, true);
end;
$$;

reset role;
select set_config('request.jwt.claims', '', true);

select is(
  (select status::text from public.notifications where id = current_setting('tests.notif_id_1')::uuid),
  'SENT',
  'enqueue_notification delivers synchronously to SENT (in-app delivery has no failure mode)'
);

select is(
  (select delivery_attempts from public.notifications where id = current_setting('tests.notif_id_1')::uuid),
  1,
  'delivery_attempts is incremented on delivery'
);

-- =============================================================================
-- 2. Deduplication: a second enqueue with the same (recipient, dedup_key)
--    returns the same row, not a new one.
-- =============================================================================
select tests.simulate_user('10000000-0000-0000-0000-000000000001'); -- admin again

do $$
declare
  v_id uuid;
begin
  v_id := cims.enqueue_notification(
    '10000000-0000-0000-0000-000000000004', 'SYSTEM', 'Different title', 'different body',
    'test_entity', 'abc123', 'test:enqueue-1'
  );
  perform set_config('tests.notif_id_2', v_id::text, true);
end;
$$;

reset role;
select set_config('request.jwt.claims', '', true);

select is(
  current_setting('tests.notif_id_2'),
  current_setting('tests.notif_id_1'),
  'a duplicate dedup_key returns the existing notification id, not a new row'
);

select is(
  (select count(*) from public.notifications where dedup_key = 'test:enqueue-1')::int,
  1,
  'exactly one row exists for the dedup key despite two enqueue calls'
);

select is(
  (select title from public.notifications where id = current_setting('tests.notif_id_1')::uuid),
  'Test notification',
  'the original row content is untouched by the deduplicated second call'
);

-- =============================================================================
-- 3. Retry/exhaustion: repeated delivery failures move SENT -> RETRYING ->
--    EXHAUSTED once max_delivery_attempts (default 3) is reached.
--
-- Enqueue itself already counts as attempt 1 (synchronous in-app delivery —
-- see this file's header comment), so two further recorded failures (2, 3)
-- are what actually exhausts a 3-attempt notification; this mirrors a real
-- external channel where the first send genuinely succeeded and only later
-- retries fail.
-- =============================================================================
select tests.simulate_user('10000000-0000-0000-0000-000000000001'); -- admin again

do $$
declare
  v_id uuid;
begin
  v_id := cims.enqueue_notification(
    '10000000-0000-0000-0000-000000000002', 'SYSTEM', 'Retry test', 'body',
    null, null, 'test:retry-1'
  );
  perform set_config('tests.notif_id_3', v_id::text, true);
  perform cims.record_delivery_failure(v_id, 'simulated transport error 1');
end;
$$;

reset role;
select set_config('request.jwt.claims', '', true);

select is(
  (select status::text from public.notifications where id = current_setting('tests.notif_id_3')::uuid),
  'RETRYING',
  'the first recorded failure (attempt 2 of 3 max) moves the row to RETRYING, not EXHAUSTED'
);

select cims.record_delivery_failure(current_setting('tests.notif_id_3')::uuid, 'simulated transport error 2');

select is(
  (select status::text from public.notifications where id = current_setting('tests.notif_id_3')::uuid),
  'EXHAUSTED',
  'the second recorded failure (attempt 3 of 3 max) exhausts the notification'
);

select is(
  (select delivery_attempts from public.notifications where id = current_setting('tests.notif_id_3')::uuid),
  3,
  'delivery_attempts counts the initial synchronous delivery plus both recorded failures'
);

select is(
  (select failed_reason from public.notifications where id = current_setting('tests.notif_id_3')::uuid),
  'simulated transport error 2',
  'failed_reason holds the most recent failure reason'
);

-- =============================================================================
-- 4. Self-update guard: the recipient can mark their own notification read,
--    but cannot rewrite its content via a plain UPDATE.
-- =============================================================================
select tests.simulate_user('10000000-0000-0000-0000-000000000004'); -- mentor.cs, recipient of notif_id_1

select public.mark_notification_read(current_setting('tests.notif_id_1')::uuid);

select is(
  (select status::text from public.notifications where id = current_setting('tests.notif_id_1')::uuid),
  'READ',
  'mark_notification_read moves status to READ'
);

select ok(
  (select read_at from public.notifications where id = current_setting('tests.notif_id_1')::uuid) is not null,
  'mark_notification_read sets read_at'
);

update public.notifications
set title = 'Tampered title', status = 'EXHAUSTED'
where id = current_setting('tests.notif_id_1')::uuid;

select is(
  (select title from public.notifications where id = current_setting('tests.notif_id_1')::uuid),
  'Test notification',
  'a recipient cannot rewrite their own notification''s title via a direct UPDATE — cims.restrict_notification_self_update reverts it'
);

select is(
  (select status::text from public.notifications where id = current_setting('tests.notif_id_1')::uuid),
  'READ',
  'a recipient cannot set status to an arbitrary delivery-lifecycle value — only READ is permitted'
);

-- =============================================================================
-- 5. RLS scope: a different user cannot see or mark-read someone else's notification.
-- =============================================================================
select tests.simulate_user('10000000-0000-0000-0000-000000000006'); -- student.rahul, not the recipient

select is(
  (select count(*) from public.notifications where id = current_setting('tests.notif_id_1')::uuid)::int,
  0,
  'a non-recipient cannot see another user''s notification'
);

select * from finish();
rollback;
