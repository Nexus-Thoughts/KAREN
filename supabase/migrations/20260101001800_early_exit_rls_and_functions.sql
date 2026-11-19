-- =============================================================================
-- 20260101001800_early_exit_rls_and_functions
-- Phase 10 — RLS for presence_config/student_presence_state/authorized_exits/
-- early_exit_events/notifications, and the presence engine:
-- cims.evaluate_student_presence, cims.confirm_early_exit,
-- cims.notify_early_exit, public.evaluate_student_presence,
-- public.record_authorized_exit, public.decide_authorized_exit.
--
-- Also re-defines public.submit_location (Phase 9) to trigger presence
-- evaluation after every sample — unlike attendance evaluation (which needs
-- a scheduler even without new samples, to close a window once time simply
-- passes — docs/22 ADR-014), presence evaluation is naturally triggered by
-- "a new sample arrived" and needs nothing else to be live.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- presence_config — read all, write admin only (mirrors attendance_config).
-- -----------------------------------------------------------------------------
create policy presence_config_select on public.presence_config
  for select to authenticated using (cims.is_active_user());

create policy presence_config_write on public.presence_config
  for update to authenticated
  using (cims.is_active_user() and cims.has_permission('config.write'))
  with check (cims.is_active_user() and cims.has_permission('config.write'));

-- -----------------------------------------------------------------------------
-- student_presence_state / early_exit_events / authorized_exits.
--
-- cims.my_student_ids() is safe to reuse directly here (unlike
-- attendance_records — see docs/22 ADR-015): for a bare STUDENT it resolves
-- to ONLY their own id (the "own record" union branch), with no
-- section-wide inclusion the way cims.my_section_ids() has for timetable
-- visibility. There is no equivalent leak to guard against.
-- -----------------------------------------------------------------------------
create policy student_presence_state_select on public.student_presence_state
  for select to authenticated
  using (
    cims.is_active_user()
    and (
      student_id = cims.my_student_id()
      or (cims.has_permission('location.read') and student_id in (select cims.my_student_ids()))
    )
  );

create policy early_exit_events_select on public.early_exit_events
  for select to authenticated
  using (
    cims.is_active_user()
    and (
      student_id = cims.my_student_id()
      or (cims.has_permission('exit_events.read') and student_id in (select cims.my_student_ids()))
    )
  );

create policy authorized_exits_select on public.authorized_exits
  for select to authenticated
  using (
    cims.is_active_user()
    and (
      student_id = cims.my_student_id()
      or (cims.has_permission('exit_events.read') and student_id in (select cims.my_student_ids()))
    )
  );

create policy authorized_exits_write on public.authorized_exits
  for all to authenticated
  using (cims.is_active_user() and cims.has_permission('exit_events.authorize') and student_id in (select cims.my_student_ids()))
  with check (cims.is_active_user() and cims.has_permission('exit_events.authorize') and student_id in (select cims.my_student_ids()));

-- No direct-write policy on student_presence_state/early_exit_events: both
-- are written only by the SECURITY DEFINER engine functions below.

-- -----------------------------------------------------------------------------
-- notifications — a user reads only their own; marking read is a narrow
-- self-update. No direct INSERT policy: notifications are created only by
-- SECURITY DEFINER functions (cims.notify_early_exit here; Phase 11 adds
-- more categories through the same pattern).
-- -----------------------------------------------------------------------------
create policy notifications_select_self on public.notifications
  for select to authenticated
  using (cims.is_active_user() and recipient_id = auth.uid());

create policy notifications_mark_read_self on public.notifications
  for update to authenticated
  using (cims.is_active_user() and recipient_id = auth.uid())
  with check (recipient_id = auth.uid());

-- =============================================================================
-- Functions.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- cims.notify_early_exit — fans out to Mentor, Class In-charge and HOD.
-- SECURITY DEFINER: needs to read users/faculty/department_hods beyond what
-- the (irrelevant here — this always runs as a trusted internal caller)
-- invoking session might itself be scoped to, and to insert into
-- notifications, which has no direct-write policy.
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
begin
  select * into v_student from public.students where id = (select student_id from public.early_exit_events where id = p_event_id);
  select full_name into v_name from public.users where id = v_student.user_id;
  v_name := coalesce(v_name, v_student.register_number);

  -- Mentor
  if v_student.mentor_id is not null then
    select user_id into v_recipient from public.faculty where id = v_student.mentor_id;
    if v_recipient is not null then
      insert into public.notifications (recipient_id, type, title, message, related_entity_type, related_entity_id)
      values (v_recipient, 'EARLY_EXIT', 'Student exited campus early',
              v_name || ' (' || v_student.register_number || ') left campus before college closing time.',
              'early_exit_events', p_event_id::text);
    end if;
  end if;

  -- Class In-charge
  if v_student.class_incharge_id is not null then
    select user_id into v_recipient from public.faculty where id = v_student.class_incharge_id;
    if v_recipient is not null then
      insert into public.notifications (recipient_id, type, title, message, related_entity_type, related_entity_id)
      values (v_recipient, 'EARLY_EXIT', 'Student exited campus early',
              v_name || ' (' || v_student.register_number || ') left campus before college closing time.',
              'early_exit_events', p_event_id::text);
    end if;
  end if;

  -- HOD(s) of the student's department, via the same view DepartmentsPage uses.
  for v_recipient in
    select dh.user_id from public.department_hods dh where dh.department_id = v_student.department_id
  loop
    insert into public.notifications (recipient_id, type, title, message, related_entity_type, related_entity_id)
    values (v_recipient, 'EARLY_EXIT', 'Student exited campus early',
            v_name || ' (' || v_student.register_number || ') left campus before college closing time.',
            'early_exit_events', p_event_id::text);
  end loop;
