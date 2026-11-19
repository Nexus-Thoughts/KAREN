-- =============================================================================
-- 20260101000700_rls_policies
-- Phase 4 — row level security for identity, RBAC and the academic core.
--
-- Principles applied throughout (docs/13_SECURITY_AND_PRIVACY.md):
--   * Deny by default. RLS is enabled on every table; absence of a policy means
--     no access, not open access.
--   * `anon` gets nothing. Every policy targets `authenticated`.
--   * Read reach and write reach are separate predicates. A USING clause that
--     is silently reused as WITH CHECK is how a read grant becomes a write grant.
--   * Capability and scope are both required, never either alone.
--   * The catalogue tables (roles, permissions) are readable but never writable
--     through the API; they change by migration.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Base table grants.
--
-- GRANT and RLS are two independent gates, not one: GRANT decides whether a
-- role may touch a table's rows AT ALL; RLS policies then decide WHICH rows.
-- Confirmed empirically against this local stack (docs/22_ARCHITECTURE_
-- DECISIONS.md ADR-006): the local Postgres image's baseline privileges do
-- NOT extend SELECT/INSERT/UPDATE/DELETE to `authenticated` automatically —
-- every one of the `create policy` statements below would otherwise be dead
-- code, since `authenticated` would fail with a bare "permission denied"
-- before RLS is ever evaluated (exactly what the pgTAP suite caught).
--
-- `authenticated` is granted the full verb set on every table below; each
-- table's RLS policies (not this grant) are what actually restrict access —
-- a table with RLS enabled and zero policies still denies everything despite
-- holding this grant. `service_role` bypasses RLS by Supabase convention and
-- is used only by Edge Functions/CI, never the browser.
-- -----------------------------------------------------------------------------
grant usage on schema public to authenticated, service_role;

grant select, insert, update, delete on
  public.users, public.roles, public.permissions, public.role_permissions,
  public.user_roles, public.departments, public.courses, public.academic_years,
  public.semesters, public.sections, public.faculty, public.students,
  public.subjects, public.faculty_subject_assignments, public.student_subject_enrolments
to authenticated;

grant select on public.audit_logs to authenticated;

grant all on
  public.users, public.roles, public.permissions, public.role_permissions,
  public.user_roles, public.departments, public.courses, public.academic_years,
  public.semesters, public.sections, public.faculty, public.students,
  public.subjects, public.faculty_subject_assignments, public.student_subject_enrolments,
  public.audit_logs
to service_role;

-- Every table above uses a `uuid` PK generated server-side, not a sequence,
-- so no sequence grants are needed except audit_logs' identity column.
grant usage, select on sequence public.audit_logs_id_seq to authenticated, service_role;

-- Applies the same grant automatically to every table this-and-later
-- migrations add to `public`, so this step never needs repeating per table.
alter default privileges in schema public
  grant select, insert, update, delete on tables to authenticated;
alter default privileges in schema public
  grant all on tables to service_role;
alter default privileges in schema public
  grant usage, select on sequences to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- users
-- -----------------------------------------------------------------------------
create policy users_select_self on public.users
  for select to authenticated
  using (id = auth.uid());

-- Staff may see the profiles of people they can already reach academically:
-- students in scope, and faculty of a department in scope. Not "all users".
create policy users_select_in_scope on public.users
  for select to authenticated
  using (
    cims.is_active_user()
    and cims.has_permission('users.read')
    and (
      cims.is_admin()
      or exists (
        select 1 from public.students st
        where st.user_id = public.users.id
          and st.id in (select cims.my_student_ids())
      )
      or exists (
        select 1 from public.faculty f
        where f.user_id = public.users.id
          and f.department_id in (select cims.my_department_ids())
      )
    )
  );

-- A user may maintain their own contact details. Note the WITH CHECK pins the
-- row identity: without it, a user could update their own row into someone
-- else's id. `status` is not defended here because a non-admin has no UPDATE
-- path that reaches another row, and their own status is guarded by the
-- users_update_admin policy owning privileged changes.
create policy users_update_self on public.users
  for update to authenticated
  using (id = auth.uid() and cims.is_active_user())
  with check (id = auth.uid());

create policy users_write_admin on public.users
  for all to authenticated
  using (cims.is_active_user() and cims.has_permission('users.write'))
  with check (cims.is_active_user() and cims.has_permission('users.write'));

-- -----------------------------------------------------------------------------
-- roles / permissions — readable catalogue, migration-owned.
-- -----------------------------------------------------------------------------
create policy roles_select on public.roles
  for select to authenticated using (cims.is_active_user());

create policy permissions_select on public.permissions
  for select to authenticated using (cims.is_active_user());

create policy role_permissions_select on public.role_permissions
  for select to authenticated using (cims.is_active_user());

-- Regranting capability is itself a privileged, audited operation.
create policy role_permissions_write on public.role_permissions
  for all to authenticated
  using (cims.is_active_user() and cims.has_permission('permissions.manage'))
  with check (cims.is_active_user() and cims.has_permission('permissions.manage'));

