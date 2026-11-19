-- =============================================================================
-- 20260101001400_geofences_geojson_view
-- Phase 8 — plain-GeoJSON reads for the map UI.
--
-- Same reasoning as classrooms' generated latitude/longitude columns
-- (20260101001200): PostgREST returns `geography` as a WKB hex string, which
-- a Leaflet-based editor cannot render directly. `security_invoker = true`
-- means this view enforces geofences_select as the calling role, same as the
-- department_stats/department_hods pattern from Phase 6 — no separate
-- permission logic needed here.
-- =============================================================================

create view public.geofences_geojson
with (security_invoker = true) as
select
  id, type, name, department_id, status, created_by, updated_by, created_at, updated_at,
  extensions.ST_AsGeoJSON(boundary::extensions.geometry) as boundary_geojson
from public.geofences;

comment on view public.geofences_geojson is
  'Read-only GeoJSON projection of public.geofences for map UIs. Writes still go through public.geofences directly (EWKT text in `boundary`).';

grant select on public.geofences_geojson to authenticated;
