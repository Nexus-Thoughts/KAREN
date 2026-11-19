-- =============================================================================
-- 002_auth_hardening.test.sql
--
-- Covers supabase/migrations/20260101000800_auth_hardening.sql: the
-- self-update column restriction on public.users, and complete_password_change().
-- See docs/22_ARCHITECTURE_DECISIONS.md for why this migration exists — a
-- signed-in user could otherwise write ANY column on their own users row,
-- including reactivating a SUSPENDED status.
-- =============================================================================

begin;

do $$
begin
  create extension if not exists pgtap with schema extensions;
exception when duplicate_object then
  null;
end;
$$;

select plan(8);

-- -----------------------------------------------------------------------------
-- Helper: switch the transaction's simulated principal. Each *.test.sql file
-- runs in its own begin/rollback transaction under `supabase test db`, so
-- these are NOT shared from 001_rbac_scope.test.sql — DDL rolls back with
-- everything else. Kept byte-for-byte identical to that file's copy rather
-- than factored out, since there is no fixture-loading step this project's
-- pgTAP runner executes before each file (confirmed: the first run of this
-- file failed with "schema tests does not exist" before this block was added).
-- -----------------------------------------------------------------------------
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

-- Rahul: student.rahul@cims.test, id 10000000-0000-0000-0000-000000000006

-- -----------------------------------------------------------------------------
-- 1. A non-privileged self-edit of full_name succeeds.
-- -----------------------------------------------------------------------------
select tests.simulate_user('10000000-0000-0000-0000-000000000006');

update public.users set full_name = 'Rahul K. Nair' where id = '10000000-0000-0000-0000-000000000006';

select is(
  (select full_name from public.users where id = '10000000-0000-0000-0000-000000000006'),
  'Rahul K. Nair',
  'a user may self-edit their own full_name'
);

-- -----------------------------------------------------------------------------
-- 2. The same UPDATE cannot smuggle a status change through alongside it.
-- -----------------------------------------------------------------------------
update public.users set full_name = 'Rahul Nair', status = 'SUSPENDED'
where id = '10000000-0000-0000-0000-000000000006';

select is(
  (select status from public.users where id = '10000000-0000-0000-0000-000000000006')::text,
  'ACTIVE',
  'a self-edit cannot change status — the column reverts even when bundled with an allowed change'
);

select is(
  (select full_name from public.users where id = '10000000-0000-0000-0000-000000000006'),
  'Rahul Nair',
  'the allowed column in that same statement still applied'
);

-- -----------------------------------------------------------------------------
-- 3. must_change_password cannot be set to true by a plain self-update
--    (escalating yourself into — or more importantly, back out of — a forced
--    reset must not be a client-controllable UPDATE).
-- -----------------------------------------------------------------------------
update public.users set must_change_password = true where id = '10000000-0000-0000-0000-000000000006';

select is(
  (select must_change_password from public.users where id = '10000000-0000-0000-0000-000000000006'),
  false,
  'a plain self-UPDATE cannot set must_change_password'
);

-- -----------------------------------------------------------------------------
-- 4. An admin CAN change another user's status (users_write_admin + this
--    trigger's early-return for users.write holders).
-- -----------------------------------------------------------------------------
select tests.simulate_user('10000000-0000-0000-0000-000000000001'); -- admin

update public.users set status = 'SUSPENDED' where id = '10000000-0000-0000-0000-000000000007'; -- Priya

select is(
  (select status from public.users where id = '10000000-0000-0000-0000-000000000007')::text,
  'SUSPENDED',
  'an admin (holding users.write) can change another user''s status'
);

-- restore
update public.users set status = 'ACTIVE' where id = '10000000-0000-0000-0000-000000000007';

-- -----------------------------------------------------------------------------
-- 5. complete_password_change() clears the flag via its blessed path.
-- -----------------------------------------------------------------------------
update public.users set must_change_password = true where id = '10000000-0000-0000-0000-000000000006';

select tests.simulate_user('10000000-0000-0000-0000-000000000006');
select public.complete_password_change();

select is(
  (select must_change_password from public.users where id = '10000000-0000-0000-0000-000000000006'),
  false,
  'complete_password_change() clears must_change_password for the calling user'
);

-- -----------------------------------------------------------------------------
-- 6. complete_password_change() only ever affects the caller's own row.
--
-- Setting Priya's flag and later reading it back both need users.write /
-- users.read, which neither Rahul nor an anonymous session holds (STUDENT's
-- grant list has neither) — done as admin, with only the RPC call itself
-- made as Rahul, since that's the one step under test.
-- -----------------------------------------------------------------------------
select tests.simulate_user('10000000-0000-0000-0000-000000000001'); -- admin
update public.users set must_change_password = true where id = '10000000-0000-0000-0000-000000000007'; -- Priya

select tests.simulate_user('10000000-0000-0000-0000-000000000006'); -- Rahul calls it
select public.complete_password_change();

select tests.simulate_user('10000000-0000-0000-0000-000000000001'); -- admin, to read Priya's row
select is(
  (select must_change_password from public.users where id = '10000000-0000-0000-0000-000000000007'),
  true,
  'complete_password_change() does not clear another user''s flag'
);

-- -----------------------------------------------------------------------------
-- 7. The audit trail recorded the flag clearing (docs/49).
-- -----------------------------------------------------------------------------
select tests.simulate_user('10000000-0000-0000-0000-000000000001'); -- admin, to read audit_logs

select ok(
  exists (
    select 1 from public.audit_logs
    where entity_type = 'users'
      and entity_id = '10000000-0000-0000-0000-000000000006'
      and reason = 'first-login forced password change completed'
  ),
  'clearing must_change_password via the RPC is audited'
);

-- cleanup
update public.users set must_change_password = false where id = '10000000-0000-0000-0000-000000000007';

select * from finish();
rollback;
