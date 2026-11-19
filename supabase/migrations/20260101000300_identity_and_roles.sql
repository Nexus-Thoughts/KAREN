-- =============================================================================
-- 20260101000300_identity_and_roles
-- Phase 4 — identity, the role catalogue and the permission catalogue.
--
-- Supabase Auth (auth.users) owns credentials. KAREN never stores a password,
-- a password hash, or any credential material. public.users is a profile
-- projection keyed 1:1 to auth.users.
--
-- docs/04_RBAC_AND_PERMISSIONS.md, docs/13_SECURITY_AND_PRIVACY.md
-- =============================================================================

create type public.user_status as enum ('ACTIVE', 'INACTIVE', 'SUSPENDED');

-- The six roles named in docs/04. The enum makes an invalid role
-- unrepresentable rather than a string that has to be validated everywhere.
create type public.role_key as enum (
  'ADMIN',
  'HOD',
  'FACULTY',
  'MENTOR',
  'CLASS_INCHARGE',
  'STUDENT'
);

-- How far a role assignment reaches. Checked by cims.* authorisation helpers
-- and therefore by every RLS policy.
create type public.scope_kind as enum (
  'GLOBAL',      -- whole institution (ADMIN)
  'DEPARTMENT',  -- one department (HOD)
  'SECTION',     -- one section (CLASS_INCHARGE)
  'ASSIGNED',    -- rows reached through an explicit assignment table (FACULTY, MENTOR)
  'SELF'         -- only the acting user's own rows (STUDENT)
);

-- -----------------------------------------------------------------------------
-- users — profile for an authenticated principal.
-- -----------------------------------------------------------------------------
create table public.users (
  id            uuid primary key references auth.users (id) on delete cascade,
  email         extensions.citext,
  full_name     text            not null,
  phone         text,
  status        public.user_status not null default 'ACTIVE',
  last_login_at timestamptz,
  created_at    timestamptz     not null default now(),
  updated_at    timestamptz     not null default now(),

  constraint users_full_name_not_blank check (length(btrim(full_name)) > 0),
  constraint users_phone_shape check (phone is null or phone ~ '^[0-9+][0-9 ()-]{5,19}$')
);

comment on table public.users is
  'Profile projection of auth.users. Holds no credential material of any kind.';
comment on column public.users.status is
  'INACTIVE/SUSPENDED users keep their rows for audit integrity but are denied by cims.is_active_user(), so every RLS policy fails closed for them.';

create index users_status_idx on public.users (status) where status = 'ACTIVE';
create index users_full_name_trgm_idx on public.users using gin (full_name extensions.gin_trgm_ops);

create trigger users_set_updated_at
  before update on public.users
  for each row execute function cims.set_updated_at();

create trigger users_audit
  after insert or update or delete on public.users
  for each row execute function cims.audit_row_change();

