-- =============================================================================
-- 20260101001700_early_exit_monitoring
-- Phase 10 — student early-exit monitoring.
--
-- Reuses Phase 8's public.point_in_campus() as the sole authority for campus
-- membership and Phase 9's location_samples as the sole source of student
-- position — no separate/duplicated geospatial or location logic here.
--
-- Same false-positive discipline as Phase 9's attendance engine: a single
-- outside sample never confirms an exit. The presence state machine
-- (docs/05, docs/14):
--   UNKNOWN -> INSIDE -> EXIT_CANDIDATE -> EXIT_VERIFIED/OUTSIDE
--            -> REENTRY_CANDIDATE -> INSIDE
-- requires exit_confirmation_samples corroborating outside-campus samples
-- (default 2, configurable — see presence_config) before EXIT_CANDIDATE
-- becomes EXIT_VERIFIED and an early_exit_events row is created. A student
-- who steps just outside the boundary and back (GPS drift, or briefly at
-- the gate) reverts silently from EXIT_CANDIDATE to INSIDE.
--
-- A general-purpose notifications table is introduced here rather than
-- deferred whole to Phase 11: Phase 10 cannot honestly claim "notify
-- Mentor/Class In-charge/HOD" without a real, persisted notification record
-- to point to. Phase 11 extends this table (Realtime delivery, richer
-- categories, a notifications UI) rather than redesigning it.
-- =============================================================================

create type public.presence_state as enum ('UNKNOWN', 'INSIDE', 'EXIT_CANDIDATE', 'OUTSIDE', 'REENTRY_CANDIDATE');
create type public.exit_verification_state as enum ('EXIT_DETECTED', 'EXIT_CONFIRMED', 'AUTHORIZED_EARLY_EXIT', 'RE_ENTERED');
create type public.authorized_exit_status as enum ('PENDING', 'APPROVED', 'REJECTED');
create type public.notification_type as enum ('EARLY_EXIT', 'ATTENDANCE', 'ADMINISTRATIVE', 'SYSTEM');
create type public.notification_status as enum ('CREATED', 'QUEUED', 'SENT', 'DELIVERED', 'READ', 'FAILED');

