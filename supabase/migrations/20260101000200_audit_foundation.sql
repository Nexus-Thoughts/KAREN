-- =============================================================================
-- 20260101000200_audit_foundation
-- Phase 3 — the audit substrate every later phase writes into.
--
-- docs/13_SECURITY_AND_PRIVACY.md, docs/19_DEFINITION_OF_DONE.md
-- Master prompt §49: attendance changes, marks changes, report/document
-- generation, KAREN write actions, role changes, permission changes, geofence
-- changes, classroom coordinate changes, timetable changes and notification
-- actions must all be auditable.
-- =============================================================================

create type public.audit_action as enum (
  'INSERT',
  'UPDATE',
  'DELETE',
  'LOGIN',
  'LOGOUT',
  'PERMISSION_DENIED',
  'EXPORT',
  'GENERATE',
  'AI_TOOL_CALL',
  'AI_WRITE_ACTION',
  'PRIVILEGED_READ'
);

comment on type public.audit_action is
  'PRIVILEGED_READ records a scoped read of sensitive data (student location) — docs/05 requires privileged location access to be audited, not just writes.';

-- -----------------------------------------------------------------------------
-- audit_logs
--
-- Append-only. Rows are hash-chained: each row commits to the previous row''s
-- hash, so a silent edit or deletion inside the table is detectable even by
-- someone holding the service-role key.
-- -----------------------------------------------------------------------------
create table public.audit_logs (
  id                bigint generated always as identity primary key,
  occurred_at       timestamptz     not null default now(),

  -- Actor. Nullable because system/scheduled processes act without a user.
  actor_id          uuid            references auth.users (id) on delete set null,
  actor_role        text,
  actor_ip          inet,
  -- Correlates every row emitted by one API call or one KAREN turn.
  request_id        uuid,

  action            public.audit_action not null,
  entity_type       text            not null,
  entity_id         text,

  -- Old/new images. Only the changed keys are stored, not whole rows, to keep
  -- sensitive values out of the log where they are not needed (docs/46).
  old_values        jsonb,
  new_values        jsonb,

  -- Free-form justification, e.g. the reason on a manual attendance override.
  reason            text,
  metadata          jsonb           not null default '{}'::jsonb,

  -- Hash chain.
  previous_hash     text,
  row_hash          text            not null
);

comment on table public.audit_logs is
  'Immutable, hash-chained audit trail. Append-only via cims.reject_mutation. No RLS write path exists; rows are written only by SECURITY DEFINER functions.';
comment on column public.audit_logs.row_hash is
  'sha256 over (previous_hash, occurred_at, actor_id, action, entity_type, entity_id, old_values, new_values). Chain break implies tampering.';

create index audit_logs_occurred_at_idx  on public.audit_logs (occurred_at desc);
create index audit_logs_actor_idx        on public.audit_logs (actor_id, occurred_at desc);
create index audit_logs_entity_idx       on public.audit_logs (entity_type, entity_id, occurred_at desc);
create index audit_logs_action_idx       on public.audit_logs (action, occurred_at desc);
create index audit_logs_request_idx      on public.audit_logs (request_id) where request_id is not null;

-- -----------------------------------------------------------------------------
-- Hash chain maintenance.
-- -----------------------------------------------------------------------------
create or replace function cims.audit_hash_chain()
returns trigger
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  prev text;
begin
  select row_hash into prev
  from public.audit_logs
  order by id desc
  limit 1;

  new.previous_hash := prev;
  new.row_hash := encode(
    extensions.digest(
      coalesce(prev, '')
        || coalesce(new.occurred_at::text, '')
        || coalesce(new.actor_id::text, '')
        || coalesce(new.action::text, '')
        || coalesce(new.entity_type, '')
        || coalesce(new.entity_id, '')
        || coalesce(new.old_values::text, '')
        || coalesce(new.new_values::text, ''),
      'sha256'
    ),
    'hex'
  );
  return new;
end;
$$;

create trigger audit_logs_hash_chain
  before insert on public.audit_logs
  for each row execute function cims.audit_hash_chain();

-- Append-only enforcement.
create trigger audit_logs_no_update
  before update on public.audit_logs
  for each row execute function cims.reject_mutation();

create trigger audit_logs_no_delete
  before delete on public.audit_logs
  for each row execute function cims.reject_mutation();