-- -----------------------------------------------------------------------------
-- user_roles
--
-- A user may see their own assignments. Granting requires roles.assign AND that
-- the grant falls inside the granter's own scope, which stops an HOD from
-- minting an ADMIN or granting into a department they do not hold.
-- -----------------------------------------------------------------------------
create policy user_roles_select_self on public.user_roles
  for select to authenticated
  using (user_id = auth.uid());

create policy user_roles_select_in_scope on public.user_roles
  for select to authenticated
  using (
    cims.is_active_user()
    and cims.has_permission('users.read')
    and (cims.is_admin() or department_id in (select cims.my_department_ids()))
  );

create policy user_roles_insert on public.user_roles
  for insert to authenticated
  with check (
    cims.is_active_user()
    and cims.has_permission('roles.assign')
    and (
      cims.is_admin()
      or (
        -- A non-admin granter may only grant non-global roles, inside a
        -- department they themselves hold.
        department_id is not null
        and department_id in (select cims.my_department_ids())
        and exists (
          select 1 from public.roles r
          where r.id = user_roles.role_id and r.key <> 'ADMIN'
        )
      )
    )
  );

create policy user_roles_update on public.user_roles
  for update to authenticated
  using (
    cims.is_active_user()
    and cims.has_permission('roles.assign')
    and (cims.is_admin() or department_id in (select cims.my_department_ids()))
  )
  with check (
    cims.is_admin()
    or (department_id is not null and department_id in (select cims.my_department_ids()))
  );

-- No DELETE policy by design: assignments are revoked by setting status to
-- INACTIVE, which keeps the audit trail intact (docs/49).

-- -----------------------------------------------------------------------------
-- departments / courses / academic_years / semesters
--
-- Structural reference data. Any active user may read it — a student needs to
-- resolve their own department's name, and none of it is sensitive. Writing is
-- capability-gated, and department writes are admin-only because creating a
-- department creates a new scope.
-- -----------------------------------------------------------------------------
create policy departments_select on public.departments
  for select to authenticated using (cims.is_active_user());

create policy departments_write on public.departments
  for all to authenticated
  using (cims.is_active_user() and cims.has_permission('departments.write'))
  with check (cims.is_active_user() and cims.has_permission('departments.write'));

create policy courses_select on public.courses
  for select to authenticated using (cims.is_active_user());

create policy courses_write on public.courses
  for all to authenticated
  using (
    cims.is_active_user() and cims.has_permission('courses.write')
    and (cims.is_admin() or department_id in (select cims.my_department_ids()))
  )
  with check (
    cims.is_active_user() and cims.has_permission('courses.write')
    and (cims.is_admin() or department_id in (select cims.my_department_ids()))
  );

create policy academic_years_select on public.academic_years
  for select to authenticated using (cims.is_active_user());

create policy academic_years_write on public.academic_years
  for all to authenticated
  using (cims.is_active_user() and cims.has_permission('academic_terms.write'))
  with check (cims.is_active_user() and cims.has_permission('academic_terms.write'));

create policy semesters_select on public.semesters
  for select to authenticated using (cims.is_active_user());

create policy semesters_write on public.semesters
  for all to authenticated
  using (cims.is_active_user() and cims.has_permission('academic_terms.write'))
  with check (cims.is_active_user() and cims.has_permission('academic_terms.write'));

-- -----------------------------------------------------------------------------
-- sections
-- -----------------------------------------------------------------------------
create policy sections_select on public.sections
  for select to authenticated
  using (
    cims.is_active_user()
    and (
      id in (select cims.my_section_ids())
      -- Structural visibility: a section's existence and name inside a
      -- department the user can see is not sensitive, and the timetable and
      -- report filters need it. Roster access is governed by students policies.
      or department_id in (select cims.my_department_ids())
    )
  );

create policy sections_write on public.sections
  for all to authenticated
  using (
    cims.is_active_user() and cims.has_permission('sections.write')
    and (cims.is_admin() or department_id in (select cims.my_department_ids()))
  )
  with check (
    cims.is_active_user() and cims.has_permission('sections.write')
    and (cims.is_admin() or department_id in (select cims.my_department_ids()))
  );

-- -----------------------------------------------------------------------------
-- subjects
-- -----------------------------------------------------------------------------
create policy subjects_select on public.subjects
  for select to authenticated
  using (
    cims.is_active_user()
    and (
      id in (select cims.my_subject_ids())
      or department_id in (select cims.my_department_ids())
    )
  );

create policy subjects_write on public.subjects
  for all to authenticated
  using (
    cims.is_active_user() and cims.has_permission('subjects.write')
    and (cims.is_admin() or department_id in (select cims.my_department_ids()))
  )
  with check (
    cims.is_active_user() and cims.has_permission('subjects.write')
    and (cims.is_admin() or department_id in (select cims.my_department_ids()))
  );

-- -----------------------------------------------------------------------------
-- students — the core sensitive table.
-- -----------------------------------------------------------------------------
create policy students_select_scoped on public.students
  for select to authenticated
  using (
    cims.is_active_user()
    and (
      user_id = auth.uid()  -- a student always reads their own record
      or (cims.has_permission('students.read') and id in (select cims.my_student_ids()))
    )
  );

