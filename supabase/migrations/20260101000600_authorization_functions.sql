-- =============================================================================
-- 20260101000600_authorization_functions
-- Phase 4 — the authorisation kernel.
--
-- Every RLS policy in KAREN is written in terms of these functions. They are the
-- single place where "what can this principal reach" is decided, which is what
-- makes the answer testable and keeps it consistent between the REST API,
-- Realtime, Edge Functions and KAREN's tool layer.
--
-- All are SECURITY DEFINER so they can read the RBAC tables without recursing
-- into the very policies they are being used to evaluate, and STABLE so
-- PostgreSQL evaluates them once per statement rather than once per row.
--
-- docs/04_RBAC_AND_PERMISSIONS.md, docs/13_SECURITY_AND_PRIVACY.md
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Identity
-- -----------------------------------------------------------------------------
create or replace function cims.current_user_id()
returns uuid
language sql stable
set search_path = public, pg_temp
as $$ select auth.uid(); $$;

-- Deny-by-default gate. A suspended or deactivated account fails here, so
-- every policy that starts with is_active_user() fails closed for them without
-- each policy having to remember.
create or replace function cims.is_active_user()
returns boolean
language sql stable security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.users u
    where u.id = auth.uid() and u.status = 'ACTIVE'
  );
$$;

comment on function cims.is_active_user is
  'True only for an authenticated, ACTIVE profile. First condition of every RLS policy.';

-- -----------------------------------------------------------------------------
-- Live role assignments for the current principal.
-- -----------------------------------------------------------------------------
create or replace function cims.my_role_assignments()
returns table (
  role_key      public.role_key,
  scope_kind    public.scope_kind,
  department_id uuid,
  section_id    uuid
)
language sql stable security definer
set search_path = public, pg_temp
as $$
  select r.key, r.default_scope, ur.department_id, ur.section_id
  from public.user_roles ur
  join public.roles r on r.id = ur.role_id
  where ur.user_id = auth.uid()
    and ur.status = 'ACTIVE'
    and ur.valid_from <= now()
    and (ur.valid_until is null or ur.valid_until > now());
$$;

create or replace function cims.has_role(p_role public.role_key)
returns boolean
language sql stable security definer
set search_path = public, pg_temp
as $$
  select exists (select 1 from cims.my_role_assignments() where role_key = p_role);
$$;

create or replace function cims.is_admin()
returns boolean
language sql stable security definer
set search_path = public, pg_temp
as $$ select cims.has_role('ADMIN'); $$;

-- -----------------------------------------------------------------------------
-- Capability check.
--
-- Note what this deliberately does NOT do: it says nothing about scope. Holding
-- `students.read` never means "read all students"; it means "may read students,
-- subject to the scope predicate the policy applies separately". Conflating the
-- two is the classic way RBAC turns into an accidental bypass.
-- -----------------------------------------------------------------------------
create or replace function cims.has_permission(p_key text)
returns boolean
language sql stable security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.user_roles ur
    join public.roles r             on r.id  = ur.role_id
    join public.role_permissions rp on rp.role_id = r.id
    join public.permissions p       on p.id  = rp.permission_id
    where ur.user_id = auth.uid()
      and ur.status = 'ACTIVE'
      and ur.valid_from <= now()
      and (ur.valid_until is null or ur.valid_until > now())
      and p.key = p_key
  );
$$;

comment on function cims.has_permission is
  'Capability check only. Scope is enforced separately by each policy. Never treat a true result as institution-wide reach.';

-- -----------------------------------------------------------------------------
-- Which academic record the principal *is*.
-- -----------------------------------------------------------------------------
create or replace function cims.my_student_id()
returns uuid
language sql stable security definer
set search_path = public, pg_temp
as $$ select id from public.students where user_id = auth.uid() limit 1; $$;

create or replace function cims.my_faculty_id()
returns uuid
language sql stable security definer
set search_path = public, pg_temp
as $$ select id from public.faculty where user_id = auth.uid() limit 1; $$;

