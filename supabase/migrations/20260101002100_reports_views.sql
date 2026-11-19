-- =============================================================================
-- 20260101002100_reports_views
-- Phase 12 — Reports.
--
-- docs/10_DOCUMENT_REPORT_ENGINE.md names the report categories (Attendance,
-- section/class, subject/session, department, campus entry/exit, geofence,
-- notification, audit, administrative) and one binding rule: "Generated
-- artifacts inherit user authorization scope." Every view/function below is
-- `security_invoker` (views) or `SECURITY INVOKER` (functions) for exactly
-- that reason — a report is a read over already-RLS-scoped base tables, not
-- a separate authorization surface. No report here ever widens what its
-- caller could already see via the ordinary tables.
--
-- Rendering (PDF/DOCX/XLSX per docs/10's "Outputs") is Phase 13's job
-- (Document Generation) — this phase produces the real, scoped, aggregated
-- data those renderers will consume; the UI exports CSV directly from the
-- same data in the meantime, which needs no server-side rendering step.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- report_section_attendance_stats — one row per (section, subject, semester):
-- how many attendance_records fall into each status, and the resulting
-- present rate. Drives both the "section/class" and "subject/session"
-- report categories (the same aggregation, grouped one column differently
-- would just be two near-duplicate views — this exposes both group keys on
-- one row instead).
-- -----------------------------------------------------------------------------
create view public.report_section_attendance_stats
with (security_invoker = true) as
select
  cs.section_id,
  s.name as section_name,
  cs.subject_id,
  sub.name as subject_name,
  cs.semester_id,
  count(*) filter (where ar.status in ('PRESENT', 'LATE', 'MANUAL_PRESENT'))::int as present_count,
  count(*) filter (where ar.status = 'LATE')::int as late_count,
  count(*) filter (where ar.status in ('ABSENT', 'MANUAL_ABSENT'))::int as absent_count,
  count(*) filter (where ar.status in ('OUTSIDE_CAMPUS', 'OUTSIDE_CLASSROOM', 'LOW_GPS_ACCURACY'))::int as flagged_count,
  count(*)::int as total_count,
  round(
    100.0 * count(*) filter (where ar.status in ('PRESENT', 'LATE', 'MANUAL_PRESENT'))
    / nullif(count(*), 0), 1
  ) as present_rate_pct
from public.attendance_records ar
join public.class_sessions cs on cs.id = ar.class_session_id
join public.sections s on s.id = cs.section_id
join public.subjects sub on sub.id = cs.subject_id
group by cs.section_id, s.name, cs.subject_id, sub.name, cs.semester_id;

comment on view public.report_section_attendance_stats is
  'Per-(section,subject,semester) attendance rate, aggregated over attendance_records under the calling user''s own RLS scope (security_invoker) — the "section/class" and "subject/session" report categories from docs/10.';

grant select on public.report_section_attendance_stats to authenticated;

-- -----------------------------------------------------------------------------
-- report_department_attendance_stats — same aggregation, grouped by
-- department. Complements (not replaces) Phase 6's department_stats view,
-- which reports enrolment counts, not attendance.
-- -----------------------------------------------------------------------------
create view public.report_department_attendance_stats
with (security_invoker = true) as
select
  d.id as department_id,
  d.name as department_name,
  count(*) filter (where ar.status in ('PRESENT', 'LATE', 'MANUAL_PRESENT'))::int as present_count,
  count(*) filter (where ar.status in ('ABSENT', 'MANUAL_ABSENT'))::int as absent_count,
  count(*)::int as total_count,
  round(
    100.0 * count(*) filter (where ar.status in ('PRESENT', 'LATE', 'MANUAL_PRESENT'))
    / nullif(count(*), 0), 1
  ) as present_rate_pct
from public.attendance_records ar
join public.class_sessions cs on cs.id = ar.class_session_id
join public.sections s on s.id = cs.section_id
join public.departments d on d.id = s.department_id
group by d.id, d.name;

comment on view public.report_department_attendance_stats is
  'Per-department attendance rate, security_invoker — the "department" report category from docs/10.';

grant select on public.report_department_attendance_stats to authenticated;

-- -----------------------------------------------------------------------------
-- report_campus_entry_exit — the "campus entry/exit" report category.
-- early_exit_events already IS the campus exit/re-entry log (Phase 10); this
-- exposes it joined to student/department names for report display rather
-- than requiring the frontend to do three separate lookups per row.
-- -----------------------------------------------------------------------------
create function public.report_campus_entry_exit(
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_department_id uuid default null
)
returns table (
  event_id uuid,
  student_id uuid,
  register_number text,
  full_name text,
  department_id uuid,
  department_name text,
  exit_confirmed_at timestamptz,
  re_entered_at timestamptz,
  verification_state public.exit_verification_state
)
language sql
security invoker
stable
set search_path = public, pg_temp
as $$
  select
    e.id, e.student_id, st.register_number, u.full_name,
    st.department_id, d.name,
    e.exit_confirmed_at, e.re_entered_at, e.verification_state
  from public.early_exit_events e
  join public.students st on st.id = e.student_id
  join public.departments d on d.id = st.department_id
  left join public.users u on u.id = st.user_id
  where (p_from is null or e.exit_confirmed_at >= p_from)
    and (p_to is null or e.exit_confirmed_at <= p_to)
    and (p_department_id is null or st.department_id = p_department_id)
  order by e.exit_confirmed_at desc;
$$;

comment on function public.report_campus_entry_exit is
  'SECURITY INVOKER — subject to early_exit_events_select RLS as the calling user (docs/22 ADR-017), so a mentor/class in-charge/HOD sees exactly the students they could already reach, an admin sees all.';

grant execute on function public.report_campus_entry_exit(timestamptz, timestamptz, uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- report_audit_log — the "audit" report category. A thin, filterable
-- projection over audit_logs (already RLS-scoped by audit_logs_select —
-- requires audit.read, see 20260101000700) plus the existing hash-chain
-- verifier, so a report consumer gets both the log and its integrity status
-- in one call rather than two.
-- -----------------------------------------------------------------------------
create function public.report_audit_log(
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_entity_type text default null,
  p_action public.audit_action default null
)
returns setof public.audit_logs
language sql
security invoker
stable
set search_path = public, pg_temp
as $$
  select *
  from public.audit_logs
  where (p_from is null or occurred_at >= p_from)
    and (p_to is null or occurred_at <= p_to)
    and (p_entity_type is null or entity_type = p_entity_type)
    and (p_action is null or action = p_action)
  order by occurred_at desc;
$$;

comment on function public.report_audit_log is
  'SECURITY INVOKER — subject to audit_logs_select RLS (audit.read + scope) as the calling user. Chain integrity for the returned window is checked separately via the existing cims.verify_audit_chain().';

grant execute on function public.report_audit_log(timestamptz, timestamptz, text, public.audit_action) to authenticated;

-- -----------------------------------------------------------------------------
-- report_role_assignments — the "administrative" report category: who holds
-- what role, in what scope, right now. A thin projection over user_roles
-- (already RLS-scoped by user_roles_select_self/user_roles_select_in_scope,
-- 20260101000700) joined to human-readable names.
-- -----------------------------------------------------------------------------
create function public.report_role_assignments(p_department_id uuid default null)
returns table (
  assignment_id uuid,
  user_id uuid,
  full_name text,
  role_key public.role_key,
  department_id uuid,
  department_name text,
  section_id uuid,
  section_name text,
  status public.entity_status,
  valid_from timestamptz,
  valid_until timestamptz
)
language sql
security invoker
stable
set search_path = public, pg_temp
as $$
  select
    ur.id, ur.user_id, u.full_name, r.key,
    ur.department_id, d.name, ur.section_id, sec.name,
    ur.status, ur.valid_from, ur.valid_until
  from public.user_roles ur
  join public.users u on u.id = ur.user_id
  join public.roles r on r.id = ur.role_id
  left join public.departments d on d.id = ur.department_id
  left join public.sections sec on sec.id = ur.section_id
  where p_department_id is null or ur.department_id = p_department_id
  order by u.full_name;
$$;

comment on function public.report_role_assignments is
  'SECURITY INVOKER — subject to user_roles RLS as the calling user; the "administrative" report category from docs/10.';

grant execute on function public.report_role_assignments(uuid) to authenticated;