end;
$$;

-- -----------------------------------------------------------------------------
-- cims.confirm_early_exit — called once, exactly at the EXIT_CANDIDATE ->
-- confirmed transition. Checks college hours and same-day authorized exits
-- before deciding whether this is an alert-worthy event at all.
-- -----------------------------------------------------------------------------
create or replace function cims.confirm_early_exit(p_student_id uuid, p_location extensions.geography, p_confirmed_at timestamptz)
returns void
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_cfg      public.presence_config;
  v_time     time;
  v_auth     public.authorized_exits;
  v_event_id uuid;
begin
  select * into v_cfg from public.presence_config limit 1;
  v_time := p_confirmed_at::time;

  -- Outside configured college hours: not an early exit at all (docs: "During
  -- configured college hours"). No event, no alert.
  if v_time < v_cfg.college_start_time or v_time > v_cfg.college_end_time then
    return;
  end if;

  -- Already has an open (no re-entry) event: never duplicate.
  if exists (select 1 from public.early_exit_events where student_id = p_student_id and re_entered_at is null) then
    return;
  end if;

  select * into v_auth from public.authorized_exits
  where student_id = p_student_id
    and exit_date = p_confirmed_at::date
    and status = 'APPROVED'
    and permitted_exit_time <= v_time
  limit 1;

  if v_auth.id is not null then
    insert into public.early_exit_events (student_id, exit_confirmed_at, last_known_location, verification_state, authorized_exit_id)
    values (p_student_id, p_confirmed_at, p_location, 'AUTHORIZED_EARLY_EXIT', v_auth.id);
    -- Authorized: retained for audit/history, but no alert notification —
    -- "do not send unauthorized-exit alert" for an approved departure.
    return;
  end if;

  insert into public.early_exit_events (student_id, exit_confirmed_at, last_known_location, verification_state)
  values (p_student_id, p_confirmed_at, p_location, 'EXIT_CONFIRMED')
  returning id into v_event_id;

  perform cims.notify_early_exit(v_event_id);
end;
$$;

-- -----------------------------------------------------------------------------
-- cims.evaluate_student_presence — the state machine. SECURITY DEFINER,
-- trusted callers only (submit_location and the public wrapper below).
-- -----------------------------------------------------------------------------
create or replace function cims.evaluate_student_presence(p_student_id uuid)
returns void
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_cfg     public.presence_config;
  v_state   public.student_presence_state;
  v_sample  public.location_samples;
  v_inside  boolean;
begin
  select * into v_cfg from public.presence_config limit 1;

  select * into v_sample from public.location_samples
  where student_id = p_student_id
  order by recorded_at desc
  limit 1;

  if v_sample.id is null then
    return; -- nothing to evaluate yet
  end if;

  insert into public.student_presence_state (student_id)
  values (p_student_id)
  on conflict (student_id) do nothing;

  select * into v_state from public.student_presence_state where student_id = p_student_id;

  -- Already processed this exact sample (evaluate_student_presence can be
  -- called more than once against the same latest sample without harm, but
  -- should not double-count it toward the confirmation counter).
  if v_state.last_sample_id = v_sample.id then
    return;
  end if;

  v_inside := public.point_in_campus(
    extensions.ST_X(v_sample.location::extensions.geometry),
    extensions.ST_Y(v_sample.location::extensions.geometry)
  );

  if v_inside then
    if v_state.state in ('UNKNOWN', 'EXIT_CANDIDATE') then
      update public.student_presence_state
      set state = 'INSIDE', consecutive_count = 0, last_sample_id = v_sample.id, state_changed_at = now()
      where student_id = p_student_id;

    elsif v_state.state = 'OUTSIDE' or v_state.state = 'REENTRY_CANDIDATE' then
      if v_state.consecutive_count + 1 >= v_cfg.reentry_confirmation_samples then
        update public.student_presence_state
        set state = 'INSIDE', consecutive_count = 0, last_sample_id = v_sample.id, state_changed_at = now()
        where student_id = p_student_id;

        update public.early_exit_events
        set re_entered_at = v_sample.recorded_at, verification_state = 'RE_ENTERED'
        where student_id = p_student_id and re_entered_at is null;
      else
        update public.student_presence_state
        set state = 'REENTRY_CANDIDATE', consecutive_count = v_state.consecutive_count + 1, last_sample_id = v_sample.id
        where student_id = p_student_id;
      end if;

    else -- already INSIDE
      update public.student_presence_state set last_sample_id = v_sample.id where student_id = p_student_id;
    end if;

  else -- outside campus
    if v_state.state in ('UNKNOWN', 'INSIDE') then
      update public.student_presence_state
      set state = 'EXIT_CANDIDATE', consecutive_count = 1, last_sample_id = v_sample.id
      where student_id = p_student_id;

    elsif v_state.state = 'EXIT_CANDIDATE' then
      if v_state.consecutive_count + 1 >= v_cfg.exit_confirmation_samples then
        update public.student_presence_state
        set state = 'OUTSIDE', consecutive_count = 0, last_sample_id = v_sample.id, state_changed_at = now()
        where student_id = p_student_id;

        perform cims.confirm_early_exit(p_student_id, v_sample.location, v_sample.recorded_at);
      else
        update public.student_presence_state
        set consecutive_count = v_state.consecutive_count + 1, last_sample_id = v_sample.id
        where student_id = p_student_id;
      end if;

    elsif v_state.state = 'REENTRY_CANDIDATE' then
      -- The re-entry attempt failed corroboration; still outside.
      update public.student_presence_state
      set state = 'OUTSIDE', consecutive_count = 0, last_sample_id = v_sample.id
      where student_id = p_student_id;

    else -- already OUTSIDE
      update public.student_presence_state set last_sample_id = v_sample.id where student_id = p_student_id;
    end if;
  end if;
end;
$$;

comment on function cims.evaluate_student_presence is
  'The presence state machine. A single outside (or inside) sample never confirms a transition — exit_confirmation_samples/reentry_confirmation_samples consecutive corroborating samples are required, per docs/05 false-positive protection.';

-- -----------------------------------------------------------------------------
-- public.submit_location — re-defined from Phase 9 to also drive presence
-- evaluation after every sample. Signature and grants unchanged.
-- -----------------------------------------------------------------------------
create or replace function public.submit_location(
  p_lat double precision,
  p_lng double precision,
  p_accuracy_m double precision default null
)
returns uuid
language plpgsql
security invoker
set search_path = public, extensions, pg_temp
as $$
declare
  v_student_id uuid;
  v_id uuid;
begin
  v_student_id := cims.my_student_id();
  if v_student_id is null then
    raise exception 'Only a student principal may submit their own location' using errcode = '42501';
  end if;
  if p_lat < -90 or p_lat > 90 or p_lng < -180 or p_lng > 180 then
    raise exception 'Invalid coordinates' using errcode = '22023';
  end if;

  insert into public.location_samples (student_id, location, accuracy_m)
  values (v_student_id, extensions.ST_SetSRID(extensions.ST_MakePoint(p_lng, p_lat), 4326)::extensions.geography, p_accuracy_m)
  returning id into v_id;

  perform cims.evaluate_student_presence(v_student_id);

  return v_id;
end;
$$;

-- -----------------------------------------------------------------------------
-- public.evaluate_student_presence — manual re-check entry point for staff
-- (e.g. a support/investigation action), scope-checked like every other
-- public wrapper over a definer engine function.
-- -----------------------------------------------------------------------------
create or replace function public.evaluate_student_presence(p_student_id uuid)
returns void
language plpgsql
security invoker
set search_path = public, extensions, pg_temp
as $$
begin
  if not (cims.has_permission('location.read') and p_student_id in (select cims.my_student_ids())) then
    raise exception 'Not authorised to evaluate this student''s presence' using errcode = '42501';
  end if;
  perform cims.evaluate_student_presence(p_student_id);
end;
$$;

-- -----------------------------------------------------------------------------
-- public.decide_authorized_exit — approve/reject a pending authorized-exit
-- request. Separate from a plain UPDATE so the decision is explicit and
-- always sets approved_by/status together (a bare RLS UPDATE policy would
-- let a caller set status without approved_by, or vice versa).
-- -----------------------------------------------------------------------------
create or replace function public.decide_authorized_exit(p_id uuid, p_approve boolean)
returns void
language plpgsql
security invoker
set search_path = public, extensions, pg_temp
as $$
begin
  update public.authorized_exits
  set status = case when p_approve then 'APPROVED'::public.authorized_exit_status else 'REJECTED'::public.authorized_exit_status end,
      approved_by = auth.uid()
  where id = p_id;

  if not found then
    raise exception 'Authorized exit request not found or not authorised' using errcode = '02000';
  end if;
end;
$$;

comment on function public.decide_authorized_exit is
  'SECURITY INVOKER — the UPDATE is subject to authorized_exits_write RLS (exit_events.authorize + scope) as the calling user, so this only bundles status+approved_by together atomically rather than re-deriving authorization.';

grant execute on function
  public.evaluate_student_presence(uuid),
  public.decide_authorized_exit(uuid, boolean)
to authenticated;
