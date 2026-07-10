import React, { useState, useEffect, useRef } from 'react';
import L from 'leaflet';
import { api } from '../api';
import { usePolledApi, Segmented, Skeleton, EmptyState, ErrorState, FreshnessBar, fmtTime, relTime, agoLabel } from '../components.jsx';

const CONDITION_COLOR = { loaded: '#722ed1', finishing: '#d48806', empty: '#16a34a', stale: '#8a94a4' };
const TRAILER_STATUS_LABEL = { with_driver: 'With driver', dropped: 'Dropped', unknown: 'Unknown' };

function normName(name) { return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, ''); }

// Resolve a trailer's render position/color, deriving a with-driver trailer's
// location from its matched dispatch marker. Returns null when not mappable.
function resolveTrailer(t, markerByDriver) {
  let lat = t.current_lat;
  let lng = t.current_lng;
  let source = t.location_source || (lat != null ? 'exact' : null);
  let derived = false;
  if (t.current_status === 'with_driver') {
    const m = markerByDriver.get(normName(t.current_driver_name));
    if (m && m.latitude != null && m.longitude != null) {
      lat = m.latitude; lng = m.longitude; source = 'derived_from_driver'; derived = true;
    }
  }
  if (lat == null || lng == null) return null;
  const approximate = source === 'approximate_state' || source === 'approximate';
  let color;
  if (derived) color = '#22c55e';
  else if (approximate) color = '#8b5cf6';
  else if (t.current_status === 'dropped') color = '#f59e0b';
  else color = '#3b82f6';
  return { lat, lng, color, approximate, derived, source, needsReview: !!t.status_needs_review };
}

function trailerDivIcon(r) {
  const border = r.needsReview ? '3px solid #ef4444' : '2px solid #fff';
  const dashed = r.approximate ? 'border-style:dashed;' : '';
  return L.divIcon({
    className: 'trailer-fleet-marker',
    html: `<div style="width:15px;height:11px;border-radius:2px;background:${r.color};${dashed}border:${border};box-shadow:0 0 3px rgba(0,0,0,.6)"></div>`,
    iconSize: [15, 11],
    iconAnchor: r.derived ? [-8, 5] : [7, 5],
  });
}