-- Provision the profile automatically when an administrator creates an auth
-- user. `full_name` is taken from the invite metadata.
create or replace function cims.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.users (id, email, full_name)
  values (
    new.id,
    new.email,
    coalesce(nullif(btrim(new.raw_user_meta_data ->> 'full_name'), ''), split_part(new.email, '@', 1))
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function cims.handle_new_auth_user();

-- -----------------------------------------------------------------------------
-- roles — the fixed catalogue.
-- -----------------------------------------------------------------------------
create table public.roles (
  id            uuid primary key default extensions.gen_random_uuid(),
  key           public.role_key not null unique,
  name          text            not null,
  description   text            not null,
  default_scope public.scope_kind not null,
  -- Lower binds tighter; used to pick a display role when a user holds several.
  rank          smallint        not null,
  created_at    timestamptz     not null default now(),

  constraint roles_rank_unique unique (rank)
);

comment on table public.roles is
  'Fixed catalogue of the six KAREN roles. Seeded by migration, not user-editable.';

insert into public.roles (key, name, description, default_scope, rank) values
  ('ADMIN',          'College Admin',  'Institution-wide administrative access, subject to configured permissions.', 'GLOBAL',     10),
  ('HOD',            'Head of Department', 'Authorised scope over one or more departments.',                         'DEPARTMENT', 20),
  ('CLASS_INCHARGE', 'Class In-charge', 'Responsible for an assigned section.',                                      'SECTION',    30),
  ('MENTOR',         'Mentor',          'Responsible for an explicitly assigned set of mentees.',                    'ASSIGNED',   40),
  ('FACULTY',        'Faculty',         'Teaches assigned subjects to assigned sections.',                           'ASSIGNED',   50),
  ('STUDENT',        'Student',         'Access limited to their own academic record.',                              'SELF',       60);

-- -----------------------------------------------------------------------------
-- permissions — the capability catalogue.
--
-- Named `<resource>.<action>`. RLS policies test permissions, never role names,
-- so an institution can re-grant capability without a schema change.
-- -----------------------------------------------------------------------------
create table public.permissions (
  id          uuid primary key default extensions.gen_random_uuid(),
  key         text        not null unique,
  resource    text        not null,
  action      text        not null,
  description text        not null,
  -- Marks capabilities whose use must always be audited (docs/49).
  is_sensitive boolean    not null default false,
  created_at  timestamptz not null default now(),

  constraint permissions_key_shape check (key = resource || '.' || action)
);

comment on table public.permissions is
  'Capability catalogue. RLS policies check permissions rather than role names so grants stay configurable.';

insert into public.permissions (key, resource, action, description, is_sensitive) values
  -- Identity / administration
  ('users.read',              'users',            'read',      'View user accounts.',                                     false),
  ('users.write',             'users',            'write',     'Create and modify user accounts.',                        true),
  ('roles.assign',            'roles',            'assign',    'Grant or revoke role assignments.',                       true),
  ('permissions.manage',      'permissions',      'manage',    'Modify the permission grants attached to a role.',        true),
  ('audit.read',              'audit',            'read',      'Read the audit trail.',                                   true),
  ('config.read',             'config',           'read',      'View system configuration.',                              false),
  ('config.write',            'config',           'write',     'Modify system configuration.',                            true),

  -- Academic structure
  ('departments.read',        'departments',      'read',      'View departments.',                                       false),
  ('departments.write',       'departments',      'write',     'Create and modify departments.',                          false),
  ('courses.read',            'courses',          'read',      'View courses and programmes.',                            false),
  ('courses.write',           'courses',          'write',     'Create and modify courses and programmes.',               false),
  ('subjects.read',           'subjects',         'read',      'View subjects.',                                          false),
  ('subjects.write',          'subjects',         'write',     'Create and modify subjects.',                             false),
  ('sections.read',           'sections',         'read',      'View sections.',                                          false),
  ('sections.write',          'sections',         'write',     'Create and modify sections.',                             false),
  ('academic_terms.read',     'academic_terms',   'read',      'View academic years and semesters.',                      false),
  ('academic_terms.write',    'academic_terms',   'write',     'Create and modify academic years and semesters.',         false),

  -- People
  ('students.read',           'students',         'read',      'View student records within scope.',                      false),
  ('students.write',          'students',         'write',     'Create and modify student records.',                      false),
  ('students.deactivate',     'students',         'deactivate','Deactivate a student record.',                            true),
  ('faculty.read',            'faculty',          'read',      'View faculty records within scope.',                      false),
  ('faculty.write',           'faculty',          'write',     'Create and modify faculty records.',                      false),

  -- Timetable and classrooms
  ('timetable.read',          'timetable',        'read',      'View timetables within scope.',                           false),
  ('timetable.write',         'timetable',        'write',     'Create and modify timetable entries.',                    false),
  ('classrooms.read',         'classrooms',       'read',      'View classrooms.',                                        false),
  ('classrooms.write',        'classrooms',       'write',     'Create and modify classrooms, including coordinates.',    true),

  -- Attendance
  ('attendance.read',         'attendance',       'read',      'View attendance within scope.',                           false),
  ('attendance.write',        'attendance',       'write',     'Mark attendance for a class session.',                    false),
  ('attendance.override',     'attendance',       'override',  'Manually change a recorded attendance status.',           true),
  ('attendance.finalize',     'attendance',       'finalize',  'Finalise a class session''s attendance.',                 true),
  ('class_sessions.read',     'class_sessions',   'read',      'View class sessions.',                                    false),
  ('class_sessions.write',    'class_sessions',   'write',     'Open, close and manage class sessions.',                  false),

  -- Geospatial and location — sensitive by default (docs/05 privacy section)
  ('geofences.read',          'geofences',        'read',      'View campus and block geofences.',                        false),
  ('geofences.write',         'geofences',        'write',     'Create and modify geofence boundaries.',                  true),
  ('location.read',           'location',         'read',      'View student location events within scope.',              true),
  ('location.submit',         'location',         'submit',    'Submit one''s own location samples.',                     false),
  ('exit_events.read',        'exit_events',      'read',      'View campus entry and exit events within scope.',         true),
  ('exit_events.authorize',   'exit_events',      'authorize', 'Approve an authorised early exit.',                       true),

  -- Notifications
  ('notifications.read',      'notifications',    'read',      'Read one''s own notifications.',                          false),
  ('notifications.send',      'notifications',    'send',      'Send notifications to other users.',                      true),

  -- Reports and documents
  ('reports.read',            'reports',          'read',      'View generated reports within scope.',                    false),
  ('reports.generate',        'reports',          'generate',  'Generate a report within scope.',                         false),
  ('documents.read',          'documents',        'read',      'View stored documents within scope.',                     false),
  ('documents.generate',      'documents',        'generate',  'Generate a document from a template.',                    false),
  ('templates.manage',        'templates',        'manage',    'Upload and manage document templates.',                   true),

  -- KAREN
  ('karen.use',               'karen',            'use',       'Use the KAREN assistant.',                                false),
  ('karen.write_actions',     'karen',            'write_actions', 'Allow KAREN to perform confirmed write actions.',     true),
  ('knowledge.read',          'knowledge',        'read',      'Search approved knowledge documents.',                    false),
  ('knowledge.manage',        'knowledge',        'manage',    'Upload and manage knowledge documents.',                  true);

-- -----------------------------------------------------------------------------
-- role_permissions — which capabilities each role carries by default.
-- -----------------------------------------------------------------------------
create table public.role_permissions (
  role_id       uuid not null references public.roles (id) on delete cascade,
  permission_id uuid not null references public.permissions (id) on delete cascade,
  granted_at    timestamptz not null default now(),
  primary key (role_id, permission_id)
);

comment on table public.role_permissions is
  'Default capability grants per role. A grant here is necessary but never sufficient: scope is still enforced separately by RLS.';

create index role_permissions_permission_idx on public.role_permissions (permission_id);

create trigger role_permissions_audit
  after insert or delete on public.role_permissions
  for each row execute function cims.audit_row_change();

-- Grant helper, so the seed below reads as intent rather than as joins.
create or replace function cims.grant_permissions(p_role public.role_key, p_keys text[])
returns void
language sql
as $$
  insert into public.role_permissions (role_id, permission_id)
  select r.id, p.id
  from public.roles r
  join public.permissions p on p.key = any (p_keys)
  where r.key = p_role
  on conflict do nothing;
$$;

-- ADMIN — everything. Scope is GLOBAL, but note docs/34: admin access still
-- follows configured permissions, so this is a grant list, not a bypass.
select cims.grant_permissions('ADMIN', array(select key from public.permissions));

-- HOD — department scope.
select cims.grant_permissions('HOD', array[
  'users.read',
  'departments.read', 'courses.read', 'courses.write',
  'subjects.read', 'subjects.write', 'sections.read', 'sections.write',
  'academic_terms.read',
  'students.read', 'students.write', 'faculty.read',
  'timetable.read', 'timetable.write',
  'classrooms.read', 'classrooms.write',
  'attendance.read', 'attendance.override', 'attendance.finalize',
  'class_sessions.read', 'class_sessions.write',
  'geofences.read', 'geofences.write',
  'location.read', 'exit_events.read', 'exit_events.authorize',
  'notifications.read', 'notifications.send',
  'reports.read', 'reports.generate',
  'documents.read', 'documents.generate',
  'karen.use', 'karen.write_actions', 'knowledge.read',
  'audit.read'
]);

-- FACULTY — assigned subjects and sections only.
select cims.grant_permissions('FACULTY', array[
  'departments.read', 'courses.read', 'subjects.read', 'sections.read',
  'academic_terms.read',
  'students.read', 'faculty.read',
  'timetable.read', 'classrooms.read',
  'attendance.read', 'attendance.write', 'attendance.override', 'attendance.finalize',
  'class_sessions.read', 'class_sessions.write',
  'notifications.read',
  'reports.read', 'reports.generate',
  'documents.read', 'documents.generate',
  'karen.use', 'karen.write_actions', 'knowledge.read'
]);

-- MENTOR — assigned mentees.
select cims.grant_permissions('MENTOR', array[
  'departments.read', 'subjects.read', 'sections.read', 'academic_terms.read',
  'students.read', 'timetable.read',
  'attendance.read', 'class_sessions.read',
  'location.read', 'exit_events.read',
  'notifications.read',
  'reports.read', 'reports.generate', 'documents.read', 'documents.generate',
  'karen.use', 'knowledge.read'
]);

-- CLASS_INCHARGE — one section.
select cims.grant_permissions('CLASS_INCHARGE', array[
  'departments.read', 'subjects.read', 'sections.read', 'academic_terms.read',
  'students.read', 'timetable.read',
  'attendance.read', 'attendance.override',
  'class_sessions.read',
  'location.read', 'exit_events.read',
  'notifications.read',
  'reports.read', 'reports.generate', 'documents.read', 'documents.generate',
  'karen.use', 'knowledge.read'
]);

-- STUDENT — own record only. Note: no location.read. A student may submit
-- their own samples but cannot read location history, including their own,
-- through the generic endpoint (docs/05 privacy: minimise collection and access).
select cims.grant_permissions('STUDENT', array[
  'departments.read', 'subjects.read', 'sections.read', 'academic_terms.read',
  'timetable.read',
  'attendance.read',
  'class_sessions.read',
  'location.submit',
  'notifications.read',
  'reports.read', 'reports.generate', 'documents.read', 'documents.generate',
  'karen.use', 'knowledge.read'
]);

alter table public.users            enable row level security;
alter table public.roles            enable row level security;
alter table public.permissions      enable row level security;
alter table public.role_permissions enable row level security;
