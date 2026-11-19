-- =============================================================================
-- seed.sql — local development fixtures.
--
-- Applied automatically by `supabase db reset`. This never runs against a
-- linked production project (Supabase only executes seed.sql for local/reset).
--
-- All identifiers below are synthetic. Coordinates are clearly out-of-world
-- placeholders (docs/00 blocker #3: no real campus polygon exists yet) so a
-- geofence test can never be mistaken for a real boundary.
--
-- Auth users are created via `auth.users` directly with a known local-only
-- password, matching the pattern Supabase's own seed examples use, since
-- `supabase db reset` runs before GoTrue is reachable over HTTP.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Auth users. Password for all seed accounts: 'Cims!Local123' (dev/test only).
-- -----------------------------------------------------------------------------
-- email_change / email_change_token_new have no column default in auth.users
-- and GoTrue's Go scanner cannot handle NULL there (confirmed by reading
-- supabase_auth_cims's own logs: "Scan error on column index 8, name
-- 'email_change': converting NULL to string is unsupported") — see
-- docs/22_ARCHITECTURE_DECISIONS.md ADR-006. Both are set to '' explicitly.
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
  created_at, updated_at, confirmation_token, recovery_token,
  email_change, email_change_token_new
) values
  ('00000000-0000-0000-0000-000000000000', '10000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 'admin@cims.test',         crypt('Cims!Local123', gen_salt('bf')), now(), '{"provider":"email","providers":["email"]}', '{"full_name":"Ada Admin"}',        now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '10000000-0000-0000-0000-000000000002', 'authenticated', 'authenticated', 'hod.cs@cims.test',        crypt('Cims!Local123', gen_salt('bf')), now(), '{"provider":"email","providers":["email"]}', '{"full_name":"Harish Odedra"}',    now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '10000000-0000-0000-0000-000000000003', 'authenticated', 'authenticated', 'faculty.ds@cims.test',    crypt('Cims!Local123', gen_salt('bf')), now(), '{"provider":"email","providers":["email"]}', '{"full_name":"Farah Sultana"}',    now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '10000000-0000-0000-0000-000000000004', 'authenticated', 'authenticated', 'mentor.cs@cims.test',     crypt('Cims!Local123', gen_salt('bf')), now(), '{"provider":"email","providers":["email"]}', '{"full_name":"Manoj Verma"}',      now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '10000000-0000-0000-0000-000000000005', 'authenticated', 'authenticated', 'incharge.cs3a@cims.test', crypt('Cims!Local123', gen_salt('bf')), now(), '{"provider":"email","providers":["email"]}', '{"full_name":"Indira Chowdhury"}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '10000000-0000-0000-0000-000000000006', 'authenticated', 'authenticated', 'student.rahul@cims.test', crypt('Cims!Local123', gen_salt('bf')), now(), '{"provider":"email","providers":["email"]}', '{"full_name":"Rahul Nair"}',       now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '10000000-0000-0000-0000-000000000007', 'authenticated', 'authenticated', 'student.priya@cims.test', crypt('Cims!Local123', gen_salt('bf')), now(), '{"provider":"email","providers":["email"]}', '{"full_name":"Priya Krishnan"}',   now(), now(), '', '', '', ''),
  -- DEVELOPMENT ONLY — an administrator-provisioned account exercising the
  -- forced first-login password change flow end to end (must_change_password
  -- is set true below). Institutional User ID = the college email address;
  -- 'tharun1234' is a throwaway local password, never used outside this
  -- seed, never committed anywhere as a real credential, and never valid
  -- against any hosted project. A real deployment provisions accounts
  -- through the admin user-management flow, not this file — `supabase
  -- db reset`/seed.sql only ever runs against the local dev stack.
  ('00000000-0000-0000-0000-000000000000', '10000000-0000-0000-0000-000000000008', 'authenticated', 'authenticated', 'tharun@MEC.com',          crypt('tharun1234', gen_salt('bf')),   now(), '{"provider":"email","providers":["email"]}', '{"full_name":"Tharun"}',           now(), now(), '', '', '', '')
on conflict (id) do nothing;

-- auth.identities: required for GoTrue's email/password grant to resolve the
-- user. provider_id = the user's own id, matching Supabase's seed convention.
insert into auth.identities (
  id, provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at
)
select
  extensions.gen_random_uuid(), u.id::text, u.id,
  jsonb_build_object('sub', u.id::text, 'email', u.email),
  'email', now(), now(), now()
