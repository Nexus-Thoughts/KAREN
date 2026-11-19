-- =============================================================================
-- 20260101000400_academic_structure
-- Phase 4/5 — the academic entities that RBAC scope is expressed in terms of.
--
-- These tables land with Phase 4 rather than Phase 5 because department and
-- section scope cannot be enforced, or tested, without them. Phase 5 adds the
-- CRUD APIs and UI over them; the shape is fixed here.
--
-- docs/03_DATABASE_SCHEMA.md, docs/04_RBAC_AND_PERMISSIONS.md
-- =============================================================================

create type public.entity_status  as enum ('ACTIVE', 'INACTIVE', 'ARCHIVED');
create type public.student_status as enum ('ACTIVE', 'ALUMNI', 'DROPPED', 'SUSPENDED', 'ON_LEAVE');
create type public.subject_type   as enum ('THEORY', 'PRACTICAL', 'THEORY_PRACTICAL', 'PROJECT', 'ELECTIVE');

-- -----------------------------------------------------------------------------
-- departments
-- -----------------------------------------------------------------------------
create table public.departments (
  id          uuid primary key default extensions.gen_random_uuid(),
  code        text        not null unique,
  name        text        not null,
  status      public.entity_status not null default 'ACTIVE',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  constraint departments_code_shape check (code ~ '^[A-Z0-9&_-]{2,16}$')
);

comment on table public.departments is
  'Academic departments. The primary scope unit for HOD authorisation.';

create trigger departments_set_updated_at before update on public.departments
  for each row execute function cims.set_updated_at();
create trigger departments_audit after insert or update or delete on public.departments
  for each row execute function cims.audit_row_change();

-- -----------------------------------------------------------------------------
-- courses — programmes offered by a department (e.g. B.Tech AI&DS).
-- -----------------------------------------------------------------------------
create table public.courses (
  id            uuid primary key default extensions.gen_random_uuid(),
  department_id uuid        not null references public.departments (id) on delete restrict,
  code          text        not null,
  name          text        not null,
  duration_years smallint   not null,
  status        public.entity_status not null default 'ACTIVE',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint courses_code_unique_per_dept unique (department_id, code),
  constraint courses_duration_sane check (duration_years between 1 and 8)
);

create index courses_department_idx on public.courses (department_id);

create trigger courses_set_updated_at before update on public.courses
  for each row execute function cims.set_updated_at();
create trigger courses_audit after insert or update or delete on public.courses
  for each row execute function cims.audit_row_change();

-- -----------------------------------------------------------------------------
-- academic_years / semesters
-- -----------------------------------------------------------------------------
create table public.academic_years (
  id          uuid primary key default extensions.gen_random_uuid(),
  label       text        not null unique,        -- '2026-2027'
  start_date  date        not null,
  end_date    date        not null,
  is_current  boolean     not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  constraint academic_years_range check (end_date > start_date)
);

-- At most one current academic year, enforced in the database rather than by
-- application convention.
create unique index academic_years_single_current_idx
  on public.academic_years ((true)) where is_current;

create table public.semesters (
  id                uuid primary key default extensions.gen_random_uuid(),
  academic_year_id  uuid        not null references public.academic_years (id) on delete cascade,
  number            smallint    not null,
  label             text        not null,
  start_date        date        not null,
  end_date          date        not null,
  is_current        boolean     not null default false,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint semesters_number_range check (number between 1 and 16),
  constraint semesters_unique_per_year unique (academic_year_id, number),
  constraint semesters_range check (end_date > start_date)
);

create unique index semesters_single_current_idx
  on public.semesters ((true)) where is_current;

create index semesters_academic_year_idx on public.semesters (academic_year_id);

create trigger academic_years_set_updated_at before update on public.academic_years
  for each row execute function cims.set_updated_at();
create trigger semesters_set_updated_at before update on public.semesters
  for each row execute function cims.set_updated_at();
create trigger academic_years_audit after insert or update or delete on public.academic_years
  for each row execute function cims.audit_row_change();
create trigger semesters_audit after insert or update or delete on public.semesters
  for each row execute function cims.audit_row_change();

-- -----------------------------------------------------------------------------
-- sections — a teachable cohort, e.g. III-A of B.Tech AI&DS.
-- -----------------------------------------------------------------------------
create table public.sections (
  id                uuid primary key default extensions.gen_random_uuid(),
  department_id     uuid        not null references public.departments (id) on delete restrict,
  course_id         uuid        not null references public.courses (id) on delete restrict,
  academic_year_id  uuid        not null references public.academic_years (id) on delete restrict,
  name              text        not null,          -- 'A'
  year              smallint    not null,          -- study year, 1..8
  current_semester_id uuid      references public.semesters (id) on delete set null,
  batch             text,                          -- '2023-2027'
  -- Denormalised roster size, maintained by trigger. The live attendance screen
  -- needs "expected count" on every session poll; recounting the roster there
  -- would be a per-poll aggregate over the whole enrolment table.
  student_count     integer     not null default 0,
  status            public.entity_status not null default 'ACTIVE',
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint sections_unique unique (course_id, academic_year_id, year, name),
  constraint sections_year_range check (year between 1 and 8),
  constraint sections_count_non_negative check (student_count >= 0)
);