export default function DispatchMap() {
  const [condition, setCondition] = useState('all');
  const [radius, setRadius] = useState(300);
  const [showTrailers, setShowTrailers] = useState(false);
  const [trailers, setTrailers] = useState([]);
  // Reads the cached snapshot from the backend and auto-refreshes every 30s.
  const q = usePolledApi(`/dispatch-map?condition=${condition}`, [condition], { intervalMs: 30000 });
  useEffect(() => { fittedRef.current = false; }, [condition]);
  const mapRef = useRef(null);
  const mapObj = useRef(null);
  const layerRef = useRef(null);
  const trailerLayerRef = useRef(null);
  const fittedRef = useRef(false);

  const markers = (q.data && q.data.data && q.data.data.markers) || [];
  const noLoc = (q.data && q.data.data && q.data.data.noLocation) || [];
  const stale = q.data && q.data.meta && q.data.meta.stale;

  // Trailer overlay: fetched only when enabled, polled on the same cadence, and
  // fully fail-soft — a trailer-store issue must never break the dispatch map.
  useEffect(() => {
    if (!showTrailers) { setTrailers([]); return undefined; }
    let cancelled = false;
    const loadTrailers = async () => {
      try {
        const resp = await api('/trailers/map');
        if (!cancelled) setTrailers((resp && resp.data) || []);
      } catch (_) { if (!cancelled) setTrailers([]); }
    };
    loadTrailers();
    const id = setInterval(loadTrailers, 30000);
    return () => { cancelled = true; clearInterval(id); };
  }, [showTrailers]);

  useEffect(() => {
    if (!mapRef.current || mapObj.current) return;
    mapObj.current = L.map(mapRef.current).setView([39.5, -95], 4);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OpenStreetMap', maxZoom: 18 }).addTo(mapObj.current);
    layerRef.current = L.layerGroup().addTo(mapObj.current);
    trailerLayerRef.current = L.layerGroup().addTo(mapObj.current);
    return () => { if (mapObj.current) { mapObj.current.remove(); mapObj.current = null; } };
  }, []);

  // Trailer rectangles (overlay). Independent of truck markers so toggling never
  // touches them. Derives with-driver trailer positions from matched markers.
  useEffect(() => {
    const layer = trailerLayerRef.current;
    if (!layer) return;
    layer.clearLayers();
    if (!showTrailers) return;
    const markerByDriver = new Map();
    markers.forEach((m) => { if (m.driver_name) markerByDriver.set(normName(m.driver_name), m); });
    trailers.forEach((t) => {
      const r = resolveTrailer(t, markerByDriver);
      if (!r) return;
      const mk = L.marker([r.lat, r.lng], { icon: trailerDivIcon(r), alt: `Trailer ${t.unit_number}` });
      mk.bindPopup(
        `<b>🚚 Trailer ${t.unit_number}</b><br/>Status: ${TRAILER_STATUS_LABEL[t.current_status] || t.current_status}${r.needsReview ? ' • review' : ''}<br/>`
        + `Driver: ${t.current_driver_name || '—'}<br/>Location: ${t.current_location_text || '—'}<br/>`
        + (r.derived ? '<i>Derived from driver/truck live location.</i><br/>' : (r.approximate ? '<i>Approximate location.</i><br/>' : ''))
        + `Condition: ${t.current_condition || '—'}`,
      );
      layer.addLayer(mk);
    });
  }, [trailers, showTrailers, q.data]);

  useEffect(() => {
    if (!layerRef.current) return;
    layerRef.current.clearLayers();
    markers.forEach((m) => {
      const color = m.freshness === 'stale' ? CONDITION_COLOR.stale : (CONDITION_COLOR[m.condition] || '#1677ff');
      const marker = L.circleMarker([m.latitude, m.longitude], { radius: 8, color, fillColor: color, fillOpacity: 0.85, weight: 2 });
      marker.bindPopup(
        `<b>${m.driver_name || 'Driver'}</b> · Unit ${m.unit || '—'}<br/>`
        + `${m.loaded_label || (m.loaded ? 'Loaded' : 'Empty')}${m.load_number ? ` · Load ${m.load_number}` : ''} · ${m.status}<br/>`
        + `${m.freshness === 'stale' ? `<span style="color:#d48806">Stale — last seen ${agoLabel(m.observed_at) || relTime(m.observed_at)}</span>` : `Last seen ${agoLabel(m.observed_at) || relTime(m.observed_at)}`}<br/>`
        + `Speed ${m.speed_mph} mph · ${m.source}<br/>`
        + (m.remaining_miles != null ? `Remaining ${m.remaining_miles} mi · ${m.eta_label || ''}` : ''),
      );
      // accessible name (§10.6)
      marker.options.alt = `${m.driver_name}, unit ${m.unit}, ${m.condition}, ${m.freshness}`;
      layerRef.current.addLayer(marker);
    });
    // Only auto-fit once (or when the condition filter changes) so a 30s poll
    // doesn't keep yanking the operator's zoom/pan back.
    if (markers.length && !fittedRef.current) {
      const bounds = L.latLngBounds(markers.map((m) => [m.latitude, m.longitude]));
      mapObj.current.fitBounds(bounds, { padding: [40, 40], maxZoom: 6 });
      fittedRef.current = true;
    }
  }, [q.data]);

  return (
    <div>
      <div className="toolbar">
        <Segmented value={condition} onChange={setCondition} options={[
          { value: 'all', label: 'All' }, { value: 'empty', label: 'Empty' }, { value: 'finishing', label: 'Finishing' }, { value: 'loaded', label: 'Loaded' },
        ]} />
        <div className="search-inline"><span className="ico">🔍</span><input placeholder="Search truck/driver" aria-label="Search truck or driver" /></div>
        <div className="search-inline"><span className="ico">📍</span><input placeholder="Search location/coordinates" aria-label="Search location" /></div>
        <label style={{ fontSize: 13, color: 'var(--text-2)' }}>Radius:
          <select value={radius} onChange={(e) => setRadius(+e.target.value)} aria-label="Search radius" style={{ marginLeft: 6, height: 30, borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)' }}>
            {[100, 200, 300, 500].map((r) => <option key={r} value={r}>{r} mi</option>)}
          </select>
        </label>
        <label style={{ fontSize: 13, color: 'var(--text-2)', display: 'flex', alignItems: 'center', gap: 6 }}>
          <input type="checkbox" checked={showTrailers} onChange={(e) => setShowTrailers(e.target.checked)} aria-label="Show trailers on map" />
          🚚 Trailers
        </label>
        <button className="btn" aria-label="Refresh displayed locations" onClick={q.reload}>⟳ Refresh</button>
      </div>

      <FreshnessBar meta={q.meta} refreshing={q.refreshing} lastUpdated={q.lastUpdated} onRefresh={q.reload} />
      {stale && <div className="stale-banner">Live locations may be stale; showing the last successfully synced positions.</div>}

      <div className="map-layout">
        <div className="map-list">
          <div style={{ fontWeight: 600, marginBottom: 8 }}>Legend</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 12, fontSize: 13 }}>
            {Object.entries(CONDITION_COLOR).map(([k, c]) => <div key={k} style={{ display: 'flex', gap: 8, alignItems: 'center' }}><span style={{ width: 12, height: 12, borderRadius: '50%', background: c }} />{k === 'stale' ? 'Stale location' : k}</div>)}
          </div>
          {q.loading ? <Skeleton rows={4} /> : (
            <>
              <div style={{ fontWeight: 600, margin: '8px 0' }}>On map ({markers.length})</div>
              {markers.map((m) => (
                <div key={m.load_id} style={{ padding: 8, borderBottom: '1px solid var(--border)', fontSize: 13 }}
                  onClick={() => { mapObj.current.setView([m.latitude, m.longitude], 7); }} role="button" tabIndex={0}>
                  <b>{m.driver_name}</b> · Unit {m.unit}<br />
                  <span style={{ color: m.freshness === 'stale' ? 'var(--amber)' : 'var(--text-3)' }}>{m.freshness === 'stale' ? `Stale — ${relTime(m.observed_at)}` : `Live · ${relTime(m.observed_at)}`}</span>
                </div>
              ))}
              {noLoc.length > 0 && (
                <>
                  <div style={{ fontWeight: 600, margin: '12px 0 4px', color: 'var(--amber)' }}>Location unavailable ({noLoc.length})</div>
                  {noLoc.map((n) => <div key={n.load_id} style={{ padding: 6, fontSize: 13, color: 'var(--text-2)' }}>{n.driver_name} · Unit {n.unit} — {n.reason}</div>)}
                </>
              )}
            </>
          )}
        </div>
        <div className="map-canvas">
          {q.error ? <ErrorState error={q.error} onRetry={q.reload} /> : <div ref={mapRef} style={{ height: '100%', width: '100%' }} />}
        </div>
      </div>
    </div>
  );
}
