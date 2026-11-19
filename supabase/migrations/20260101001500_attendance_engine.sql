-- =============================================================================
-- 20260101001500_attendance_engine
-- Phase 9 — enhanced automatic attendance.
--
-- Core rule, enforced structurally, not just by convention (docs/06,
-- master prompt §61): CAMPUS PRESENCE != CLASSROOM PRESENCE != ATTENDANCE.
-- There is no code path anywhere in this migration that marks a student
-- PRESENT purely because a sample landed inside the campus polygon — every
-- PRESENT/LATE transition requires an active class_session AND a location
-- sample within the configured classroom radius AND (docs: "do not
-- immediately mark someone absent/present from a single sample")
-- attendance_config.min_confirmations_required corroborating samples.
--
-- No live scheduler exists in this environment to invoke
-- evaluate_class_session() every minute — that is an Edge
-- Function/cron responsibility for a real deployment (documented in
-- docs/22 ADR-014). What is built here is the complete, real evaluation
-- logic a scheduler would call, exercised directly by pgTAP rather than by
-- a fake timer.
-- =============================================================================

create type public.class_session_status as enum ('SCHEDULED', 'OPEN', 'VERIFICATION', 'ATTENDANCE_OPEN', 'CLOSED');

create type public.attendance_status as enum (
  'PENDING', 'DETECTED', 'VERIFYING', 'PRESENT', 'LATE', 'ABSENT',
  'OUTSIDE_CAMPUS', 'OUTSIDE_CLASSROOM', 'LOW_GPS_ACCURACY',
  'MANUAL_PRESENT', 'MANUAL_ABSENT'
);

-- -----------------------------------------------------------------------------
-- attendance_config — a single institution-wide row. Every threshold the
-- engine uses is read from here, never hard-coded (docs: "20m default,
-- configurable data" — the same principle extends to every other constant
-- in this subsystem: grace period, late window, accuracy threshold,
-- confirmation count).
-- -----------------------------------------------------------------------------
create table public.attendance_config (
  id                            uuid primary key default extensions.gen_random_uuid(),
  grace_period_minutes          integer not null default 5,
  late_window_minutes           integer not null default 10,
  attendance_window_after_minutes integer not null default 15, -- how long past scheduled_end the window stays open for late detection
  location_accuracy_threshold_m integer not null default 30,
  min_confirmations_required    integer not null default 2,
  updated_by                    uuid references public.users (id) on delete set null,
  updated_at                    timestamptz not null default now(),

  constraint attendance_config_positive check (
    grace_period_minutes >= 0 and late_window_minutes >= 0 and attendance_window_after_minutes >= 0
    and location_accuracy_threshold_m > 0 and min_confirmations_required >= 1
  )
);

-- A table-level UNIQUE constraint can only reference columns, not an
-- expression like `(true)` — that needs a real unique index, which does
-- support expressions.
create unique index attendance_config_single_row_idx on public.attendance_config ((true));

comment on table public.attendance_config is
  'Single-row institution-wide attendance thresholds. attendance_config_single_row_idx enforces there is ever only one row.';

insert into public.attendance_config default values;

create trigger attendance_config_set_updated_at before update on public.attendance_config
  for each row execute function cims.set_updated_at();
create trigger attendance_config_audit after update on public.attendance_config
  for each row execute function cims.audit_row_change();

-- -----------------------------------------------------------------------------
-- location_samples — raw GPS samples. Sensitive (docs/05 privacy: minimise
-- collection, restrict access, audit privileged access) — RLS below is
-- deliberately tighter than most tables in this schema.
-- -----------------------------------------------------------------------------
create table public.location_samples (
  id            uuid primary key default extensions.gen_random_uuid(),
  student_id    uuid        not null references public.students (id) on delete cascade,
  location      extensions.geography(Point, 4326) not null,
  accuracy_m    double precision,
  -- clock_timestamp(), NOT now()/transaction_timestamp(): now() is frozen
  -- for the entire duration of a transaction, so several samples inserted
  -- in quick succession within one transaction (or even a single verbose
  -- batch write) would otherwise receive an IDENTICAL recorded_at, making
  -- cims.evaluate_class_session()'s "most recent sample" ORDER BY
  -- non-deterministic. Found by pgTAP: two same-transaction submit_location
  -- calls tied on recorded_at and the engine picked the earlier, out-of-range
  -- sample instead of the later, in-range one.
  recorded_at   timestamptz not null default clock_timestamp(),
  source        text        not null default 'gps'
);

comment on table public.location_samples is
  'Raw student GPS samples. Sensitive — see docs/05 privacy section. Never read directly by KAREN or exposed in reports; only aggregated attendance_records status is.';

create index location_samples_student_time_idx on public.location_samples (student_id, recorded_at desc);
create index location_samples_location_gix on public.location_samples using gist (location);

alter table public.location_samples enable row level security;

create policy location_samples_insert_self on public.location_samples
  for insert to authenticated
  with check (
    cims.is_active_user() and cims.has_permission('location.submit')
    and student_id = cims.my_student_id()
  );

-- Read: the student's own samples, or a privileged staff role (HOD/MENTOR/
-- CLASS_INCHARGE hold location.read per Phase 4's grants; FACULTY does not —
-- a faculty member sees evaluated attendance status, not raw location).
create policy location_samples_select on public.location_samples
  for select to authenticated
  using (
    cims.is_active_user()
    and (
      student_id = cims.my_student_id()
      or (cims.has_permission('location.read') and student_id in (select cims.my_student_ids()))
    )
  );

