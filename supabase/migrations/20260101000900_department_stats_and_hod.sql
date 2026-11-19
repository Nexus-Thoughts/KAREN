-- =============================================================================
-- 20260101000900_department_stats_and_hod
-- Phase 6 — real (not hard-coded) per-department counts, and reading a
-- department's assigned HOD(s).
--
-- docs/20_DB_SCHEMA_DETAIL.md
-- =============================================================================

-- -----------------------------------------------------------------------------
-- department_stats
--
-- `security_invoker = true` (Postgres 15+) makes this view enforce RLS as the
-- CALLING role, not the view owner — so a HOD's count of "students in my
-- department" is naturally scoped by students_select_scoped, an ADMIN's by
-- nothing, and so on, with no extra permission plumbing here. This is the
-- correct behaviour for this screen: DepartmentsPage's stats card is supposed
-- to show what the viewer can actually reach, not a global institutional
-- total leaking through a card that ignores scope.
-- -----------------------------------------------------------------------------
create view public.department_stats
with (security_invoker = true) as
select
  d.id as department_id,
  count(distinct c.id)  filter (where c.status = 'ACTIVE')   as active_course_count,
  count(distinct s.id)  filter (where s.status = 'ACTIVE')   as active_student_count,
  count(distinct f.id)  filter (where f.status = 'ACTIVE')   as active_faculty_count
from public.departments d
left join public.courses  c on c.department_id = d.id
left join public.students s on s.department_id = d.id
left join public.faculty  f on f.department_id = d.id
group by d.id;

comment on view public.department_stats is
  'Per-department counts, computed live from courses/students/faculty. security_invoker means each viewer sees counts scoped by their own RLS reach — not a global total.';

grant select on public.department_stats to authenticated;

-- -----------------------------------------------------------------------------
-- department_hods
--
-- Resolves the HOD(s) currently assigned to each department via user_roles,
-- for DepartmentsPage's "HOD" column/detail view. A department may
-- transiently have zero or more than one active HOD assignment (acting HOD
-- during a transition); the UI picks the first if it wants a single name.
-- -----------------------------------------------------------------------------
create view public.department_hods
with (security_invoker = true) as
select
  ur.department_id,
  u.id as user_id,
  u.full_name,
  u.email
from public.user_roles ur
join public.roles r on r.id = ur.role_id and r.key = 'HOD'
join public.users u on u.id = ur.user_id
where ur.status = 'ACTIVE'
  and ur.valid_from <= now()
  and (ur.valid_until is null or ur.valid_until > now());

comment on view public.department_hods is
  'Active HOD role assignments joined to their department, for display. Not an authorization surface — see cims.my_department_ids() for that.';

grant select on public.department_hods to authenticated;
