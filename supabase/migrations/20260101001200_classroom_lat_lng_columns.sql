-- =============================================================================
-- 20260101001200_classroom_lat_lng_columns
-- Phase 7 — plain-number lat/lng reads for the frontend.
--
-- PostgREST returns a `geography` column as a WKB hex string, not GeoJSON or
-- a {lat,lng} pair — genuinely awkward for a React form to consume directly.
-- Writes still go through `location` (accepts EWKT text, e.g.
-- 'SRID=4326;POINT(lng lat)', which Postgres casts automatically); these two
-- generated columns exist purely so ClassroomsPage can read latitude/longitude
-- as plain numbers without a client-side WKB parser.
-- =============================================================================

alter table public.classrooms
  add column latitude  double precision generated always as (extensions.ST_Y(location::extensions.geometry)) stored,
  add column longitude double precision generated always as (extensions.ST_X(location::extensions.geometry)) stored;

comment on column public.classrooms.latitude is
  'Read-only, derived from location. Write coordinates via location (EWKT text), not this column.';
comment on column public.classrooms.longitude is
  'Read-only, derived from location. Write coordinates via location (EWKT text), not this column.';
