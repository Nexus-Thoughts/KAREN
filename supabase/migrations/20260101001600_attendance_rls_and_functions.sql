-- =============================================================================
-- 20260101001600_attendance_rls_and_functions
-- Phase 9 — RLS for class_sessions/attendance_records/attendance_config, and
-- the attendance engine functions: get_or_create_class_session,
-- submit_location, evaluate_class_session, finalize_class_session,
-- override_attendance.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- attendance_config — readable by anyone (the thresholds themselves are not
-- sensitive), writable by admin only (config.write is ADMIN-only per the
-- Phase 4 grants — no HOD override of institution-wide timing rules).
-- -----------------------------------------------------------------------------
create policy attendance_config_select on public.attendance_config
  for select to authenticated using (cims.is_active_user());

create policy attendance_config_write on public.attendance_config
  for update to authenticated
  using (cims.is_active_user() and cims.has_permission('config.write'))
  with check (cims.is_active_user() and cims.has_permission('config.write'));

-- -----------------------------------------------------------------------------
-- class_sessions — read reach mirrors timetable_entries (reuses
-- cims.my_section_ids(), same rationale as 20260101001100). Write
-- (open/close/finalize) requires class_sessions.write, scoped to the
-- session's own section/department.
-- -----------------------------------------------------------------------------
create policy class_sessions_select on public.class_sessions
  for select to authenticated
  using (
    cims.is_active_user()
    and (section_id in (select cims.my_section_ids()) or faculty_id = cims.my_faculty_id())
  );

create policy class_sessions_write on public.class_sessions
  for all to authenticated
  using (
    cims.is_active_user() and cims.has_permission('class_sessions.write')
    and (
      cims.is_admin()
      or faculty_id = cims.my_faculty_id()
      or exists (select 1 from public.sections s where s.id = class_sessions.section_id and s.department_id in (select cims.my_department_ids()))
    )
  )
  with check (
    cims.is_active_user() and cims.has_permission('class_sessions.write')
    and (
      cims.is_admin()
      or faculty_id = cims.my_faculty_id()
      or exists (select 1 from public.sections s where s.id = class_sessions.section_id and s.department_id in (select cims.my_department_ids()))
    )
  );

-- -----------------------------------------------------------------------------
-- attendance_records — deliberately NOT reusing cims.my_section_ids()
-- directly: that set includes a STUDENT's own section (correct for
-- timetable visibility), and combined with attendance.read (which STUDENT
-- also holds, for their own record) that would let a student read every
-- classmate's individual attendance row. Staff reach is enumerated
-- explicitly instead — see docs/22 ADR-015.
-- -----------------------------------------------------------------------------
create policy attendance_records_select on public.attendance_records
  for select to authenticated
  using (
    cims.is_active_user()
    and (
      student_id = cims.my_student_id()
      or (
        cims.has_permission('attendance.read')
        and exists (
          select 1 from public.class_sessions cs
          where cs.id = attendance_records.class_session_id
            and (
              cims.is_admin()
              or cs.faculty_id = cims.my_faculty_id()
              or exists (
                select 1 from cims.my_role_assignments() ra
                where ra.scope_kind = 'SECTION' and ra.section_id = cs.section_id
              )
              or exists (
                select 1 from public.sections s
                where s.id = cs.section_id and s.department_id in (select cims.my_department_ids())
              )
              or exists (
                select 1 from public.students st
                where st.id = attendance_records.student_id and st.mentor_id = cims.my_faculty_id()
              )
            )
        )
      )
    )
  );

-- Only the engine functions and override_attendance() write this table —
-- both are SECURITY DEFINER, so no direct-write RLS policy exists at all.
-- A missing INSERT/UPDATE/DELETE policy means "denied", which is exactly
-- right: no API caller should be able to set their own attendance status by
-- calling PostgREST directly, only through the audited, validated functions.

-- =============================================================================
-- Functions.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- get_or_create_class_session — idempotent activation of a timetable_entry
-- on a given date. SECURITY INVOKER: the actual INSERT is subject to
-- class_sessions_write RLS as the calling user, so authorization lives in
-- one place (the policy) rather than being re-derived here.
-- -----------------------------------------------------------------------------
create or replace function public.get_or_create_class_session(
  p_timetable_entry_id uuid,
  p_session_date date
)
returns uuid
language plpgsql
security invoker
set search_path = public, extensions, pg_temp
as $$
declare
  v_te      public.timetable_entries;
  v_cfg     public.attendance_config;
  v_id      uuid;
  v_sched_start timestamptz;
  v_sched_end   timestamptz;
  v_win_start   timestamptz;
  v_win_end     timestamptz;
  v_status  public.class_session_status;