-- -----------------------------------------------------------------------------
-- presence_config — single institution-wide row, mirrors attendance_config's
-- own pattern (unique index on `(true)`, not a table constraint — see that
-- migration's comment for why a table-level UNIQUE cannot take an expression).
-- -----------------------------------------------------------------------------
create table public.presence_config (
  id                          uuid primary key default extensions.gen_random_uuid(),
  college_start_time          time not null default '08:00',
  college_end_time            time not null default '16:00',
  exit_confirmation_samples   integer not null default 2,
  reentry_confirmation_samples integer not null default 2,
  updated_by                  uuid references public.users (id) on delete set null,
  updated_at                  timestamptz not null default now(),

  constraint presence_config_positive check (exit_confirmation_samples >= 1 and reentry_confirmation_samples >= 1)
);

create unique index presence_config_single_row_idx on public.presence_config ((true));

insert into public.presence_config default values;

create trigger presence_config_set_updated_at before update on public.presence_config
  for each row execute function cims.set_updated_at();
create trigger presence_config_audit after update on public.presence_config
  for each row execute function cims.audit_row_change();

-- -----------------------------------------------------------------------------
-- student_presence_state — one current-state row per student. Consecutive
-- evaluate_student_presence() calls read and update this row; it is the
-- state machine's memory (how many consecutive outside/inside samples have
-- been seen since the last confirmed transition).
-- -----------------------------------------------------------------------------
create table public.student_presence_state (
  student_id            uuid primary key references public.students (id) on delete cascade,
  state                 public.presence_state not null default 'UNKNOWN',
  consecutive_count     integer not null default 0,
  last_sample_id        uuid references public.location_samples (id) on delete set null,
  state_changed_at      timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create trigger student_presence_state_set_updated_at before update on public.student_presence_state
  for each row execute function cims.set_updated_at();
create trigger student_presence_state_audit after insert or update on public.student_presence_state
  for each row execute function cims.audit_row_change();

-- -----------------------------------------------------------------------------
-- authorized_exits — pre-approved early departures. Checked at
-- EXIT_CONFIRMED time; if one covers the exit, the event is marked
-- AUTHORIZED_EARLY_EXIT and no alert notification is sent.
-- -----------------------------------------------------------------------------
create table public.authorized_exits (
  id                uuid primary key default extensions.gen_random_uuid(),
  student_id        uuid        not null references public.students (id) on delete cascade,
  exit_date         date        not null,
  permitted_exit_time time      not null,
  reason            text        not null,
  approved_by       uuid        references public.users (id) on delete set null,
  status            public.authorized_exit_status not null default 'PENDING',
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint authorized_exits_reason_not_blank check (length(btrim(reason)) > 0),
  constraint authorized_exits_unique_per_day unique (student_id, exit_date)
);

create index authorized_exits_student_idx on public.authorized_exits (student_id, exit_date);

create trigger authorized_exits_set_updated_at before update on public.authorized_exits
  for each row execute function cims.set_updated_at();
create trigger authorized_exits_audit after insert or update on public.authorized_exits
  for each row execute function cims.audit_row_change();

-- -----------------------------------------------------------------------------
-- early_exit_events — one row per confirmed exit episode. Re-entry updates
-- the SAME row (re_entered_at) rather than creating a second one — this,
-- combined with never creating a row before EXIT_CONFIRMED, is what
-- prevents duplicate alerts from repeated outside samples.
-- -----------------------------------------------------------------------------
create table public.early_exit_events (
  id                uuid primary key default extensions.gen_random_uuid(),
  student_id        uuid        not null references public.students (id) on delete cascade,
  exit_confirmed_at timestamptz not null default now(),
  last_known_location extensions.geography(Point, 4326),
  verification_state public.exit_verification_state not null default 'EXIT_CONFIRMED',
  authorized_exit_id uuid        references public.authorized_exits (id) on delete set null,
  re_entered_at     timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

comment on table public.early_exit_events is
  'One row per confirmed exit episode. verification_state = AUTHORIZED_EARLY_EXIT means authorized_exit_id covers it and no alert was sent; otherwise EXIT_CONFIRMED triggered the Mentor/Class In-charge/HOD notification fan-out, and RE_ENTERED once re_entered_at is set.';

create index early_exit_events_student_idx on public.early_exit_events (student_id, exit_confirmed_at desc);
-- "does this student currently have an open (no re-entry) event" — the
-- duplicate-prevention query — is cheap via this partial index.
create index early_exit_events_open_idx on public.early_exit_events (student_id) where re_entered_at is null;

create trigger early_exit_events_set_updated_at before update on public.early_exit_events
  for each row execute function cims.set_updated_at();
create trigger early_exit_events_audit after insert or update on public.early_exit_events
  for each row execute function cims.audit_row_change();

-- -----------------------------------------------------------------------------
-- notifications — general-purpose (Phase 11 extends, does not replace).
-- -----------------------------------------------------------------------------
create table public.notifications (
  id                uuid primary key default extensions.gen_random_uuid(),
  recipient_id      uuid        not null references public.users (id) on delete cascade,
  type              public.notification_type not null,
  title             text        not null,
  message           text        not null,
  related_entity_type text,
  related_entity_id text,
  status            public.notification_status not null default 'CREATED',
  read_at           timestamptz,
  failed_reason     text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index notifications_recipient_idx on public.notifications (recipient_id, created_at desc);
create index notifications_unread_idx on public.notifications (recipient_id) where read_at is null;

create trigger notifications_set_updated_at before update on public.notifications
  for each row execute function cims.set_updated_at();

alter table public.presence_config        enable row level security;
alter table public.student_presence_state enable row level security;
alter table public.authorized_exits       enable row level security;
alter table public.early_exit_events      enable row level security;
alter table public.notifications          enable row level security;
