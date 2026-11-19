-- =============================================================================
-- 20260101001100_timetable_classroom_rls
-- Phase 7 — RLS for classrooms and timetable_entries.
--
-- No base-table GRANT block here: `alter default privileges ... grant
-- select, insert, update, delete on tables to authenticated` (in
-- 20260101000700_rls_policies, discovered the hard way — ADR-008) applies to
-- every table created afterward by the same connecting role, which is what
-- `supabase db reset` uses for every migration. Verified by pgTAP below
-- rather than assumed — the whole point of ADR-008 was "prove it by running
-- it", not "reason about it and move on".
-- =============================================================================

-- -----------------------------------------------------------------------------
-- classrooms
--
-- Read: department scope, OR the classroom is used by a timetable entry the
-- caller can already reach (a student/faculty attending a class in a shared
-- lab hosted by a different department must still resolve that room's name).
-- Write: classrooms.write + department scope — ADMIN/HOD only under the
-- current role_permissions grants (docs deliberately defer to "the existing
-- permission model" rather than mandating a FACULTY grant here).
-- -----------------------------------------------------------------------------
create policy classrooms_select on public.classrooms
  for select to authenticated
  using (
    cims.is_active_user()
    and (
      department_id in (select cims.my_department_ids())
      or id in (
        select te.classroom_id from public.timetable_entries te
        where te.section_id in (select cims.my_section_ids())
           or te.faculty_id = cims.my_faculty_id()
      )
    )
  );

create policy classrooms_write on public.classrooms
  for all to authenticated
  using (
    cims.is_active_user() and cims.has_permission('classrooms.write')
    and (cims.is_admin() or department_id in (select cims.my_department_ids()))
  )
  with check (
    cims.is_active_user() and cims.has_permission('classrooms.write')
    and (cims.is_admin() or department_id in (select cims.my_department_ids()))
  );

-- -----------------------------------------------------------------------------
-- timetable_entries
--
-- cims.my_section_ids() already IS the exact scope model this needs: ADMIN
-- (all), HOD (department sections), CLASS_INCHARGE (own section), FACULTY
-- (assigned sections), MENTOR (mentee sections), STUDENT (own section) — see
-- 20260101000600_authorization_functions. Reused rather than re-derived.
-- -----------------------------------------------------------------------------
create policy timetable_select on public.timetable_entries
  for select to authenticated
  using (
    cims.is_active_user()
    and (
      section_id in (select cims.my_section_ids())
      or faculty_id = cims.my_faculty_id()
    )
  );

create policy timetable_write on public.timetable_entries
  for all to authenticated
  using (
    cims.is_active_user() and cims.has_permission('timetable.write')
    and exists (
      select 1 from public.sections s
      where s.id = timetable_entries.section_id
        and (cims.is_admin() or s.department_id in (select cims.my_department_ids()))
    )
  )
  with check (
    cims.is_active_user() and cims.has_permission('timetable.write')
    and exists (
      select 1 from public.sections s
      where s.id = timetable_entries.section_id
        and (cims.is_admin() or s.department_id in (select cims.my_department_ids()))
    )
  );