begin
  select * into v_te from public.timetable_entries where id = p_timetable_entry_id;
  if v_te.id is null then
    raise exception 'Timetable entry % not found or not visible', p_timetable_entry_id using errcode = '02000';
  end if;

  select * into v_cfg from public.attendance_config limit 1;

  -- Interpreted as UTC explicitly so this is deterministic under test,
  -- independent of the connecting session's timezone setting.
  v_sched_start := (p_session_date + v_te.start_time) at time zone 'UTC';
  v_sched_end   := (p_session_date + v_te.end_time) at time zone 'UTC';
  v_win_start   := v_sched_start;
  v_win_end     := v_sched_end + make_interval(mins => v_cfg.attendance_window_after_minutes);

  v_status := case
    when now() < v_win_start then 'SCHEDULED'
    when now() <= v_sched_end then 'OPEN'
    else 'ATTENDANCE_OPEN'
  end;

  insert into public.class_sessions (
    timetable_entry_id, section_id, subject_id, faculty_id, classroom_id, semester_id,
    session_date, scheduled_start, scheduled_end, attendance_window_start, attendance_window_end, status
  ) values (
    p_timetable_entry_id, v_te.section_id, v_te.subject_id, v_te.faculty_id, v_te.classroom_id, v_te.semester_id,
    p_session_date, v_sched_start, v_sched_end, v_win_start, v_win_end, v_status
  )
  on conflict (timetable_entry_id, session_date) do update
    set status = excluded.status
    where public.class_sessions.status <> 'CLOSED'
  returning id into v_id;

  if v_id is null then
    select id into v_id from public.class_sessions
    where timetable_entry_id = p_timetable_entry_id and session_date = p_session_date;
  end if;

  return v_id;
end;
$$;

comment on function public.get_or_create_class_session is
  'Idempotent: calling it twice for the same (timetable_entry, date) returns the same session id. A real deployment calls this from a scheduler at/near each timetable slot; the live attendance UI also calls it on demand ("open today''s session").';

-- -----------------------------------------------------------------------------
-- submit_location — the one write path into location_samples. Resolves the
-- caller's own student_id server-side so the client never needs to know it.
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

  return v_id;
end;
$$;

-- -----------------------------------------------------------------------------
-- cims.evaluate_class_session — the automatic engine. SECURITY DEFINER:
-- trusted callers only (the two wrappers below, each of which performs its
-- own permission/scope check before calling this).
--
-- Structural guarantee this function upholds: PRESENT/LATE requires (a) an
-- OPEN class_session, (b) a location sample within the classroom's radius_m
-- via ST_DWithin, AND (c) at least attendance_config.min_confirmations_required
-- such samples — never fewer. A student merely being on campus, or a single
-- in-range sample, is structurally incapable of producing PRESENT here.
-- -----------------------------------------------------------------------------
create or replace function cims.evaluate_class_session(p_class_session_id uuid)
returns void
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_session   public.class_sessions;
  v_cfg       public.attendance_config;
  v_classroom public.classrooms;
  v_student   record;
  v_sample    public.location_samples;
  v_distance  double precision;
