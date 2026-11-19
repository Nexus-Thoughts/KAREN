-- =============================================================================
-- 006_phase8_geofences.test.sql
--
-- Covers supabase/migrations/20260101001300_geofences.sql: point-in-polygon
-- functions, invalid polygon rejection, single-active-campus uniqueness,
-- and write-scope RLS (CAMPUS admin-only, DEPARTMENT/BLOCK department-scoped).
--
-- Test polygon is a ~222m square centred on Null Island (0,0) — synthetic,
-- per docs/00 blocker #3 (no real campus coordinates exist yet):
-- POLYGON((-0.001 -0.001, 0.001 -0.001, 0.001 0.001, -0.001 0.001, -0.001 -0.001))
-- =============================================================================

begin;

do $$
begin
  create extension if not exists pgtap with schema extensions;
exception when duplicate_object then
  null;
end;
$$;

select plan(13);

create schema if not exists tests;
grant usage on schema tests to anon, authenticated;

create or replace function tests.simulate_user(p_user_id uuid)
returns void
language sql
as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_user_id, 'role', 'authenticated')::text, true);
  select set_config('role', 'authenticated', true);
$$;

grant execute on function tests.simulate_user(uuid) to anon, authenticated;

-- =============================================================================
-- 1. Campus geofence CRUD — admin only.
-- =============================================================================
select tests.simulate_user('10000000-0000-0000-0000-000000000001'); -- admin

select lives_ok(
  $$ insert into public.geofences (id, type, name, boundary)
     values ('40000000-0000-0000-0000-000000000001', 'CAMPUS', 'Main Campus',
             'SRID=4326;POLYGON((-0.001 -0.001, 0.001 -0.001, 0.001 0.001, -0.001 0.001, -0.001 -0.001))') $$,
  'admin can create the campus geofence'
);

select tests.simulate_user('10000000-0000-0000-0000-000000000002'); -- hod.cs
select throws_ok(
  $$ insert into public.geofences (type, name, boundary)
     values ('CAMPUS', 'Rogue Campus Redefinition',
             'SRID=4326;POLYGON((-0.002 -0.002, 0.002 -0.002, 0.002 0.002, -0.002 0.002, -0.002 -0.002))') $$,
  '42501',
  null,
  'HOD cannot create/redefine the CAMPUS geofence even though they hold geofences.write'
);

-- -----------------------------------------------------------------------------
-- 2. Single active campus geofence institution-wide.
-- -----------------------------------------------------------------------------
select tests.simulate_user('10000000-0000-0000-0000-000000000001'); -- admin
select throws_ok(
  $$ insert into public.geofences (type, name, boundary)
     values ('CAMPUS', 'Second Campus',
             'SRID=4326;POLYGON((-0.003 -0.003, 0.003 -0.003, 0.003 0.003, -0.003 0.003, -0.003 -0.003))') $$,
  '23505',
  null,
  'only one ACTIVE campus geofence may exist institution-wide'
);

-- -----------------------------------------------------------------------------
-- 3. Invalid (self-intersecting, bowtie) polygon is rejected.
-- -----------------------------------------------------------------------------
select throws_ok(
  $$ insert into public.geofences (type, name, department_id, boundary)
     values ('BLOCK', 'Bowtie', '20000000-0000-0000-0000-000000000001',
             'SRID=4326;POLYGON((0 0, 1 1, 1 0, 0 1, 0 0))') $$,
  '23514',
  null,
  'a self-intersecting polygon is rejected'
);

-- -----------------------------------------------------------------------------
-- 4. DEPARTMENT/BLOCK requires department_id; CAMPUS forbids it.
-- -----------------------------------------------------------------------------
select throws_ok(
  $$ insert into public.geofences (type, name, boundary)
     values ('BLOCK', 'No Department', 'SRID=4326;POLYGON((0 0, 1 0, 1 1, 0 1, 0 0))') $$,
  '23514',
  null,
  'BLOCK/DEPARTMENT geofences require a department_id'
);

select throws_ok(
  $$ insert into public.geofences (type, name, department_id, boundary)
     values ('CAMPUS', 'Campus With Dept', '20000000-0000-0000-0000-000000000001',
             'SRID=4326;POLYGON((0 0, 1 0, 1 1, 0 1, 0 0))') $$,
  '23514',
  null,
  'CAMPUS geofences must not carry a department_id'
);

-- =============================================================================
-- 5. Department/Block write scope: HOD of CS can create in their own
--    department, not in AI&DS.
-- =============================================================================
select tests.simulate_user('10000000-0000-0000-0000-000000000002'); -- hod.cs

select lives_ok(
  $$ insert into public.geofences (id, type, name, department_id, boundary)
     values ('40000000-0000-0000-0000-000000000002', 'BLOCK', 'CS Main Block', '20000000-0000-0000-0000-000000000001',
             'SRID=4326;POLYGON((-0.0005 -0.0005, 0.0005 -0.0005, 0.0005 0.0005, -0.0005 0.0005, -0.0005 -0.0005))') $$,
  'HOD of CS can create a BLOCK geofence in their own department'
);

select throws_ok(
  $$ insert into public.geofences (type, name, department_id, boundary)
     values ('BLOCK', 'AIDS Block', '20000000-0000-0000-0000-000000000002',
             'SRID=4326;POLYGON((0 0, 1 0, 1 1, 0 1, 0 0))') $$,
  '42501',
  null,
  'HOD of CS cannot create a geofence for AI&DS'
);

-- =============================================================================
-- 6. Point-in-polygon functions — authoritative, server-side.
-- =============================================================================

-- Centre of the campus square: clearly inside.
select ok(
  public.point_in_campus(0, 0),
  '(0,0) is inside the campus polygon'
);

-- Far outside.
select ok(
  not public.point_in_campus(1, 1),
  '(1,1) is outside the campus polygon'
);

-- On the boundary (a vertex) — ST_Covers is boundary-inclusive, unlike
-- ST_Contains, which is the correct choice for "is this GPS sample on campus":
-- a sample landing exactly on the fence line should count as on campus, not
-- fall through a gap between Covers/Contains semantics.
select ok(
  public.point_in_campus(-0.001, -0.001),
  'a point exactly on the campus boundary counts as inside (ST_Covers, not ST_Contains)'
);

-- Department/block check against the CS block created above.
select ok(
  public.point_in_department('20000000-0000-0000-0000-000000000001', 0, 0),
  'point_in_department resolves true for a point inside the CS block'
);

select ok(
  not public.point_in_department('20000000-0000-0000-0000-000000000002', 0, 0),
  'point_in_department resolves false for AI&DS, which has no geofence covering (0,0)'
);

select * from finish();
rollback;
