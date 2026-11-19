-- =============================================================================
-- 20260101002000_notifications_engine_functions
-- Phase 11 — notifications lifecycle columns, dedup, retry, self-update
-- guard, and the enqueue/deliver/fail/retry/mark-read function surface.
--
-- Split from 20260101001900 because the new enum values it adds
-- (RETRYING/EXHAUSTED) cannot be referenced in the same transaction that
-- adds them (Postgres restriction on ALTER TYPE ... ADD VALUE).
-- =============================================================================

alter table public.notifications
  add column dedup_key             text,
  add column delivery_attempts     integer not null default 0,
  add column max_delivery_attempts integer not null default 3,
  add column last_attempt_at       timestamptz;

alter table public.notifications
  add constraint notifications_delivery_attempts_nonneg check (delivery_attempts >= 0),
  add constraint notifications_max_attempts_positive check (max_delivery_attempts >= 1);

-- Deduplication: the same (recipient, dedup_key) pair is never inserted
-- twice. A caller that wants dedup passes a stable key (e.g.
-- 'early_exit:<event_id>'); a caller that doesn't care passes NULL, which
-- the partial index ignores entirely.
create unique index notifications_dedup_idx on public.notifications (recipient_id, dedup_key) where dedup_key is not null;

comment on column public.notifications.dedup_key is
  'Stable per-(recipient,event) key. NULL means no dedup requested. Enforced by notifications_dedup_idx, not by application-level pre-checking (same race-safety reasoning as timetable_entries'' EXCLUDE constraints, ADR-011).';

-- -----------------------------------------------------------------------------
-- Self-update guard: notifications_mark_read_self (Phase 10) is row-scoped
-- only, the same gap ADR-009 found on public.users — nothing stops a
-- recipient rewriting their own notification's title/message/type via a
-- plain PostgREST UPDATE. A trigger is required because RLS is row-level,
-- not column-level (identical reasoning to cims.restrict_self_user_update).
-- -----------------------------------------------------------------------------
create or replace function cims.restrict_notification_self_update()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- The delivery-lifecycle engine functions (cims.deliver_notification,
  -- cims.record_delivery_failure) update status/delivery_attempts/
  -- last_attempt_at/failed_reason on every notification, not just rows the
  -- calling session owns as recipient — this trigger fires on their UPDATEs
  -- too (triggers are not bypassed by SECURITY DEFINER), so they set this
  -- transaction-local escape hatch immediately before their own UPDATE, the
  -- same pattern cims.allow_password_change_clear uses for public.users
  -- (docs/22 ADR-009).
  if current_setting('cims.allow_notification_lifecycle_update', true) = 'on' then
    return new;
  end if;

  -- A privileged caller (holds notifications.manage, reserved for
  -- ADMIN/system use) may edit freely; this guard only constrains the
  -- ordinary self-service "mark as read" path.
  if cims.has_permission('notifications.manage') then
    return new;
  end if;

  new.type                  := old.type;
  new.title                 := old.title;
  new.message                := old.message;
  new.related_entity_type   := old.related_entity_type;
  new.related_entity_id     := old.related_entity_id;
  new.recipient_id          := old.recipient_id;
  new.dedup_key             := old.dedup_key;
  new.delivery_attempts     := old.delivery_attempts;
  new.max_delivery_attempts := old.max_delivery_attempts;
  new.last_attempt_at       := old.last_attempt_at;
  new.failed_reason         := old.failed_reason;
  new.created_at            := old.created_at;

  -- The only columns a recipient may actually change: read_at, and status
  -- moving specifically to READ (never to any delivery-lifecycle value).
  if new.status is distinct from old.status and new.status is distinct from 'READ' then
    new.status := old.status;
  end if;

  return new;
end;
$$;

create trigger notifications_restrict_self_update before update on public.notifications
  for each row execute function cims.restrict_notification_self_update();

