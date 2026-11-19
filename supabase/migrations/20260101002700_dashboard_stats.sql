-- =============================================================================
-- 20260101002700_dashboard_stats
-- Dashboard Command Center aggregations.
--
-- get_dashboard_stats() returns institution-wide KPIs scoped to the calling
-- user's RLS context (SECURITY INVOKER), used by the admin dashboard's KPI
-- cards (DashboardPage.tsx). Never widens what the caller can already see.
--
-- get_department_strength() returns per-department student counts for the
-- Department Strength donut chart — also SECURITY INVOKER.
--
-- get_today_attendance_trend() returns today's per-session attendance rates
-- for the attendance timeline panel.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- get_dashboard_stats() — flat JSON object of today's institutional KPIs.
-- ---------------------------------------------------------------------------
create or replace function public.get_dashboard_stats()
returns jsonb
language sql
security invoker
stable
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    -- Total students enrolled (active, within calling user's RLS scope)
    'total_students',
    (select count(*)::int from public.students where status = 'ACTIVE'),

    -- Today's attendance: count VERIFIED statuses across today's sessions
    'present_today',
    (
      select count(*)::int
      from public.attendance_records ar
      join public.class_sessions cs on cs.id = ar.class_session_id
      where cs.session_date = current_date
        and ar.status in ('PRESENT', 'LATE', 'MANUAL_PRESENT')
    ),

    'absent_today',
    (
      select count(*)::int
      from public.attendance_records ar
      join public.class_sessions cs on cs.id = ar.class_session_id
      where cs.session_date = current_date
        and ar.status in ('ABSENT', 'MANUAL_ABSENT', 'OUTSIDE_CAMPUS', 'OUTSIDE_CLASSROOM')
    ),

    'total_records_today',
    (
      select count(*)::int
      from public.attendance_records ar
      join public.class_sessions cs on cs.id = ar.class_session_id
      where cs.session_date = current_date
    ),

    -- Active class sessions today (open for marking or in verification)
    'active_classes_today',
    (
      select count(*)::int
      from public.class_sessions
      where session_date = current_date
        and status in ('OPEN', 'VERIFICATION', 'ATTENDANCE_OPEN')
    ),

    -- Total class sessions today
    'total_classes_today',
    (
      select count(*)::int
      from public.class_sessions
      where session_date = current_date
    ),

    -- Active departments
    'active_departments',
    (select count(*)::int from public.departments where status = 'ACTIVE'),

    -- Active geofences
    'active_geofences',
    (select count(*)::int from public.geofences where status = 'ACTIVE')
  );
$$;

comment on function public.get_dashboard_stats() is
  'Institution-wide KPI snapshot for the admin dashboard — SECURITY INVOKER, scoped to calling user''s RLS context. Returns counts of students, today''s attendance, class sessions, departments and geofences.';

grant execute on function public.get_dashboard_stats() to authenticated;


-- ---------------------------------------------------------------------------
-- get_department_strength() — per-department student count for pie chart.
-- ---------------------------------------------------------------------------
create or replace function public.get_department_strength()
returns table (
  department_id uuid,
  department_name text,
  student_count bigint
)
language sql
security invoker
stable
set search_path = public, pg_temp
as $$
  select
    d.id,
    d.name,
    count(st.id) as student_count
  from public.departments d
  left join public.students st on st.department_id = d.id and st.status = 'ACTIVE'
  where d.status = 'ACTIVE'
  group by d.id, d.name
  order by student_count desc;
$$;

comment on function public.get_department_strength() is
  'Per-department student count for the Department Strength donut chart — SECURITY INVOKER.';

grant execute on function public.get_department_strength() to authenticated;


-- ---------------------------------------------------------------------------
-- get_today_class_sessions() — today's sessions for timetable widget.
-- Returns only sessions the calling user can see via RLS on class_sessions.
-- ---------------------------------------------------------------------------
create or replace function public.get_today_class_sessions()
returns table (
  session_id uuid,
  subject_code text,
  subject_name text,
  section_name text,
  section_year int,
  classroom_name text,
  scheduled_start timestamptz,
  scheduled_end timestamptz,
  status text,
  present_count bigint,
  absent_count bigint,
  total_count bigint
)
language sql
security invoker
stable
set search_path = public, pg_temp
as $$
  select
    cs.id,
    sub.code,
    sub.name,
    sec.name,
    sec.year,
    cl.name,
    cs.scheduled_start,
    cs.scheduled_end,
    cs.status::text,
    count(ar.id) filter (where ar.status in ('PRESENT','LATE','MANUAL_PRESENT')) as present_count,
    count(ar.id) filter (where ar.status in ('ABSENT','MANUAL_ABSENT','OUTSIDE_CAMPUS','OUTSIDE_CLASSROOM')) as absent_count,
    count(ar.id) as total_count
  from public.class_sessions cs
  join public.subjects sub on sub.id = cs.subject_id
  join public.sections sec on sec.id = cs.section_id
  left join public.classrooms cl on cl.id = cs.classroom_id
  left join public.attendance_records ar on ar.class_session_id = cs.id
  where cs.session_date = current_date
  group by cs.id, sub.code, sub.name, sec.name, sec.year, cl.name,
           cs.scheduled_start, cs.scheduled_end, cs.status
  order by cs.scheduled_start;
$$;

comment on function public.get_today_class_sessions() is
  'Today''s class sessions with attendance counts — drives the dashboard Timetable widget. SECURITY INVOKER.';

grant execute on function public.get_today_class_sessions() to authenticated;