-- -----------------------------------------------------------------------------
-- Scope resolution.
--
-- Each returns the set of ids the principal may reach. Policies use
-- `x in (select ... )`, which the planner turns into a hash semi-join.
-- -----------------------------------------------------------------------------

-- Departments: everything for ADMIN, otherwise the departments named on
-- DEPARTMENT-scoped assignments, plus the department of any section the
-- principal is in charge of.
create or replace function cims.my_department_ids()
returns setof uuid
language sql stable security definer
set search_path = public, pg_temp
as $$
  select d.id from public.departments d where cims.is_admin()
  union
  select ra.department_id
  from cims.my_role_assignments() ra
  where ra.department_id is not null;
$$;

-- Sections reachable, by route:
--   ADMIN            every section
--   HOD              every section of a scoped department
--   CLASS_INCHARGE   the named section
--   FACULTY          sections carrying an active subject assignment
--   MENTOR           sections containing at least one mentee
--   STUDENT          own section
create or replace function cims.my_section_ids()
returns setof uuid
language sql stable security definer
set search_path = public, pg_temp
as $$
  select s.id from public.sections s where cims.is_admin()
  union
  select s.id
  from public.sections s
  where s.department_id in (
    select ra.department_id from cims.my_role_assignments() ra
    where ra.scope_kind = 'DEPARTMENT' and ra.department_id is not null
  )
  union
  select ra.section_id
  from cims.my_role_assignments() ra
  where ra.section_id is not null
  union
  select fsa.section_id
  from public.faculty_subject_assignments fsa
  where fsa.faculty_id = cims.my_faculty_id() and fsa.status = 'ACTIVE'
  union
  select st.section_id
  from public.students st
  where st.section_id is not null
    and (st.mentor_id = cims.my_faculty_id() or st.user_id = auth.uid());
$$;

-- Students reachable. Mentor and class-in-charge edges are explicit rather than
-- inherited from the section, so a mentor of three students in a section does
-- not thereby read the whole section.
create or replace function cims.my_student_ids()
returns setof uuid
language sql stable security definer
set search_path = public, pg_temp
as $$
  select st.id from public.students st where cims.is_admin()
  union
  -- own record
  select st.id from public.students st where st.user_id = auth.uid()
  union
  -- HOD: students of a scoped department
  select st.id
  from public.students st
  where st.department_id in (
    select ra.department_id from cims.my_role_assignments() ra
    where ra.scope_kind = 'DEPARTMENT' and ra.department_id is not null
  )
  union
  -- CLASS_INCHARGE: students of the named section, or an explicit edge
  select st.id
  from public.students st
  where st.section_id in (
    select ra.section_id from cims.my_role_assignments() ra
    where ra.scope_kind = 'SECTION' and ra.section_id is not null
  )
  union
  select st.id from public.students st where st.class_incharge_id = cims.my_faculty_id()
  union
  -- MENTOR: explicit mentee edge
  select st.id from public.students st where st.mentor_id = cims.my_faculty_id()
  union
  -- FACULTY: students enrolled in a subject the faculty is assigned to teach,
  -- in the section they teach it to. Enrolment-based rather than section-based,
  -- so an elective taught to part of a section does not expose the rest.
  select distinct sse.student_id
  from public.student_subject_enrolments sse
  join public.students st on st.id = sse.student_id
  join public.faculty_subject_assignments fsa
    on  fsa.subject_id  = sse.subject_id
    and fsa.semester_id = sse.semester_id
    and fsa.section_id  = st.section_id
  where fsa.faculty_id = cims.my_faculty_id()
    and fsa.status = 'ACTIVE'
    and sse.status = 'ACTIVE';
$$;

comment on function cims.my_student_ids is
  'The authoritative student-visibility set. KAREN tools resolve student reach through this same function, so the assistant can never see further than the REST API would.';

-- Subjects reachable.
create or replace function cims.my_subject_ids()
returns setof uuid
language sql stable security definer
set search_path = public, pg_temp
as $$
  select sub.id from public.subjects sub where cims.is_admin()
  union
  select sub.id from public.subjects sub
  where sub.department_id in (select cims.my_department_ids())
  union
  select fsa.subject_id from public.faculty_subject_assignments fsa
  where fsa.faculty_id = cims.my_faculty_id() and fsa.status = 'ACTIVE'
  union
  select sse.subject_id from public.student_subject_enrolments sse
  where sse.student_id = cims.my_student_id() and sse.status = 'ACTIVE';
