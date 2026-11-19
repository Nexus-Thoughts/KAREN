/**
 * Point + radius classroom coordinate picker (Phase 7).
 *
 * docs/06/master-prompt: "Do NOT require the user to manually enter polygon
 * coordinates... this is a POINT + RADIUS geofence" — a single draggable
 * marker with a radius circle, not the polygon-drawing tool Phase 8's campus
 * geofence will need. Manual lat/long entry is still offered as a fallback
 * (explicitly permitted: "Enter latitude/longitude manually if needed").
 *
 * Uses raw Leaflet imperatively rather than react-leaflet: react-leaflet's
 * latest major targets React 19 but its v4 (the widely-documented stable
 * line) only supports React 18 as a peer, and this project is on React 19
 * throughout. A single map widget with one marker and one circle does not
 * need a full React binding layer — plain Leaflet inside a ref-managed
 * useEffect is the smaller, more direct dependency for what is otherwise one
 * interaction (drag a marker; watch a circle resize).
 *
 * No basemap tile server is configured here (no default OSM tile URL is
 * wired in) — every real deployment should point this at its own tile
 * provider per that provider's terms; this ships the picker/geometry logic
 * and expects `tileUrl`/`attribution` to be supplied by the caller. Without
 * one, the map still renders (grey canvas) and the marker/circle/manual
 * lat-long entry all still work, since none of that depends on tiles.
 */
import React, { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { TILE_URL, TILE_ATTRIBUTION } from '@/lib/mapTiles';

// Leaflet's default marker icon paths assume a bundler-unaware setup; Vite's
// asset pipeline breaks the default URLs, so the icon is rebuilt from the
// package's own bundled images instead of leaving Leaflet to 404 on it.
import markerIcon2x from 'leaflet/dist/images/marker-icon-2x.png';
import markerIcon from 'leaflet/dist/images/marker-icon.png';
import markerShadow from 'leaflet/dist/images/marker-shadow.png';

const defaultIcon = L.icon({
  iconUrl: markerIcon,
  iconRetinaUrl: markerIcon2x,
  shadowUrl: markerShadow,
  iconSize: [25, 41],
  iconAnchor: [12, 41],
});

export interface ClassroomMapPickerProps {
  latitude: number | null;
  longitude: number | null;
  radiusM: number;
  onChange: (lat: number, lng: number) => void;
  tileUrl?: string;
  attribution?: string;
}

const FALLBACK_CENTER: [number, number] = [20.5937, 78.9629]; // India, wide zoom — neutral starting point, not a real campus (docs/00 blocker #3).

const ClassroomMapPicker: React.FC<ClassroomMapPickerProps> = ({
  latitude,
  longitude,
  radiusM,
  onChange,
  tileUrl = TILE_URL,
  attribution = TILE_ATTRIBUTION,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markerRef = useRef<L.Marker | null>(null);
  const circleRef = useRef<L.Circle | null>(null);
  const [latInput, setLatInput] = useState(latitude?.toFixed(6) ?? '');
  const [lngInput, setLngInput] = useState(longitude?.toFixed(6) ?? '');

  // Map init — once.
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const center: [number, number] =
      latitude !== null && longitude !== null ? [latitude, longitude] : FALLBACK_CENTER;

    const map = L.map(containerRef.current, {
      center,
      zoom: latitude !== null ? 18 : 5,
    });

    L.tileLayer(tileUrl, { attribution, maxZoom: 19 }).addTo(map);

    const marker = L.marker(center, { draggable: true, icon: defaultIcon }).addTo(map);
    const circle = L.circle(center, { radius: radiusM, color: '#2F5BFF', fillOpacity: 0.15 }).addTo(map);

    marker.on('dragend', () => {
      const pos = marker.getLatLng();
      circle.setLatLng(pos);
      onChange(pos.lat, pos.lng);
    });

    map.on('click', (e: L.LeafletMouseEvent) => {
      marker.setLatLng(e.latlng);
      circle.setLatLng(e.latlng);
      onChange(e.latlng.lat, e.latlng.lng);
    });

    mapRef.current = map;
    markerRef.current = marker;
    circleRef.current = circle;

    return () => {
      map.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep marker/circle in sync when the coordinates change from outside
  // (manual lat/long entry, or the parent form resetting on edit-open).
  useEffect(() => {
    if (!mapRef.current || !markerRef.current || !circleRef.current) return;
    if (latitude === null || longitude === null) return;
    const pos: [number, number] = [latitude, longitude];
    markerRef.current.setLatLng(pos);
    circleRef.current.setLatLng(pos);
    mapRef.current.setView(pos, mapRef.current.getZoom() < 15 ? 18 : mapRef.current.getZoom());
    setLatInput(latitude.toFixed(6));
    setLngInput(longitude.toFixed(6));
  }, [latitude, longitude]);

  useEffect(() => {
    circleRef.current?.setRadius(radiusM);
  }, [radiusM]);

  const applyManualEntry = () => {
    const lat = Number(latInput);
    const lng = Number(lngInput);
    if (Number.isFinite(lat) && Number.isFinite(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
      onChange(lat, lng);
    }
  };

  return (
    <div className="space-y-3">
      <div
        ref={containerRef}
        className="w-full h-64 rounded-lg border border-border-default overflow-hidden bg-main"
      />
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-xs text-text-muted uppercase font-bold">Latitude</label>
          <input
            type="text"
            className="w-full mt-1 bg-main border border-border-default rounded-lg p-2 text-sm text-text-primary outline-none focus:border-accent-primary"
            value={latInput}
            onChange={(e) => setLatInput(e.target.value)}
            onBlur={applyManualEntry}
            placeholder="e.g. 12.9716"
          />
        </div>
        <div>
          <label className="text-xs text-text-muted uppercase font-bold">Longitude</label>
          <input
            type="text"
            className="w-full mt-1 bg-main border border-border-default rounded-lg p-2 text-sm text-text-primary outline-none focus:border-accent-primary"
            value={lngInput}
            onChange={(e) => setLngInput(e.target.value)}
            onBlur={applyManualEntry}
            placeholder="e.g. 77.5946"
          />
        </div>
      </div>
      <p className="text-[11px] text-text-muted">
        Click the map or drag the marker to set the classroom's exact position. The shaded circle shows the
        current {radiusM}m attendance verification radius.
      </p>
    </div>
  );
};

export default ClassroomMapPicker;
