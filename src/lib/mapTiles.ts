/**
 * Shared OpenStreetMap tile/geocoding configuration for every Leaflet map in
 * CIMS (GeofenceMapEditor, ClassroomMapPicker) — per the explicit product
 * requirement: "Use: OpenStreetMap + Leaflet... Do not use Google Maps."
 *
 * Both `TILE_URL`/`TILE_ATTRIBUTION` and `geocodeSearch` are intentionally
 * centralised here (not hard-coded per component) so a real deployment can
 * swap in a self-hosted tile server / geocoder later by editing one file —
 * "keep it configurable" from the spec, without needing a frontend API key
 * for the default OSM path (Nominatim's public endpoint needs none).
 *
 * OSM's public tile server and the public Nominatim instance both have
 * published usage policies (low-volume, attributed, no heavy automated use)
 * — fine for normal admin/HOD map interaction, but a real institutional
 * rollout with many concurrent geofence-editors should eventually point
 * TILE_URL / geocodeSearch's endpoint at a paid or self-hosted equivalent.
 * That swap does not touch any component using these exports.
 */

export const TILE_URL = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
export const TILE_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

export interface GeocodeResult {
  label: string;
  lat: number;
  lng: number;
  /** [south, west, north, east] — used to fit the map to the found place rather than just centering on a point. */
  boundingBox: [number, number, number, number] | null;
}

/**
 * Free-text place search via the public Nominatim API — "search by college
 * name / address/location" from the spec. No API key required or accepted;
 * do not add one here (frontend code, would be exposed).
 */
export async function geocodeSearch(query: string, signal?: AbortSignal): Promise<GeocodeResult[]> {
  const trimmed = query.trim();
  if (trimmed.length < 3) return [];

  const url = new URL('https://nominatim.openstreetmap.org/search');
  url.searchParams.set('q', trimmed);
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('limit', '5');

  const res = await fetch(url.toString(), { signal, headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Location search failed (${res.status}).`);

  const data = (await res.json()) as Array<{
    display_name: string;
    lat: string;
    lon: string;
    boundingbox: [string, string, string, string];
  }>;

  return data.map((r) => ({
    label: r.display_name,
    lat: Number(r.lat),
    lng: Number(r.lon),
    boundingBox: r.boundingbox
      ? [Number(r.boundingbox[0]), Number(r.boundingbox[2]), Number(r.boundingbox[1]), Number(r.boundingbox[3])]
      : null,
  }));
}