-- -----------------------------------------------------------------------------
-- cims.write_audit — the single supported way to append an audit row.
--
-- SECURITY DEFINER so callers never need INSERT privilege on audit_logs
-- directly; that keeps the table unwritable from PostgREST.
-- -----------------------------------------------------------------------------
create or replace function cims.write_audit(
  p_action       public.audit_action,
  p_entity_type  text,
  p_entity_id    text        default null,
  p_old_values   jsonb       default null,
  p_new_values   jsonb       default null,
  p_reason       text        default null,
  p_metadata     jsonb       default '{}'::jsonb,
  p_request_id   uuid        default null
)
returns bigint
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_id bigint;
begin
  insert into public.audit_logs (
    actor_id, actor_role, action, entity_type, entity_id,
    old_values, new_values, reason, metadata, request_id
  )
  values (
    auth.uid(),
    -- nullif() must run BEFORE the ::jsonb cast: request.jwt.claims is unset
    -- (empty string, not NULL) whenever this fires outside a PostgREST
    -- request — migrations, seed scripts, a service-role call, or a test
    -- harness resetting role — and ''::jsonb raises "invalid input syntax
    -- for type json", aborting the very statement the trigger was attached
    -- to audit. Casting nullif(..., '') first makes an absent claim a clean
    -- SQL NULL instead.
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    p_action, p_entity_type, p_entity_id,
    p_old_values, p_new_values, p_reason, coalesce(p_metadata, '{}'::jsonb), p_request_id
  )
  returning id into v_id;

  return v_id;
end;
$$;

comment on function cims.write_audit is
  'Appends one audit row. The only supported write path into public.audit_logs.';

-- -----------------------------------------------------------------------------
-- Generic row-level audit trigger.
--
-- Attach to any regulated table. Records only the keys that actually changed,
-- so the log does not accumulate unchanged sensitive columns.
-- -----------------------------------------------------------------------------
create or replace function cims.audit_row_change()
returns trigger
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_old      jsonb;
  v_new      jsonb;
  v_changed  jsonb := '{}'::jsonb;
  v_key      text;
  v_entity   text := tg_table_name;
  v_id       text;
begin
  if tg_op = 'DELETE' then
    v_old := to_jsonb(old);
    v_id  := v_old ->> 'id';
    perform cims.write_audit('DELETE', v_entity, v_id, v_old, null);
    return old;
  end if;

  v_new := to_jsonb(new);
  v_id  := v_new ->> 'id';

  if tg_op = 'INSERT' then
    perform cims.write_audit('INSERT', v_entity, v_id, null, v_new);
    return new;
  end if;

  -- UPDATE: diff the images so the log stays minimal.
  v_old := to_jsonb(old);
  for v_key in select jsonb_object_keys(v_new) loop
    if v_new -> v_key is distinct from v_old -> v_key
       and v_key not in ('updated_at') then
      v_changed := v_changed || jsonb_build_object(
        v_key,
        jsonb_build_object('from', v_old -> v_key, 'to', v_new -> v_key)
      );
    end if;
  end loop;

  if v_changed = '{}'::jsonb then
    return new; -- nothing material changed; do not create noise
  end if;

  perform cims.write_audit('UPDATE', v_entity, v_id, v_old - 'updated_at', v_changed);
  return new;
end;
$$;

comment on function cims.audit_row_change is
  'AFTER INSERT/UPDATE/DELETE trigger for regulated tables. UPDATE rows store a per-key {from,to} diff.';

-- -----------------------------------------------------------------------------
-- Chain verification, for the Audit Reports module and for tests.
-- -----------------------------------------------------------------------------
create or replace function cims.verify_audit_chain(p_from bigint default 1)
returns table (broken_at bigint, expected text, found text)
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  r          record;
  v_prev     text := null;
  v_expected text;
  v_first    boolean := true;
begin
  for r in
    select * from public.audit_logs where id >= p_from order by id asc
  loop
    if v_first then
      v_prev  := r.previous_hash;
      v_first := false;
    end if;

    v_expected := encode(
      extensions.digest(
        coalesce(v_prev, '')
          || coalesce(r.occurred_at::text, '')
          || coalesce(r.actor_id::text, '')
          || coalesce(r.action::text, '')
          || coalesce(r.entity_type, '')
          || coalesce(r.entity_id, '')
          || coalesce(r.old_values::text, '')
          || coalesce(r.new_values::text, ''),
        'sha256'
      ),
      'hex'
    );

    if v_expected is distinct from r.row_hash then
      broken_at := r.id;
      expected  := v_expected;
      found     := r.row_hash;
      return next;
    end if;

    v_prev := r.row_hash;
  end loop;
end;
$$;

comment on function cims.verify_audit_chain is
  'Recomputes the audit hash chain. Returns one row per tampered entry; empty result means the chain is intact.';

-- RLS: audit_logs is readable only through policies added with the RBAC
-- migration. Enabled here so the table is never briefly open.
alter table public.audit_logs enable row level security;