-- =============================================================================
-- Functions.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- cims.enqueue_notification — the sole insertion path. SECURITY DEFINER
-- (notifications has no direct-write policy — see Phase 10's RLS file).
-- Deduplicates via notifications_dedup_idx (ON CONFLICT DO NOTHING),
-- returning the existing row's id rather than erroring, so a caller never
-- needs to pre-check. Immediately attempts delivery, since the only
-- delivery channel that exists in this environment (durable row + Realtime
-- broadcast) succeeds synchronously with the insert — see this file's
-- header comment and docs/22 ADR-019.
-- -----------------------------------------------------------------------------
create or replace function cims.enqueue_notification(
  p_recipient_id uuid,
  p_type public.notification_type,
  p_title text,
  p_message text,
  p_related_entity_type text default null,
  p_related_entity_id text default null,
  p_dedup_key text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  insert into public.notifications (recipient_id, type, title, message, related_entity_type, related_entity_id, dedup_key, status)
  values (p_recipient_id, p_type, p_title, p_message, p_related_entity_type, p_related_entity_id, p_dedup_key, 'QUEUED')
  on conflict (recipient_id, dedup_key) where dedup_key is not null do nothing
  returning id into v_id;

  if v_id is null then
    -- Conflict: a notification with this dedup key already exists for this
    -- recipient. Return its id rather than raising — dedup is meant to be
    -- silently idempotent for the caller (e.g. cims.notify_early_exit re-run
    -- against the same event).
    select id into v_id from public.notifications
    where recipient_id = p_recipient_id and dedup_key = p_dedup_key;
    return v_id;
  end if;

  perform cims.deliver_notification(v_id);
  return v_id;
end;
$$;

-- -----------------------------------------------------------------------------
-- cims.deliver_notification — QUEUED/RETRYING -> SENT. The row already
-- persisting past its own INSERT/UPDATE commit IS the delivery in this
-- environment (Realtime's postgres_changes stream broadcasts it to the
-- recipient's own RLS-scoped subscription automatically; there is no
-- separate external call to fail). Idempotent: re-delivering an already-SENT
-- or already-READ row is a no-op.
-- -----------------------------------------------------------------------------
create or replace function cims.deliver_notification(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform set_config('cims.allow_notification_lifecycle_update', 'on', true);
  update public.notifications
  set status = 'SENT', delivery_attempts = delivery_attempts + 1, last_attempt_at = now()
  where id = p_id and status in ('QUEUED', 'RETRYING');
  perform set_config('cims.allow_notification_lifecycle_update', 'off', true);
end;
$$;

-- -----------------------------------------------------------------------------
-- cims.record_delivery_failure — the path a future external-channel Edge
-- Function calls on a real transport failure. Exhausts after
-- max_delivery_attempts, otherwise moves to RETRYING for a scheduler (the
-- same class of "manual trigger, real logic" limitation as ADR-014) to
-- retry via cims.deliver_notification later.
-- -----------------------------------------------------------------------------
create or replace function cims.record_delivery_failure(p_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.notifications;
begin
  select * into v_row from public.notifications where id = p_id;
  if v_row.id is null then
    raise exception 'Notification % not found' , p_id using errcode = '02000';
  end if;

  perform set_config('cims.allow_notification_lifecycle_update', 'on', true);
  update public.notifications
  set delivery_attempts = delivery_attempts + 1,
      last_attempt_at = now(),
      failed_reason = p_reason,
      status = case
        when delivery_attempts + 1 >= max_delivery_attempts then 'EXHAUSTED'::public.notification_status
        else 'RETRYING'::public.notification_status
      end
  where id = p_id;
  perform set_config('cims.allow_notification_lifecycle_update', 'off', true);
end;
$$;

-- -----------------------------------------------------------------------------
-- public.mark_notification_read / public.mark_all_notifications_read —
-- SECURITY INVOKER, subject to notifications_mark_read_self RLS +
-- cims.restrict_notification_self_update as the calling user. Bundled as
-- functions (rather than leaving the client to issue its own UPDATE) purely
-- so read_at and status move together atomically from a single call.
-- -----------------------------------------------------------------------------
create or replace function public.mark_notification_read(p_id uuid)
returns void
language sql
security invoker
set search_path = public, pg_temp
as $$
  update public.notifications
  set read_at = coalesce(read_at, now()), status = 'READ'
  where id = p_id and recipient_id = auth.uid();
$$;

create or replace function public.mark_all_notifications_read()
returns void
language sql
security invoker
set search_path = public, pg_temp
as $$
  update public.notifications
  set read_at = coalesce(read_at, now()), status = 'READ'
  where recipient_id = auth.uid() and read_at is null;
$$;

grant execute on function
  public.mark_notification_read(uuid),
  public.mark_all_notifications_read()
to authenticated;

-- -----------------------------------------------------------------------------
-- Re-point cims.notify_early_exit at the new enqueue function instead of a
-- bare INSERT, with a per-event dedup key so re-running it against the same
-- event (defensive — cims.confirm_early_exit already prevents this at the
-- event level) can never double-notify the same recipient.
-- -----------------------------------------------------------------------------
create or replace function cims.notify_early_exit(p_event_id uuid)
returns void
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_student   public.students;
  v_name      text;
  v_recipient uuid;
  v_message   text;
begin
  select * into v_student from public.students where id = (select student_id from public.early_exit_events where id = p_event_id);
  select full_name into v_name from public.users where id = v_student.user_id;
  v_name := coalesce(v_name, v_student.register_number);
  v_message := v_name || ' (' || v_student.register_number || ') left campus before college closing time.';

  -- Mentor
  if v_student.mentor_id is not null then
    select user_id into v_recipient from public.faculty where id = v_student.mentor_id;
    if v_recipient is not null then
      perform cims.enqueue_notification(v_recipient, 'EARLY_EXIT', 'Student exited campus early', v_message,
        'early_exit_events', p_event_id::text, 'early_exit:' || p_event_id::text || ':' || v_recipient::text);
    end if;
  end if;

  -- Class In-charge
  if v_student.class_incharge_id is not null then
    select user_id into v_recipient from public.faculty where id = v_student.class_incharge_id;
    if v_recipient is not null then
      perform cims.enqueue_notification(v_recipient, 'EARLY_EXIT', 'Student exited campus early', v_message,
        'early_exit_events', p_event_id::text, 'early_exit:' || p_event_id::text || ':' || v_recipient::text);
    end if;
  end if;

  -- HOD(s) of the student's department, via the same view DepartmentsPage uses.
  for v_recipient in
    select dh.user_id from public.department_hods dh where dh.department_id = v_student.department_id
  loop
    perform cims.enqueue_notification(v_recipient, 'EARLY_EXIT', 'Student exited campus early', v_message,
      'early_exit_events', p_event_id::text, 'early_exit:' || p_event_id::text || ':' || v_recipient::text);
  end loop;
end;
$$;