begin
  select * into v_session from public.class_sessions where id = p_class_session_id;
  if v_session.id is null then
    raise exception 'Class session % not found', p_class_session_id using errcode = '02000';
  end if;
  if v_session.status = 'CLOSED' then
    return; -- finalized sessions are immutable
  end if;

  select * into v_cfg from public.attendance_config limit 1;
  select * into v_classroom from public.classrooms where id = v_session.classroom_id;

  for v_student in
    select st.id as student_id
    from public.student_subject_enrolments sse
    join public.students st on st.id = sse.student_id
    where sse.subject_id = v_session.subject_id
      and sse.semester_id = v_session.semester_id
      and sse.status = 'ACTIVE'
      and st.section_id = v_session.section_id
      and st.status = 'ACTIVE'
  loop
    insert into public.attendance_records (class_session_id, student_id)
    values (p_class_session_id, v_student.student_id)
    on conflict (class_session_id, student_id) do nothing;

    -- Manual overrides and already-terminal automatic statuses are never
    -- revisited by this pass.
    if exists (
      select 1 from public.attendance_records ar
      where ar.class_session_id = p_class_session_id and ar.student_id = v_student.student_id
        and (ar.is_manual or ar.status in ('PRESENT', 'LATE', 'ABSENT', 'OUTSIDE_CLASSROOM', 'OUTSIDE_CAMPUS'))
    ) then
      continue;
    end if;

    select * into v_sample
    from public.location_samples ls
    where ls.student_id = v_student.student_id
      and ls.recorded_at between v_session.attendance_window_start and least(clock_timestamp(), v_session.attendance_window_end)
    order by ls.recorded_at desc
    limit 1;

    if v_sample.id is null then
      continue; -- no sample yet; stays PENDING, never jumps straight to ABSENT
    end if;

    if v_sample.accuracy_m is not null and v_sample.accuracy_m > v_cfg.location_accuracy_threshold_m then
      update public.attendance_records
      set status = 'LOW_GPS_ACCURACY', accuracy_m = v_sample.accuracy_m
      where class_session_id = p_class_session_id and student_id = v_student.student_id
        and status not in ('PRESENT', 'LATE');
      continue;
    end if;

    v_distance := extensions.ST_Distance(v_classroom.location, v_sample.location);

    if v_distance > v_classroom.radius_m then
      -- Detected, but not in the room yet. Held at DETECTED, not failed —
      -- a later in-range sample within the window can still recover this
      -- (GPS drift/temporary loss). Only finalize_class_session commits a
      -- lingering DETECTED to OUTSIDE_CLASSROOM.
      update public.attendance_records
      set status = 'DETECTED', distance_m = v_distance, accuracy_m = v_sample.accuracy_m
      where class_session_id = p_class_session_id and student_id = v_student.student_id
        and status = 'PENDING';
      continue;
    end if;

    -- In range. Count ALL corroborating in-range samples in the window
    -- (not just this latest one) before committing to PRESENT/LATE.
    update public.attendance_records
    set distance_m = v_distance,
        accuracy_m = v_sample.accuracy_m,
        sample_count = (
          select count(*) from public.location_samples ls2
          where ls2.student_id = v_student.student_id
            and ls2.recorded_at between v_session.attendance_window_start and least(clock_timestamp(), v_session.attendance_window_end)
            and extensions.ST_DWithin(v_classroom.location, ls2.location, v_classroom.radius_m)
        ),
        first_detected_at = coalesce(first_detected_at, now())
    where class_session_id = p_class_session_id and student_id = v_student.student_id;

    update public.attendance_records ar
    set status = case
          when ar.sample_count < v_cfg.min_confirmations_required then 'VERIFYING'::public.attendance_status
          when v_sample.recorded_at <= v_session.scheduled_start + make_interval(mins => v_cfg.grace_period_minutes) then 'PRESENT'::public.attendance_status
          else 'LATE'::public.attendance_status
        end,
        verified_at = case when ar.sample_count >= v_cfg.min_confirmations_required then now() else ar.verified_at end
    where ar.class_session_id = p_class_session_id and ar.student_id = v_student.student_id
      and ar.status not in ('PRESENT', 'LATE');
  end loop;
end;
$$;

-- -----------------------------------------------------------------------------
-- public.evaluate_class_session — the on-demand entry point (the live
-- dashboard's "Refresh" button, or a real deployment's scheduled Edge
-- Function — see docs/22 ADR-014 for why no scheduler runs in this
-- environment). SECURITY INVOKER wrapper: permission/scope-checks as the
-- calling user, then delegates to the trusted definer function above.
-- -----------------------------------------------------------------------------
create or replace function public.evaluate_class_session(p_class_session_id uuid)
returns void
language plpgsql
security invoker
set search_path = public, extensions, pg_temp
as $$
begin
  if not cims.has_permission('attendance.write') then
    raise exception 'Not authorised to evaluate attendance' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.class_sessions cs
    where cs.id = p_class_session_id
      and (
        cims.is_admin()
        or cs.faculty_id = cims.my_faculty_id()
        or exists (select 1 from public.sections s where s.id = cs.section_id and s.department_id in (select cims.my_department_ids()))
      )
  ) then
    raise exception 'Not authorised to evaluate this class session' using errcode = '42501';
  end if;

  perform cims.evaluate_class_session(p_class_session_id);
end;
$$;