-- -----------------------------------------------------------------------------
-- class_sessions — one activation of a timetable_entry on a specific date.
-- -----------------------------------------------------------------------------
create table public.class_sessions (
  id                    uuid primary key default extensions.gen_random_uuid(),
  timetable_entry_id    uuid        not null references public.timetable_entries (id) on delete restrict,
  section_id            uuid        not null references public.sections (id) on delete restrict,
  subject_id            uuid        not null references public.subjects (id) on delete restrict,
  faculty_id            uuid        not null references public.faculty (id) on delete restrict,
  classroom_id          uuid        not null references public.classrooms (id) on delete restrict,
  semester_id           uuid        not null references public.semesters (id) on delete restrict,

  session_date          date        not null,
  scheduled_start        timestamptz not null,
  scheduled_end          timestamptz not null,
  attendance_window_start timestamptz not null,
  attendance_window_end   timestamptz not null,

  status                public.class_session_status not null default 'SCHEDULED',
  finalized_at          timestamptz,
  finalized_by          uuid        references public.users (id) on delete set null,

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  constraint class_sessions_unique_per_day unique (timetable_entry_id, session_date)
);

comment on table public.class_sessions is
  'One activation of a timetable_entry on one date. Idempotently created by cims.get_or_create_class_session().';

create index class_sessions_section_idx  on public.class_sessions (section_id, session_date);
create index class_sessions_faculty_idx  on public.class_sessions (faculty_id, session_date);
create index class_sessions_status_idx   on public.class_sessions (status) where status <> 'CLOSED';

create trigger class_sessions_set_updated_at before update on public.class_sessions
  for each row execute function cims.set_updated_at();
create trigger class_sessions_audit after insert or update on public.class_sessions
  for each row execute function cims.audit_row_change();

-- -----------------------------------------------------------------------------
-- attendance_records — one per (class_session, eligible student).
-- -----------------------------------------------------------------------------
create table public.attendance_records (
  id                uuid primary key default extensions.gen_random_uuid(),
  class_session_id  uuid        not null references public.class_sessions (id) on delete cascade,
  student_id        uuid        not null references public.students (id) on delete cascade,

  status            public.attendance_status not null default 'PENDING',
  sample_count      integer     not null default 0,
  distance_m        double precision,
  accuracy_m        double precision,
  first_detected_at timestamptz,
  verified_at       timestamptz,

  is_manual         boolean     not null default false,
  override_reason   text,
  overridden_by     uuid        references public.users (id) on delete set null,
  overridden_at     timestamptz,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint attendance_records_unique unique (class_session_id, student_id),
  constraint attendance_records_manual_needs_reason check (
    not is_manual or (override_reason is not null and length(btrim(override_reason)) > 0)
  )
);

comment on table public.attendance_records is
  'Per-student attendance for one class_session. status transitions are driven by cims.evaluate_class_session() (automatic) or public.override_attendance() (manual, audited, reason required).';

create index attendance_records_session_idx on public.attendance_records (class_session_id);
create index attendance_records_student_idx on public.attendance_records (student_id);

create trigger attendance_records_set_updated_at before update on public.attendance_records
  for each row execute function cims.set_updated_at();
create trigger attendance_records_audit after insert or update on public.attendance_records
  for each row execute function cims.audit_row_change();

alter table public.class_sessions      enable row level security;
alter table public.attendance_records  enable row level security;
alter table public.attendance_config   enable row level security;