$$;

-- -----------------------------------------------------------------------------
-- Convenience predicates used across policies.
-- -----------------------------------------------------------------------------
create or replace function cims.can_read_student(p_student_id uuid)
returns boolean
language sql stable security definer
set search_path = public, pg_temp
as $$
  select cims.is_active_user()
     and p_student_id in (select cims.my_student_ids());
$$;

create or replace function cims.can_read_section(p_section_id uuid)
returns boolean
language sql stable security definer
set search_path = public, pg_temp
as $$
  select cims.is_active_user()
     and p_section_id in (select cims.my_section_ids());
$$;

-- Write reach is narrower than read reach: it additionally requires the
-- capability. Used by policies whose WITH CHECK must not simply mirror USING.
create or replace function cims.can_write_student(p_student_id uuid)
returns boolean
language sql stable security definer
set search_path = public, pg_temp
as $$
  select cims.is_active_user()
     and cims.has_permission('students.write')
     and p_student_id in (select cims.my_student_ids());
$$;

-- -----------------------------------------------------------------------------
-- Effective permission set — read by the frontend once at sign-in so the UI can
-- hide controls the user cannot use.
--
-- This is a convenience for presentation ONLY. Hiding a button is not security;
-- the RLS policies are. Exposed through PostgREST as an RPC.
-- -----------------------------------------------------------------------------
create or replace function public.my_permissions()
returns table (permission_key text, resource text, action text, is_sensitive boolean)
language sql stable security definer
set search_path = public, pg_temp
as $$
  select distinct p.key, p.resource, p.action, p.is_sensitive
  from public.user_roles ur
  join public.roles r             on r.id = ur.role_id
  join public.role_permissions rp on rp.role_id = r.id
  join public.permissions p       on p.id = rp.permission_id
  where ur.user_id = auth.uid()
    and ur.status = 'ACTIVE'
    and ur.valid_from <= now()
    and (ur.valid_until is null or ur.valid_until > now())
  order by p.key;
$$;

comment on function public.my_permissions is
  'Effective capability list for the caller. For UI affordances only — never the basis of an access decision.';

create or replace function public.my_profile()
returns jsonb
language sql stable security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'user_id',    u.id,
    'email',      u.email,
    'full_name',  u.full_name,
    'status',     u.status,
    'student_id', cims.my_student_id(),
    'faculty_id', cims.my_faculty_id(),
    'roles', coalesce((
      select jsonb_agg(jsonb_build_object(
        'role',          ra.role_key,
        'scope',         ra.scope_kind,
        'department_id', ra.department_id,
        'section_id',    ra.section_id
      ) order by ra.role_key)
      from cims.my_role_assignments() ra
    ), '[]'::jsonb),
    'permissions', coalesce((
      select jsonb_agg(mp.permission_key order by mp.permission_key)
      from public.my_permissions() mp
    ), '[]'::jsonb)
  )
  from public.users u
  where u.id = auth.uid();
$$;

comment on function public.my_profile is
  'Single round-trip session bootstrap: profile, scoped role assignments and effective permissions.';

-- Expose only the two public RPCs. The cims.* kernel stays unreachable over HTTP.
grant execute on function public.my_permissions() to authenticated;
grant execute on function public.my_profile()     to authenticated;

grant execute on function
  cims.is_active_user(), cims.has_permission(text), cims.has_role(public.role_key),
  cims.is_admin(), cims.current_user_id(), cims.my_role_assignments(),
  cims.my_student_id(), cims.my_faculty_id(),
  cims.my_department_ids(), cims.my_section_ids(), cims.my_student_ids(),
  cims.my_subject_ids(), cims.can_read_student(uuid), cims.can_read_section(uuid),
  cims.can_write_student(uuid)
to authenticated;