-- -----------------------------------------------------------------------------
-- finalize_class_session — closes a session. Runs one last evaluation pass
-- first (a late-arriving sample just before closing still counts), then
-- resolves every remaining non-terminal record to ABSENT (never had a
-- sample) or OUTSIDE_CLASSROOM (detected, never in range) — the only two
-- places in this whole engine those statuses are ever assigned, and only
-- once the window has genuinely closed.
-- -----------------------------------------------------------------------------
create or replace function public.finalize_class_session(p_class_session_id uuid)
returns void
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_session public.class_sessions;
begin
  select * into v_session from public.class_sessions where id = p_class_session_id;
  if v_session.id is null then
    raise exception 'Class session not found or not visible' using errcode = '02000';
  end if;
  if not cims.has_permission('attendance.finalize') then
    raise exception 'Not authorised to finalize attendance' using errcode = '42501';
  end if;
  if not (
    cims.is_admin()
    or v_session.faculty_id = cims.my_faculty_id()
    or exists (select 1 from public.sections s where s.id = v_session.section_id and s.department_id in (select cims.my_department_ids()))
  ) then
    raise exception 'Not authorised to finalize this class session' using errcode = '42501';
  end if;

  perform cims.evaluate_class_session(p_class_session_id);

  update public.attendance_records
  set status = case
        when status in ('DETECTED', 'VERIFYING') then 'OUTSIDE_CLASSROOM'::public.attendance_status
        when status = 'PENDING' then 'ABSENT'::public.attendance_status
        else status
      end
  where class_session_id = p_class_session_id
    and status in ('PENDING', 'DETECTED', 'VERIFYING');

  update public.class_sessions
  set status = 'CLOSED', finalized_at = now(), finalized_by = auth.uid()
  where id = p_class_session_id;
end;
$$;

-- -----------------------------------------------------------------------------
-- override_attendance — the sole manual-write path. SECURITY DEFINER: no
-- direct UPDATE policy exists on attendance_records (see the table's RLS
-- section above), so authorization is entirely re-derived here, mirroring
-- attendance_records_select's staff-reach enumeration exactly.
-- -----------------------------------------------------------------------------
create or replace function public.override_attendance(
  p_record_id uuid,
  p_new_status public.attendance_status,
  p_reason text
)
returns void
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_old public.attendance_records;
begin
  if p_reason is null or length(btrim(p_reason)) = 0 then
    raise exception 'A reason is required for a manual attendance override' using errcode = '23514';
  end if;
  if p_new_status not in ('MANUAL_PRESENT', 'MANUAL_ABSENT') then
    raise exception 'Manual override must set MANUAL_PRESENT or MANUAL_ABSENT' using errcode = '23514';
  end if;
  if not cims.has_permission('attendance.override') then
    raise exception 'Not authorised to override attendance' using errcode = '42501';
  end if;

  select * into v_old from public.attendance_records where id = p_record_id;
  if v_old.id is null then
    raise exception 'Attendance record not found' using errcode = '02000';
  end if;

  if not exists (
    select 1 from public.class_sessions cs
    where cs.id = v_old.class_session_id
      and (
        cims.is_admin()
        or cs.faculty_id = cims.my_faculty_id()
        or exists (select 1 from cims.my_role_assignments() ra where ra.scope_kind = 'SECTION' and ra.section_id = cs.section_id)
        or exists (select 1 from public.sections s where s.id = cs.section_id and s.department_id in (select cims.my_department_ids()))
      )
  ) then
    raise exception 'Not authorised to override this attendance record' using errcode = '42501';
  end if;

  update public.attendance_records
  set status = p_new_status, is_manual = true, override_reason = p_reason,
      overridden_by = auth.uid(), overridden_at = now()
  where id = p_record_id;

  perform cims.write_audit(
    'UPDATE', 'attendance_records', p_record_id::text,
    jsonb_build_object('status', v_old.status),
    jsonb_build_object('status', p_new_status),
    p_reason
  );
end;
$$;

comment on function public.override_attendance is
  'The only path that can set MANUAL_PRESENT/MANUAL_ABSENT. Reason is mandatory (attendance_records_manual_needs_reason CHECK backs this up at the row level too) and every call is audited with the old/new status and the reason.';

grant execute on function
  public.get_or_create_class_session(uuid, date),
  public.submit_location(double precision, double precision, double precision),
  public.evaluate_class_session(uuid),
  public.finalize_class_session(uuid),
  public.override_attendance(uuid, public.attendance_status, text)
to authenticated;
