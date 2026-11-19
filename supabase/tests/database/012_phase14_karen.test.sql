-- =============================================================================
-- 012_phase14_karen.test.sql
--
-- Covers supabase/migrations/20260101002300_karen_core.sql: conversation/
-- message RLS isolation between two different students, the tool-shape
-- constraint, karen_log_tool_call's audit-chain write, and
-- karen_check_rate_limit's threshold behaviour.
--
-- NOTE: written and reviewed against the same patterns every other
-- supabase/tests/database/*.test.sql file in this repo follows, but not
-- executed in this environment — no Docker daemon is available here to run
-- `supabase start`/`supabase test db`. Run it locally before relying on it.
-- =============================================================================

begin;

do $$
begin
  create extension if not exists pgtap with schema extensions;
exception when duplicate_object then
  null;
end;
$$;

select plan(12);

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

-- student.rahul@cims.test = 10000000-0000-0000-0000-000000000006
-- student.priya@cims.test = 10000000-0000-0000-0000-000000000007
select tests.simulate_user('10000000-0000-0000-0000-000000000006');

-- =============================================================================
-- 1. A user can create their own conversation and message.
-- =============================================================================
do $$
declare
  v_convo uuid;
begin
  insert into public.karen_conversations (user_id, title)
  values ('10000000-0000-0000-0000-000000000006', 'test conversation')
  returning id into v_convo;

  insert into public.karen_messages (conversation_id, role, content)
  values (v_convo, 'user', 'hello');

  perform set_config('tests.rahul_convo', v_convo::text, false);
end;
$$;

select ok(
  (select count(*) from public.karen_conversations where user_id = '10000000-0000-0000-0000-000000000006') = 1,
  'rahul sees his own conversation'
);

-- =============================================================================
-- 2. Ownership check: cannot insert a conversation for someone else.
-- =============================================================================
select throws_ok(
  $$ insert into public.karen_conversations (user_id, title) values ('10000000-0000-0000-0000-000000000007', 'not mine') $$,
  42501,
  null,
  'rahul cannot create a conversation owned by priya (RLS with check fails)'
);

-- =============================================================================
-- 3. Isolation: priya cannot see rahul's conversation or messages.
-- =============================================================================
select tests.simulate_user('10000000-0000-0000-0000-000000000007');

select is(
  (select count(*)::int from public.karen_conversations where id = current_setting('tests.rahul_convo')::uuid),
  0,
  'priya cannot see rahuls conversation'
);

select is(
  (select count(*)::int from public.karen_messages where conversation_id = current_setting('tests.rahul_convo')::uuid),
  0,
  'priya cannot see rahuls messages'
);

-- =============================================================================
-- 4. Tool-message shape constraint: role='tool' requires tool_name.
-- =============================================================================
select tests.simulate_user('10000000-0000-0000-0000-000000000006');

select throws_ok(
  $$ insert into public.karen_messages (conversation_id, role, content)
     select current_setting('tests.rahul_convo')::uuid, 'tool', 'x' $$,
  23514,
  null,
  'a tool-role message without tool_name violates karen_messages_tool_shape'
);

select lives_ok(
  $$ insert into public.karen_messages (conversation_id, role, tool_name, tool_args, tool_result)
     select current_setting('tests.rahul_convo')::uuid, 'tool', 'get_current_user', '{}'::jsonb, '{}'::jsonb $$,
  'a tool-role message with tool_name is accepted'
);

-- =============================================================================
-- 5. karen_log_tool_call writes an AI_TOOL_CALL audit row attributed to the caller.
-- =============================================================================
do $$
declare
  v_id bigint;
begin
  v_id := public.karen_log_tool_call('get_current_user', '{}'::jsonb, '{"ok":true}'::jsonb, false, gen_random_uuid());
  perform set_config('tests.audit_id', v_id::text, false);
end;
$$;

-- audit_logs_select requires audit.read (only ADMIN/HOD hold it — see
-- 20260101000700_rls_policies.sql) even to see one's *own* rows: the OR
-- branches (is_admin() / actor_id = auth.uid() / ...) only broaden which
-- ADMIN/HOD-held rows are visible, they don't substitute for the permission
-- itself. Rahul (a plain STUDENT, still simulated from test 4 above) could
-- never see the row karen_log_tool_call just wrote for him, no matter how
-- correctly it was written — verifying the write needs an audit.read-holding
-- principal, exactly like a real security reviewer checking KAREN's audit
-- trail would be an admin, not the student KAREN was acting on behalf of.
select tests.simulate_user('10000000-0000-0000-0000-000000000001'); -- admin

select ok(
  (select count(*) from public.audit_logs where id = current_setting('tests.audit_id')::bigint and action = 'AI_TOOL_CALL' and actor_id = '10000000-0000-0000-0000-000000000006')
  = 1,
  'karen_log_tool_call writes an AI_TOOL_CALL row attributed to the calling user'
);

-- Back to Rahul to perform the next write as the same caller as test 5,
-- then to admin again to read it back — same reasoning as above, kept as
-- two switches rather than one so this write is attributed to Rahul too
-- (only the two read-back assertions actually need audit.read).
select tests.simulate_user('10000000-0000-0000-0000-000000000006');

do $$
declare
  v_id bigint;
begin
  v_id := public.karen_log_tool_call('override_attendance', '{}'::jsonb, '{"ok":true}'::jsonb, true, gen_random_uuid());
  perform set_config('tests.write_audit_id', v_id::text, false);
end;
$$;

select tests.simulate_user('10000000-0000-0000-0000-000000000001'); -- admin

select ok(
  (select count(*) from public.audit_logs where id = current_setting('tests.write_audit_id')::bigint and action = 'AI_WRITE_ACTION')
  = 1,
  'karen_log_tool_call(p_is_write := true) writes an AI_WRITE_ACTION row'
);

-- Back to Rahul: the rate-limit assertions below count *his* karen_messages
-- rows (karen_check_rate_limit scopes to cims.current_user_id()), so they
-- must run as the same principal who sent them, not as the admin above.
select tests.simulate_user('10000000-0000-0000-0000-000000000006');

-- =============================================================================
-- 6. karen_check_rate_limit: true while under the limit, false once at/over it.
-- =============================================================================
select ok(
  (select public.karen_check_rate_limit(3)),
  'rate limit allows the first user turn (1 sent so far this minute)'
);

do $$
declare
  v_convo uuid := current_setting('tests.rahul_convo')::uuid;
begin
  insert into public.karen_messages (conversation_id, role, content) values (v_convo, 'user', 'two');
  insert into public.karen_messages (conversation_id, role, content) values (v_convo, 'user', 'three');
end;
$$;

select is(
  (select public.karen_check_rate_limit(3)),
  false,
  'rate limit rejects once 3 user turns have already been sent this minute'
);

select ok(
  (select public.karen_check_rate_limit(10)),
  'a higher configured limit still allows the same caller through'
);

-- =============================================================================
-- 7. Deleting the conversation cascades its messages (no orphan rows).
-- =============================================================================
select tests.simulate_user('10000000-0000-0000-0000-000000000006');

do $$
begin
  delete from public.karen_conversations where id = current_setting('tests.rahul_convo')::uuid;
end;
$$;

select is(
  (select count(*)::int from public.karen_messages where conversation_id = current_setting('tests.rahul_convo')::uuid),
  0,
  'deleting a conversation cascades its messages'
);

select * from finish();
rollback;
