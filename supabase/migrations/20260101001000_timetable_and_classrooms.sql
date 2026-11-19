-- =============================================================================
-- 20260101001000_timetable_and_classrooms
-- Phase 7 — classrooms (point + radius geofence foundation) and the
-- timetable, with database-enforced conflict prevention.
--
-- docs/06_ATTENDANCE_AND_CLASSROOM_SPEC.md, docs/05_GEOFENCING_SPEC.md
-- =============================================================================

create type public.classroom_type as enum ('CLASSROOM', 'LABORATORY', 'SEMINAR_HALL', 'AUDITORIUM', 'OTHER');
create type public.classroom_status as enum ('ACTIVE', 'INACTIVE', 'MAINTENANCE');
create type public.day_of_week as enum ('MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN');

-- -----------------------------------------------------------------------------
-- classrooms
--
-- `location geography(Point, 4326)` — geography, not geometry: distances need
-- to be real metres on the earth's surface (what ST_DWithin(geography, ...)
-- gives directly), not degrees, which is what geometry would return without a
-- separate projection step. This is exactly what Phase 9's classroom-radius
-- attendance check will call ST_DWithin against; nothing here is provisional.
--
-- The 20m default lives in a column, not application logic — docs/05 and the
-- master prompt are explicit that 20m must be configurable data, never a
-- hard-coded constant baked into the future attendance engine.
-- -----------------------------------------------------------------------------
create table public.classrooms (
  id             uuid primary key default extensions.gen_random_uuid(),
  department_id  uuid        not null references public.departments (id) on delete restrict,
  name           text        not null,          -- 'AI&DS-301'
  block          text,
  floor          text,
  capacity       integer,
  type           public.classroom_type not null default 'CLASSROOM',
  status         public.classroom_status not null default 'ACTIVE',

  location       extensions.geography(Point, 4326),
  radius_m       integer     not null default 20,

  created_by     uuid        references public.users (id) on delete set null,
  updated_by     uuid        references public.users (id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  constraint classrooms_unique_name_per_dept unique (department_id, name),
  constraint classrooms_capacity_sane check (capacity is null or capacity > 0),
  constraint classrooms_radius_sane check (radius_m > 0 and radius_m <= 500)
);

comment on table public.classrooms is
  'A room. location+radius_m is a point-and-radius geofence — the classroom layer of the three-layer geofencing model (docs/05). Distinct from the campus/department polygon geofences arriving in Phase 8; never merge them.';
comment on column public.classrooms.location is
  'geography(Point,4326) so ST_DWithin(location, sample, radius_m) (Phase 9) returns real metres, not degrees.';
comment on column public.classrooms.radius_m is
  'Attendance verification radius in metres. Configurable per classroom; 20 is the default (docs/05), not a constant anywhere in application code.';

create index classrooms_department_idx on public.classrooms (department_id);
create index classrooms_status_idx on public.classrooms (status) where status = 'ACTIVE';
create index classrooms_location_gix on public.classrooms using gist (location);

create trigger classrooms_set_updated_at before update on public.classrooms
  for each row execute function cims.set_updated_at();
create trigger classrooms_audit after insert or update or delete on public.classrooms
  for each row execute function cims.audit_row_change();

-- -----------------------------------------------------------------------------
-- timetable_entries
--
-- Conflict prevention is enforced by the database via EXCLUDE constraints
-- (gist, using btree_gist for the scalar equality terms — enabled in
-- 20260101000100), not application code: two concurrent requests creating the
-- same conflicting entry are serialised by Postgres itself, which is the only
-- way to actually close the race-condition requirement rather than merely
-- reduce its likelihood with a pre-insert SELECT.
--
-- `time_range` is a generated column: `time` has no built-in Postgres range
-- type, so start/end are converted to minutes-since-midnight and expressed as
-- an int4range, which IS usable with EXCLUDE's `&&` (overlap) operator.
-- -----------------------------------------------------------------------------
create table public.timetable_entries (
  id             uuid primary key default extensions.gen_random_uuid(),

  academic_year_id uuid      not null references public.academic_years (id) on delete restrict,
  semester_id    uuid        not null references public.semesters (id) on delete restrict,
  section_id     uuid        not null references public.sections (id) on delete restrict,
  subject_id     uuid        not null references public.subjects (id) on delete restrict,
  faculty_id     uuid        not null references public.faculty (id) on delete restrict,
  classroom_id   uuid        not null references public.classrooms (id) on delete restrict,

  day            public.day_of_week not null,
  start_time     time        not null,
  end_time       time        not null,

  -- CASE guards against int4range() itself raising a raw "range lower bound
  -- must be less than or equal to range upper bound" (22000) for an invalid
  -- end_time <= start_time row, which would fire during tuple construction —
  -- before the named timetable_valid_time CHECK constraint below ever gets a
  -- chance to reject it with a clean, intentional error. NULL here simply
  -- means "this row will fail timetable_valid_time"; the EXCLUDE constraints
  -- never see it, since a NULL range never participates in a GiST overlap.
  time_range     int4range generated always as (
    case when end_time > start_time then
      int4range(
        (extract(hour from start_time)::int * 60 + extract(minute from start_time)::int),
        (extract(hour from end_time)::int * 60 + extract(minute from end_time)::int),
        '[)'
      )
    else null end
  ) stored,

  status         public.entity_status not null default 'ACTIVE',
  created_by     uuid        references public.users (id) on delete set null,
  updated_by     uuid        references public.users (id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  constraint timetable_valid_time check (end_time > start_time),

  -- Faculty cannot be in two places in the same semester at overlapping times.
  constraint timetable_no_faculty_conflict
    exclude using gist (
      faculty_id with =, semester_id with =, day with =, time_range with &&
    ) where (status = 'ACTIVE'),

  -- A section cannot attend two subjects at overlapping times.
  constraint timetable_no_section_conflict
    exclude using gist (
      section_id with =, semester_id with =, day with =, time_range with &&
    ) where (status = 'ACTIVE'),

  -- A classroom cannot host two classes at overlapping times.
  constraint timetable_no_classroom_conflict
    exclude using gist (
      classroom_id with =, semester_id with =, day with =, time_range with &&
    ) where (status = 'ACTIVE')
);

comment on table public.timetable_entries is
  'One weekly recurring slot. Conflict-free by construction: the three EXCLUDE constraints below make a conflicting INSERT/UPDATE fail at the database level, including under concurrent writes — see docs/22 ADR on why this could not be a plain pre-check.';
comment on column public.timetable_entries.time_range is
  'start_time/end_time as minutes-since-midnight, generated so EXCLUDE can use && (int4range has no native "time range" equivalent in Postgres).';

create index timetable_section_idx   on public.timetable_entries (section_id, semester_id) where status = 'ACTIVE';
create index timetable_faculty_idx   on public.timetable_entries (faculty_id, semester_id) where status = 'ACTIVE';
create index timetable_classroom_idx on public.timetable_entries (classroom_id, semester_id) where status = 'ACTIVE';
create index timetable_day_idx       on public.timetable_entries (day);

create trigger timetable_set_updated_at before update on public.timetable_entries
  for each row execute function cims.set_updated_at();
create trigger timetable_audit after insert or update or delete on public.timetable_entries
  for each row execute function cims.audit_row_change();

-- -----------------------------------------------------------------------------
-- Academic-relationship validation the EXCLUDE constraints above cannot
-- express (they only see this table's own columns): a subject must belong to
-- the section's own department, faculty must actually be assigned to teach
-- this subject/section/semester (docs' "must belong to a valid academic
-- configuration"), and the classroom must be ACTIVE.
-- -----------------------------------------------------------------------------
create or replace function cims.validate_timetable_entry()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_section_dept  uuid;
  v_subject_dept  uuid;
  v_classroom_status public.classroom_status;
begin
  select department_id into v_section_dept from public.sections where id = new.section_id;
  select department_id into v_subject_dept from public.subjects where id = new.subject_id;

  if v_section_dept is null then
    raise exception 'Section % does not exist', new.section_id using errcode = '23503';
  end if;
  if v_subject_dept is distinct from v_section_dept then
    raise exception 'Subject does not belong to the same department as the section' using errcode = '23514';
  end if;

  if not exists (
    select 1 from public.faculty_subject_assignments fsa
    where fsa.faculty_id  = new.faculty_id
      and fsa.subject_id  = new.subject_id
      and fsa.section_id  = new.section_id
      and fsa.semester_id = new.semester_id
      and fsa.status = 'ACTIVE'
  ) then
    raise exception 'Faculty is not an active assignment for this subject/section/semester' using errcode = '23514';
  end if;

  select status into v_classroom_status from public.classrooms where id = new.classroom_id;
  if v_classroom_status is distinct from 'ACTIVE' then
    raise exception 'Classroom is not ACTIVE and cannot be assigned to a new timetable entry' using errcode = '23514';
  end if;

  return new;
end;
$$;

create trigger timetable_validate_relationships
  before insert or update on public.timetable_entries
  for each row execute function cims.validate_timetable_entry();

alter table public.classrooms       enable row level security;
alter table public.timetable_entries enable row level security;
