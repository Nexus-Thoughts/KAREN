-- =============================================================================
-- 20260101001300_geofences
-- Phase 8 — campus and department/block geofences.
--
-- Three distinct geofence concepts exist in KAREN (docs/05_GEOFENCING_SPEC.md).
-- Classroom geofences (point + 20m radius) already landed in Phase 7
-- (public.classrooms.location/radius_m) and are NOT touched here. This
-- migration adds the other two: CAMPUS (one institution-wide boundary) and
-- DEPARTMENT/BLOCK (department-scoped areas) — both polygons, never merged
-- with the classroom point+radius model.
-- =============================================================================

create type public.geofence_type as enum ('CAMPUS', 'DEPARTMENT', 'BLOCK');

-- -----------------------------------------------------------------------------
-- geofences
--
-- `boundary geography(Polygon, 4326)` — geography, not geometry, so
-- ST_Covers/ST_Intersects work directly against real spherical coordinates
-- without a manual projection step, matching the choice already made for
-- classrooms.location in Phase 7.
-- -----------------------------------------------------------------------------
create table public.geofences (
  id             uuid primary key default extensions.gen_random_uuid(),
  type           public.geofence_type not null,
  name           text        not null,
  -- Required for DEPARTMENT/BLOCK (which department/block this is), forbidden
  -- for CAMPUS (there is exactly one, institution-wide) — enforced below.
  department_id  uuid        references public.departments (id) on delete cascade,
  boundary       extensions.geography(Polygon, 4326) not null,
  status         public.entity_status not null default 'ACTIVE',

  created_by     uuid        references public.users (id) on delete set null,
  updated_by     uuid        references public.users (id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  constraint geofences_department_scope check (
    (type = 'CAMPUS' and department_id is null) or
    (type in ('DEPARTMENT', 'BLOCK') and department_id is not null)
  ),
  -- A polygon needs at least 4 points (3 distinct + closing point) and must
  -- actually be a valid simple polygon — ST_IsValid catches self-intersecting
  -- traces a drawing UI could otherwise produce (docs: "do not automatically
  -- reject unless the business rule requires it" is about capacity/campus
  -- warnings, not about accepting a geometrically broken polygon).
  constraint geofences_boundary_valid check (extensions.ST_IsValid(boundary::extensions.geometry))
);

comment on table public.geofences is
  'CAMPUS and DEPARTMENT/BLOCK polygon geofences. Distinct from public.classrooms (point+radius) — never merge the two models (docs/05).';

-- At most one ACTIVE campus geofence institution-wide.
create unique index geofences_single_active_campus_idx
  on public.geofences ((true)) where (type = 'CAMPUS' and status = 'ACTIVE');

-- At most one ACTIVE DEPARTMENT-type boundary per department (the
-- department's own outline). BLOCK is deliberately not constrained this way
-- — a department may have several named blocks/areas active at once.
create unique index geofences_single_active_department_idx
  on public.geofences (department_id) where (type = 'DEPARTMENT' and status = 'ACTIVE');

create index geofences_department_idx on public.geofences (department_id) where department_id is not null;
create index geofences_type_idx on public.geofences (type);
create index geofences_boundary_gix on public.geofences using gist (boundary);

create trigger geofences_set_updated_at before update on public.geofences
  for each row execute function cims.set_updated_at();
create trigger geofences_audit after insert or update or delete on public.geofences
  for each row execute function cims.audit_row_change();

-- -----------------------------------------------------------------------------
-- Server-side spatial functions. The frontend never decides "am I inside" —
-- it draws a polygon and sends points; these functions are the sole
-- authority a future attendance/early-exit engine (Phases 9-10) will call.
-- -----------------------------------------------------------------------------
create or replace function public.point_in_campus(p_lng double precision, p_lat double precision)
returns boolean
language sql stable
set search_path = public, extensions, pg_temp
as $$
  select exists (
    select 1 from public.geofences g
    where g.type = 'CAMPUS' and g.status = 'ACTIVE'
      and extensions.ST_Covers(g.boundary, extensions.ST_SetSRID(extensions.ST_MakePoint(p_lng, p_lat), 4326)::extensions.geography)
  );
$$;

comment on function public.point_in_campus is
  'Authoritative campus-membership check. Phase 10''s early-exit engine calls this, never a client-side polygon test.';

create or replace function public.point_in_department(p_department_id uuid, p_lng double precision, p_lat double precision)
returns boolean
language sql stable
set search_path = public, extensions, pg_temp
as $$
  select exists (
    select 1 from public.geofences g
    where g.department_id = p_department_id and g.type in ('DEPARTMENT', 'BLOCK') and g.status = 'ACTIVE'
      and extensions.ST_Covers(g.boundary, extensions.ST_SetSRID(extensions.ST_MakePoint(p_lng, p_lat), 4326)::extensions.geography)
  );
$$;

create or replace function public.classroom_distance_m(p_classroom_id uuid, p_lng double precision, p_lat double precision)
returns double precision
language sql stable
set search_path = public, extensions, pg_temp
as $$
  select extensions.ST_Distance(c.location, extensions.ST_SetSRID(extensions.ST_MakePoint(p_lng, p_lat), 4326)::extensions.geography)
  from public.classrooms c
  where c.id = p_classroom_id;
$$;

comment on function public.classroom_distance_m is
  'Real distance in metres from a classroom''s configured point. Phase 9''s 20m verification calls ST_DWithin directly on classrooms.location; this is the read-only convenience form for UI/preview use.';

grant execute on function public.point_in_campus(double precision, double precision) to authenticated;
grant execute on function public.point_in_department(uuid, double precision, double precision) to authenticated;
grant execute on function public.classroom_distance_m(uuid, double precision, double precision) to authenticated;

alter table public.geofences enable row level security;

-- -----------------------------------------------------------------------------
-- RLS.
--
-- Read: any active user — a geofence's shape is not sensitive the way a
-- student's live location sample is (docs/05 privacy section is about
-- location EVENTS, not the boundary definition), and the student-facing app
-- will eventually want to render "you are inside the campus boundary"
-- feedback, which needs the polygon or at least the point-in-* functions
-- (already granted above independent of table RLS).
--
-- Write: geofences.write (ADMIN and HOD hold this per the Phase 4 grants —
-- matches "Admin/HOD-authorised users" in the spec) — but CAMPUS is
-- ADMIN-only regardless: a single department's HOD must not be able to
-- redefine the whole institution's boundary just because they hold
-- geofences.write for their own department's areas.
-- -----------------------------------------------------------------------------
create policy geofences_select on public.geofences
  for select to authenticated
  using (cims.is_active_user());

create policy geofences_write on public.geofences
  for all to authenticated
  using (
    cims.is_active_user() and cims.has_permission('geofences.write')
    and (
      (type = 'CAMPUS' and cims.is_admin())
      or (type in ('DEPARTMENT', 'BLOCK') and (cims.is_admin() or department_id in (select cims.my_department_ids())))
    )
  )
  with check (
    cims.is_active_user() and cims.has_permission('geofences.write')
    and (
      (type = 'CAMPUS' and cims.is_admin())
      or (type in ('DEPARTMENT', 'BLOCK') and (cims.is_admin() or department_id in (select cims.my_department_ids())))
    )
  );
