/**
 * Polygon drawing/editing map for campus and department/block geofences
 * (Phase 8). Point+radius classrooms (Phase 7) use ClassroomMapPicker
 * instead — the two are deliberately separate components because they are
 * different geofence models (docs/05), not a shared "location picker".
 *
 * Built on plain Leaflet + leaflet-draw, extending the same
 * no-react-leaflet foundation ClassroomMapPicker established in Phase 7
 * (ADR-012 — react-leaflet's stable major only supports React 18 as a peer;
 * this project is on React 19). leaflet-draw itself has no React binding to
 * conflict with; it patches the global `L` the same way any Leaflet plugin
 * does, which is exactly why ADR-012 predicted it would layer cleanly onto
 * the existing plain-Leaflet setup.
 *
 * The user traces the boundary visually — "do not require manual polygon
 * coordinate entry" — and this emits/accepts GeoJSON, converted to/from the
 * EWKT text GeofencingPage sends to Supabase.
 *
 * Also carries the "find the college first" step from the product spec:
 * a Nominatim place search plus a "use my current location" control, so an
 * Admin/HOD never needs to know — or manually enter — a latitude/longitude
 * before they can start tracing a boundary. Base tiles default to the
 * public OSM tile server (src/lib/mapTiles.ts) unless a deployment overrides
 * `tileUrl`/`attribution`.
 */