from auth.users u
where u.id in (
  '10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002',
  '10000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000004',
  '10000000-0000-0000-0000-000000000005', '10000000-0000-0000-0000-000000000006',
  '10000000-0000-0000-0000-000000000007', '10000000-0000-0000-0000-000000000008'
)
on conflict do nothing;

-- public.users rows are created by the on_auth_user_created trigger.

-- The dev-only account above is provisioned exactly the way an admin
-- provisioning flow would leave one: must_change_password = true, forcing
-- the ChangePasswordGate on first sign-in.
update public.users set must_change_password = true
where id = '10000000-0000-0000-0000-000000000008';

-- -----------------------------------------------------------------------------
-- Academic structure
-- -----------------------------------------------------------------------------
insert into public.departments (id, code, name, status) values
  ('20000000-0000-0000-0000-000000000001', 'CS',   'Computer Science', 'ACTIVE'),
  ('20000000-0000-0000-0000-000000000002', 'AIDS', 'AI & Data Science', 'ACTIVE'),
  ('20000000-0000-0000-0000-000000000003', 'ECE',  'Electronics & Communication', 'ACTIVE');

insert into public.courses (id, department_id, code, name, duration_years) values
  ('20000000-0000-0000-0000-000000000101', '20000000-0000-0000-0000-000000000001', 'BTECH-CS',   'B.Tech Computer Science', 4),
  ('20000000-0000-0000-0000-000000000102', '20000000-0000-0000-0000-000000000002', 'BTECH-AIDS', 'B.Tech AI & Data Science', 4);

insert into public.academic_years (id, label, start_date, end_date, is_current) values
  ('20000000-0000-0000-0000-000000000201', '2026-2027', '2026-06-01', '2027-05-31', true);

insert into public.semesters (id, academic_year_id, number, label, start_date, end_date, is_current) values
  ('20000000-0000-0000-0000-000000000301', '20000000-0000-0000-0000-000000000201', 5, 'Semester 5', '2026-06-01', '2026-11-15', true),
  ('20000000-0000-0000-0000-000000000302', '20000000-0000-0000-0000-000000000201', 6, 'Semester 6', '2026-12-01', '2027-05-31', false);

insert into public.sections (id, department_id, course_id, academic_year_id, name, year, current_semester_id, batch) values
  ('20000000-0000-0000-0000-000000000401', '20000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000101', '20000000-0000-0000-0000-000000000201', 'A', 3, '20000000-0000-0000-0000-000000000301', '2023-2027');

insert into public.subjects (id, department_id, course_id, code, name, credits, semester_number, type) values
  ('20000000-0000-0000-0000-000000000501', '20000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000101', 'CS501', 'Data Science', 4, 5, 'THEORY_PRACTICAL'),
  ('20000000-0000-0000-0000-000000000502', '20000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000101', 'CS502', 'Operating Systems', 4, 5, 'THEORY');

-- -----------------------------------------------------------------------------
-- People
-- -----------------------------------------------------------------------------
insert into public.faculty (id, user_id, department_id, employee_id, designation, status) values
  ('20000000-0000-0000-0000-000000000601', '10000000-0000-0000-0000-000000000003', '20000000-0000-0000-0000-000000000001', 'FAC-001', 'Assistant Professor', 'ACTIVE'),
  ('20000000-0000-0000-0000-000000000602', '10000000-0000-0000-0000-000000000004', '20000000-0000-0000-0000-000000000001', 'FAC-002', 'Associate Professor', 'ACTIVE'),
  ('20000000-0000-0000-0000-000000000603', '10000000-0000-0000-0000-000000000005', '20000000-0000-0000-0000-000000000001', 'FAC-003', 'Assistant Professor', 'ACTIVE');

insert into public.students (
  id, user_id, department_id, course_id, section_id, academic_year_id, current_semester_id,
  register_number, roll_number, year, batch, mentor_id, class_incharge_id, status
) values
  ('20000000-0000-0000-0000-000000000701', '10000000-0000-0000-0000-000000000006',
   '20000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000101',
   '20000000-0000-0000-0000-000000000401', '20000000-0000-0000-0000-000000000201',
   '20000000-0000-0000-0000-000000000301', 'REG2023CS041', '41', 3, '2023-2027',
   '20000000-0000-0000-0000-000000000602', '20000000-0000-0000-0000-000000000603', 'ACTIVE'),
  ('20000000-0000-0000-0000-000000000702', '10000000-0000-0000-0000-000000000007',
   '20000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000101',
   '20000000-0000-0000-0000-000000000401', '20000000-0000-0000-0000-000000000201',
   '20000000-0000-0000-0000-000000000301', 'REG2023CS042', '42', 3, '2023-2027',
   '20000000-0000-0000-0000-000000000602', '20000000-0000-0000-0000-000000000603', 'ACTIVE');