create policy students_insert on public.students
  for insert to authenticated
  with check (
    cims.is_active_user()
    and cims.has_permission('students.write')
    and (cims.is_admin() or department_id in (select cims.my_department_ids()))
  );

-- Enrolling a student is scoped by department; updating one is scoped by the
-- reachable-student set. Both the old and the new row must be in scope, so a
-- record cannot be pushed out of the writer's reach by editing department_id.
create policy students_update on public.students
  for update to authenticated
  using (
    cims.is_active_user()
    and cims.has_permission('students.write')
    and id in (select cims.my_student_ids())
  )
  with check (
    cims.is_admin() or department_id in (select cims.my_department_ids())
  );

-- No DELETE policy: students are deactivated via status, never removed.

-- -----------------------------------------------------------------------------
-- faculty
-- -----------------------------------------------------------------------------
create policy faculty_select on public.faculty
  for select to authenticated
  using (
    cims.is_active_user()
    and (
      user_id = auth.uid()
      or (
        cims.has_permission('faculty.read')
        and (cims.is_admin() or department_id in (select cims.my_department_ids()))
      )
      -- A student may resolve the faculty who teach them, and their mentor and
      -- class in-charge. Without this the timetable cannot render a teacher name.
      or exists (
        select 1 from public.students st
        where st.user_id = auth.uid()
          and (st.mentor_id = public.faculty.id or st.class_incharge_id = public.faculty.id)
      )
      or exists (
        select 1
        from public.faculty_subject_assignments fsa
        join public.students st on st.section_id = fsa.section_id
        where fsa.faculty_id = public.faculty.id
          and st.user_id = auth.uid()
          and fsa.status = 'ACTIVE'
      )
    )
  );

create policy faculty_write on public.faculty
  for all to authenticated
  using (
    cims.is_active_user() and cims.has_permission('faculty.write')
    and (cims.is_admin() or department_id in (select cims.my_department_ids()))
  )
  with check (
    cims.is_active_user() and cims.has_permission('faculty.write')
    and (cims.is_admin() or department_id in (select cims.my_department_ids()))
  );

-- -----------------------------------------------------------------------------
-- faculty_subject_assignments
-- -----------------------------------------------------------------------------
create policy fsa_select on public.faculty_subject_assignments
  for select to authenticated
  using (
    cims.is_active_user()
    and (
      faculty_id = cims.my_faculty_id()
      or section_id in (select cims.my_section_ids())
    )
  );

create policy fsa_write on public.faculty_subject_assignments
  for all to authenticated
  using (
    cims.is_active_user() and cims.has_permission('faculty.write')
    and exists (
      select 1 from public.sections s
      where s.id = faculty_subject_assignments.section_id
        and (cims.is_admin() or s.department_id in (select cims.my_department_ids()))
    )
  )
  with check (
    cims.is_active_user() and cims.has_permission('faculty.write')
    and exists (
      select 1 from public.sections s
      where s.id = faculty_subject_assignments.section_id
        and (cims.is_admin() or s.department_id in (select cims.my_department_ids()))
    )
  );

-- -----------------------------------------------------------------------------
-- student_subject_enrolments
-- -----------------------------------------------------------------------------
create policy sse_select on public.student_subject_enrolments
  for select to authenticated
  using (
    cims.is_active_user()
    and (
      student_id = cims.my_student_id()
      or student_id in (select cims.my_student_ids())
    )
  );

create policy sse_write on public.student_subject_enrolments
  for all to authenticated
  using (cims.is_active_user() and cims.can_write_student(student_id))
  with check (cims.is_active_user() and cims.can_write_student(student_id));

-- -----------------------------------------------------------------------------
-- audit_logs — readable only with audit.read, and only within scope.
--
-- There is deliberately no INSERT/UPDATE/DELETE policy. Rows arrive solely
-- through cims.write_audit (SECURITY DEFINER), so no API caller can forge,
-- amend or erase history even with the capability.
-- -----------------------------------------------------------------------------
create policy audit_logs_select on public.audit_logs
  for select to authenticated
  using (
    cims.is_active_user()
    and cims.has_permission('audit.read')
    and (
      cims.is_admin()
      -- A non-admin auditor sees their own actions and actions taken by users
      -- whose profile they can already read.
      or actor_id = auth.uid()
      or exists (select 1 from public.users u where u.id = audit_logs.actor_id)
    )
  );

-- -----------------------------------------------------------------------------
-- Belt and braces: revoke the blanket grants PostgREST relies on from `anon`.
-- RLS already denies anonymous access, but removing the privilege means an
-- accidental `using (true)` in a future migration still cannot leak to the
-- public role.
-- -----------------------------------------------------------------------------
revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;
revoke all on all functions in schema public from anon;

alter default privileges in schema public revoke all on tables from anon;
alter default privileges in schema public revoke all on sequences from anon;
alter default privileges in schema public revoke all on functions from anon;