comment on table public.sections is
  'A cohort. The scope unit for CLASS_INCHARGE authorisation.';
comment on column public.sections.student_count is
  'Denormalised active roster size, maintained by trigger on students. Read by the live attendance screen as the expected count.';

create index sections_department_idx on public.sections (department_id);
create index sections_course_idx     on public.sections (course_id);
create index sections_year_idx       on public.sections (academic_year_id);

create trigger sections_set_updated_at before update on public.sections
  for each row execute function cims.set_updated_at();
create trigger sections_audit after insert or update or delete on public.sections
  for each row execute function cims.audit_row_change();

-- -----------------------------------------------------------------------------
-- faculty
-- -----------------------------------------------------------------------------
create table public.faculty (
  id            uuid primary key default extensions.gen_random_uuid(),
  user_id       uuid        not null unique references public.users (id) on delete restrict,
  department_id uuid        not null references public.departments (id) on delete restrict,
  employee_id   text        not null unique,
  designation   text        not null,
  joined_on     date,
  status        public.entity_status not null default 'ACTIVE',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

comment on table public.faculty is
  'Faculty record. user_id links to the authenticated principal; department_id is the home department, which is NOT by itself an authorisation scope — teaching reach comes from faculty_subject_assignments.';

create index faculty_department_idx on public.faculty (department_id);
create index faculty_status_idx     on public.faculty (status) where status = 'ACTIVE';

create trigger faculty_set_updated_at before update on public.faculty
  for each row execute function cims.set_updated_at();
create trigger faculty_audit after insert or update or delete on public.faculty
  for each row execute function cims.audit_row_change();

-- -----------------------------------------------------------------------------
-- students
-- -----------------------------------------------------------------------------
create table public.students (
  id                uuid primary key default extensions.gen_random_uuid(),
  user_id           uuid        unique references public.users (id) on delete restrict,
  department_id     uuid        not null references public.departments (id) on delete restrict,
  course_id         uuid        not null references public.courses (id) on delete restrict,
  section_id        uuid        references public.sections (id) on delete set null,
  academic_year_id  uuid        not null references public.academic_years (id) on delete restrict,
  current_semester_id uuid      references public.semesters (id) on delete set null,

  register_number   text        not null unique,
  roll_number       text,
  year              smallint    not null,
  batch             text,

  -- Contact details. Personal data; readable only within scope (docs/13).
  contact_email     extensions.citext,
  contact_phone     text,
  guardian_name     text,
  guardian_phone    text,

  -- Pastoral assignments. Denormalised onto the student because the early-exit
  -- notification fan-out (docs/07) must resolve Mentor + Class In-charge + HOD
  -- on a hot path, and because they are genuine attributes of the student.
  mentor_id         uuid        references public.faculty (id) on delete set null,
  class_incharge_id uuid        references public.faculty (id) on delete set null,

  status            public.student_status not null default 'ACTIVE',
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint students_year_range check (year between 1 and 8),
  constraint students_register_shape check (length(btrim(register_number)) between 3 and 32),
  constraint students_phone_shape check (contact_phone is null or contact_phone ~ '^[0-9+][0-9 ()-]{5,19}$')
);

comment on table public.students is
  'Student record. user_id is nullable so a student can be enrolled by an administrator before their login is provisioned.';
comment on column public.students.mentor_id is
  'Assigned mentor. Drives MENTOR scope and the early-exit notification chain.';

create index students_section_idx    on public.students (section_id);
create index students_department_idx on public.students (department_id);
create index students_mentor_idx     on public.students (mentor_id)         where mentor_id is not null;
create index students_incharge_idx   on public.students (class_incharge_id) where class_incharge_id is not null;
create index students_user_idx       on public.students (user_id)           where user_id is not null;
create index students_status_idx     on public.students (status)            where status = 'ACTIVE';
create index students_register_trgm_idx on public.students using gin (register_number extensions.gin_trgm_ops);

create trigger students_set_updated_at before update on public.students
  for each row execute function cims.set_updated_at();
create trigger students_audit after insert or update or delete on public.students
  for each row execute function cims.audit_row_change();

-- Keep sections.student_count truthful.
create or replace function cims.sync_section_student_count()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op in ('UPDATE', 'DELETE') and old.section_id is not null then
    update public.sections s
    set student_count = (
      select count(*) from public.students
      where section_id = old.section_id and status = 'ACTIVE'
    )
    where s.id = old.section_id;
  end if;

  if tg_op in ('INSERT', 'UPDATE') and new.section_id is not null then
    update public.sections s
    set student_count = (
      select count(*) from public.students
      where section_id = new.section_id and status = 'ACTIVE'
    )
    where s.id = new.section_id;
  end if;

  return null;
end;
$$;

create trigger students_sync_section_count
  after insert or update of section_id, status or delete on public.students
  for each row execute function cims.sync_section_student_count();

-- -----------------------------------------------------------------------------
-- subjects
-- -----------------------------------------------------------------------------
create table public.subjects (
  id            uuid primary key default extensions.gen_random_uuid(),
  department_id uuid        not null references public.departments (id) on delete restrict,
  course_id     uuid        references public.courses (id) on delete set null,
  code          text        not null,
  name          text        not null,
  credits       numeric(3,1) not null default 3,
  semester_number smallint  not null,
  type          public.subject_type not null default 'THEORY',
  status        public.entity_status not null default 'ACTIVE',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint subjects_code_unique unique (department_id, code),
  constraint subjects_credits_range check (credits >= 0 and credits <= 20),
  constraint subjects_semester_range check (semester_number between 1 and 16)
);

create index subjects_department_idx on public.subjects (department_id);
create index subjects_course_idx     on public.subjects (course_id);

create trigger subjects_set_updated_at before update on public.subjects
  for each row execute function cims.set_updated_at();
create trigger subjects_audit after insert or update or delete on public.subjects
  for each row execute function cims.audit_row_change();

-- -----------------------------------------------------------------------------
-- faculty_subject_assignments — the authorisation edge for FACULTY.
--
-- This table, not faculty.department_id, is what "assigned scope" means in
-- docs/04. A faculty member reaches exactly the sections they are assigned to
-- teach, which is how a faculty member can legitimately teach into another
-- department without gaining that department's data.
-- -----------------------------------------------------------------------------
create table public.faculty_subject_assignments (
  id            uuid primary key default extensions.gen_random_uuid(),
  faculty_id    uuid        not null references public.faculty (id) on delete cascade,
  subject_id    uuid        not null references public.subjects (id) on delete cascade,
  section_id    uuid        not null references public.sections (id) on delete cascade,
  semester_id   uuid        not null references public.semesters (id) on delete cascade,
  status        public.entity_status not null default 'ACTIVE',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint faculty_assignment_unique unique (faculty_id, subject_id, section_id, semester_id)
);

comment on table public.faculty_subject_assignments is
  'The authorisation edge for FACULTY scope: (faculty, subject, section, semester).';

create index fsa_faculty_idx  on public.faculty_subject_assignments (faculty_id) where status = 'ACTIVE';
create index fsa_section_idx  on public.faculty_subject_assignments (section_id);
create index fsa_subject_idx  on public.faculty_subject_assignments (subject_id);
create index fsa_semester_idx on public.faculty_subject_assignments (semester_id);

create trigger fsa_set_updated_at before update on public.faculty_subject_assignments
  for each row execute function cims.set_updated_at();
create trigger fsa_audit after insert or update or delete on public.faculty_subject_assignments
  for each row execute function cims.audit_row_change();

-- -----------------------------------------------------------------------------
-- student_subject_enrolments — which students take which subject.
--
-- Not derivable from section alone, because electives cut across sections.
-- -----------------------------------------------------------------------------
create table public.student_subject_enrolments (
  id          uuid primary key default extensions.gen_random_uuid(),
  student_id  uuid        not null references public.students (id) on delete cascade,
  subject_id  uuid        not null references public.subjects (id) on delete cascade,
  semester_id uuid        not null references public.semesters (id) on delete cascade,
  status      public.entity_status not null default 'ACTIVE',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  constraint enrolment_unique unique (student_id, subject_id, semester_id)
);

create index sse_student_idx  on public.student_subject_enrolments (student_id);
create index sse_subject_idx  on public.student_subject_enrolments (subject_id, semester_id);

create trigger sse_set_updated_at before update on public.student_subject_enrolments
  for each row execute function cims.set_updated_at();
create trigger sse_audit after insert or update or delete on public.student_subject_enrolments
  for each row execute function cims.audit_row_change();

alter table public.departments                 enable row level security;
alter table public.courses                     enable row level security;
alter table public.academic_years              enable row level security;
alter table public.semesters                   enable row level security;
alter table public.sections                    enable row level security;
alter table public.faculty                     enable row level security;
alter table public.students                    enable row level security;
alter table public.subjects                    enable row level security;
alter table public.faculty_subject_assignments enable row level security;
alter table public.student_subject_enrolments  enable row level security;