insert into public.faculty_subject_assignments (faculty_id, subject_id, section_id, semester_id, status) values
  ('20000000-0000-0000-0000-000000000601', '20000000-0000-0000-0000-000000000501', '20000000-0000-0000-0000-000000000401', '20000000-0000-0000-0000-000000000301', 'ACTIVE');

insert into public.student_subject_enrolments (student_id, subject_id, semester_id, status) values
  ('20000000-0000-0000-0000-000000000701', '20000000-0000-0000-0000-000000000501', '20000000-0000-0000-0000-000000000301', 'ACTIVE'),
  ('20000000-0000-0000-0000-000000000702', '20000000-0000-0000-0000-000000000501', '20000000-0000-0000-0000-000000000301', 'ACTIVE');

-- -----------------------------------------------------------------------------
-- Role assignments
-- -----------------------------------------------------------------------------
insert into public.user_roles (user_id, role_id, department_id, section_id, granted_by)
select '10000000-0000-0000-0000-000000000001', id, null, null, '10000000-0000-0000-0000-000000000001'
from public.roles where key = 'ADMIN';

insert into public.user_roles (user_id, role_id, department_id, section_id, granted_by)
select '10000000-0000-0000-0000-000000000002', id, '20000000-0000-0000-0000-000000000001', null, '10000000-0000-0000-0000-000000000001'
from public.roles where key = 'HOD';

insert into public.user_roles (user_id, role_id, department_id, section_id, granted_by)
select '10000000-0000-0000-0000-000000000003', id, null, null, '10000000-0000-0000-0000-000000000001'
from public.roles where key = 'FACULTY';

insert into public.user_roles (user_id, role_id, department_id, section_id, granted_by)
select '10000000-0000-0000-0000-000000000004', id, null, null, '10000000-0000-0000-0000-000000000001'
from public.roles where key = 'MENTOR';

insert into public.user_roles (user_id, role_id, department_id, section_id, granted_by)
select '10000000-0000-0000-0000-000000000005', id, '20000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000401', '10000000-0000-0000-0000-000000000001'
from public.roles where key = 'CLASS_INCHARGE';

insert into public.user_roles (user_id, role_id, department_id, section_id, granted_by)
select '10000000-0000-0000-0000-000000000006', id, null, null, '10000000-0000-0000-0000-000000000001'
from public.roles where key = 'STUDENT';

insert into public.user_roles (user_id, role_id, department_id, section_id, granted_by)
select '10000000-0000-0000-0000-000000000007', id, null, null, '10000000-0000-0000-0000-000000000001'
from public.roles where key = 'STUDENT';

-- DEVELOPMENT ONLY — see the auth.users insert above.
insert into public.user_roles (user_id, role_id, department_id, section_id, granted_by)
select '10000000-0000-0000-0000-000000000008', id, null, null, '10000000-0000-0000-0000-000000000001'
from public.roles where key = 'ADMIN';

-- -----------------------------------------------------------------------------
-- Phase 7 — classroom and timetable fixtures.
--
-- Coordinates are Null Island (0, 0) — a well-known GIS convention for "this
-- is deliberately not a real place" (docs/00 blocker #3: no real campus
-- coordinates exist yet). ST_DWithin/distance behaviour is exercised in
-- pgTAP using synthetic offsets from this same point, never a real one.
-- -----------------------------------------------------------------------------
insert into public.classrooms (id, department_id, name, block, floor, capacity, type, status, location, radius_m) values
  ('20000000-0000-0000-0000-000000000801', '20000000-0000-0000-0000-000000000001',
   'CS-301', 'Main Block', '3', 60, 'CLASSROOM', 'ACTIVE',
   extensions.ST_SetSRID(extensions.ST_MakePoint(0, 0), 4326)::extensions.geography, 20);

insert into public.timetable_entries (
  academic_year_id, semester_id, section_id, subject_id, faculty_id, classroom_id, day, start_time, end_time
) values
  ('20000000-0000-0000-0000-000000000201', '20000000-0000-0000-0000-000000000301',
   '20000000-0000-0000-0000-000000000401', '20000000-0000-0000-0000-000000000501',
   '20000000-0000-0000-0000-000000000601', '20000000-0000-0000-0000-000000000801',
   'MON', '10:00', '10:50');