import React, { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import 'leaflet-draw';
import 'leaflet-draw/dist/leaflet.draw.css';
import { Search, LocateFixed, Loader2 } from 'lucide-react';
import { TILE_URL, TILE_ATTRIBUTION, geocodeSearch, type GeocodeResult } from '@/lib/mapTiles';

export interface GeofenceInfo {
  status: string;
  updatedAt: string | null;
  updatedByName: string | null;
}

export interface GeofenceMapEditorProps {
  /** [lng, lat][] ring, closed or not (Leaflet closes it automatically). Null = no polygon yet. */
  polygon: [number, number][] | null;
  onChange: (polygon: [number, number][]) => void;
  tileUrl?: string;
  attribution?: string;
  color?: string;
  /** "Current geofence information" panel from the spec — omitted for a brand-new (unsaved) geofence. */
  info?: GeofenceInfo;
}

const FALLBACK_CENTER: [number, number] = [20.5937, 78.9629]; // India, wide zoom — a neutral starting point, not a real campus (docs/00 blocker #3).

const GeofenceMapEditor: React.FC<GeofenceMapEditorProps> = ({
  polygon,
  onChange,
  tileUrl = TILE_URL,
  attribution = TILE_ATTRIBUTION,
  color = '#2F5BFF',
  info,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const drawnItemsRef = useRef<L.FeatureGroup | null>(null);

  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<GeocodeResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [locating, setLocating] = useState(false);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const center = polygon && polygon.length > 0
      ? ([polygon[0]![1], polygon[0]![0]] as [number, number])
      : FALLBACK_CENTER;

    const map = L.map(containerRef.current, { center, zoom: polygon ? 17 : 5 });
    L.tileLayer(tileUrl, { attribution, maxZoom: 19 }).addTo(map);

    const drawnItems = new L.FeatureGroup();
    map.addLayer(drawnItems);
    drawnItemsRef.current = drawnItems;

    if (polygon && polygon.length > 0) {
      const latLngs = polygon.map(([lng, lat]) => [lat, lng] as [number, number]);
      const layer = L.polygon(latLngs, { color });
      drawnItems.addLayer(layer);
      map.fitBounds(layer.getBounds(), { maxZoom: 18 });
    }

    // Only one polygon per geofence — drawing a new one replaces the old.
    // "Edit polygon / delete polygon / save / cancel" from the spec map onto
    // leaflet-draw's own edit/remove toolbar controls; this wires the result
    // of any of them back to onChange as a single source of truth.
    const drawControl = new L.Control.Draw({
      draw: {
        polygon: { showArea: false, shapeOptions: { color } },
        polyline: false, rectangle: false, circle: false, circlemarker: false, marker: false,
      },
      edit: { featureGroup: drawnItems, remove: true },
    });
    map.addControl(drawControl);

    const emitCurrentPolygon = () => {
      const layers = drawnItems.getLayers();
      const first = layers[0] as L.Polygon | undefined;
      if (!first) return;
      const latLngs = (first.getLatLngs()[0] as L.LatLng[]).map((ll) => [ll.lng, ll.lat] as [number, number]);
      onChange(latLngs);
    };

    map.on(L.Draw.Event.CREATED, (e: L.LeafletEvent) => {
      drawnItems.clearLayers(); // one polygon per geofence
      drawnItems.addLayer((e as L.DrawEvents.Created).layer);
      emitCurrentPolygon();
    });
    map.on(L.Draw.Event.EDITED, emitCurrentPolygon);
    map.on(L.Draw.Event.DELETED, () => onChange([]));

    mapRef.current = map;

    return () => {
      map.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const flyTo = (lat: number, lng: number, boundingBox: GeocodeResult['boundingBox']) => {
    const map = mapRef.current;
    if (!map) return;
    if (boundingBox) {
      const [south, west, north, east] = boundingBox;
      map.fitBounds([[south, west], [north, east]], { maxZoom: 18 });
    } else {
      map.setView([lat, lng], 17);
    }
  };

  const runSearch = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (searchQuery.trim().length < 3) {
      setSearchError('Type at least 3 characters — e.g. the college name or its city.');
      return;
    }
    setSearching(true);
    setSearchError(null);
    try {
      const results = await geocodeSearch(searchQuery);
      setSearchResults(results);
      if (results.length === 0) setSearchError('No matching location found. Try a more specific search.');
    } catch (err) {
      setSearchError(err instanceof Error ? err.message : 'Location search failed.');
    } finally {
      setSearching(false);
    }
  };

  const useCurrentLocation = () => {
    if (!navigator.geolocation) {
      setSearchError('Your browser does not support location access.');
      return;
    }
    setLocating(true);
    setSearchError(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        flyTo(pos.coords.latitude, pos.coords.longitude, null);
        setLocating(false);
      },
      () => {
        setSearchError('Could not get your current location — check browser location permission.');
        setLocating(false);
      },
      { enableHighAccuracy: true, timeout: 10000 },
    );
  };

  return (
    <div className="space-y-2">
      <form onSubmit={runSearch} className="flex gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" size={16} />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search college name or address..."
            className="w-full bg-main border border-border-default rounded-lg py-2 pl-9 pr-3 text-sm text-text-primary outline-none focus:border-accent-primary"
          />
        </div>
        <button
          type="submit"
          disabled={searching}
          className="px-3 py-2 bg-panel border border-border-default rounded-lg text-text-secondary hover:text-text-primary transition-colors text-sm flex items-center gap-1.5 disabled:opacity-50"
        >
          {searching ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />} Search
        </button>
        <button
          type="button"
          onClick={useCurrentLocation}
          disabled={locating}
          title="Use my current location"
          className="px-3 py-2 bg-panel border border-border-default rounded-lg text-text-secondary hover:text-text-primary transition-colors text-sm flex items-center gap-1.5 disabled:opacity-50"
        >
          {locating ? <Loader2 size={14} className="animate-spin" /> : <LocateFixed size={14} />}
        </button>
      </form>

      {searchError && <p className="text-xs text-status-error">{searchError}</p>}

      {searchResults.length > 0 && (
        <div className="border border-border-default rounded-lg overflow-hidden divide-y divide-border-default max-h-40 overflow-y-auto">
          {searchResults.map((r, i) => (
            <button
              key={i}
              type="button"
              onClick={() => {
                flyTo(r.lat, r.lng, r.boundingBox);
                setSearchResults([]);
                setSearchQuery(r.label);
              }}
              className="w-full text-left px-3 py-2 text-xs text-text-secondary hover:bg-main transition-colors"
            >
              {r.label}
            </button>
          ))}
        </div>
      )}

      <div ref={containerRef} className="w-full h-96 rounded-lg border border-border-default overflow-hidden bg-main" />
      <p className="text-[11px] text-text-muted">
        Search for the college or use your current location to find the area, then use the polygon tool
        (top-left of the map) to trace the boundary. Drag its points to adjust, or use the edit/delete
        controls to modify or clear it.
      </p>

      {info && (
        <div className="grid grid-cols-3 gap-3 p-3 bg-main border border-border-default rounded-lg text-xs">
          <div>
            <div className="text-text-muted uppercase font-bold">Status</div>
            <div className="text-text-primary mt-0.5">{info.status}</div>
          </div>
          <div>
            <div className="text-text-muted uppercase font-bold">Last updated</div>
            <div className="text-text-primary mt-0.5">{info.updatedAt ? new Date(info.updatedAt).toLocaleString() : '—'}</div>
          </div>
          <div>
            <div className="text-text-muted uppercase font-bold">Updated by</div>
            <div className="text-text-primary mt-0.5">{info.updatedByName ?? '—'}</div>
          </div>
        </div>
      )}
    </div>
  );
};

export default GeofenceMapEditor;
