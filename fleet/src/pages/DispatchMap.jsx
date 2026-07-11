import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import L from 'leaflet';
import { api } from '../api';
import { usePolledApi, Segmented, Skeleton, ErrorState, FreshnessBar, relTime, agoLabel } from '../components.jsx';
import { trailerMarkerStyle, displayTrailerStatus, TRAILER_COLORS } from '../utils/trailerState';
import {
  DEFAULT_FILTERS, QUICK_FILTERS, sanitizeFilters,
  buildDriverPositionIndex, filterTrucks, filterTrailers,
  calculateAssetCounts, getVisibleMapPoints, cargoGlyph, trailerAriaLabel,
} from '../utils/assetMapFilters';

const CONDITION_COLOR = { loaded: '#722ed1', finishing: '#d48806', empty: '#16a34a', stale: '#8a94a4' };
const FILTERS_STORAGE_KEY = 'fleet.dispatchMap.assetFilters.v1';
const TRAILER_REFRESH_MS = 30000; // same cadence as the truck snapshot poll

const prefersReducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia
  && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function loadStoredFilters() {
  try {
    return sanitizeFilters(JSON.parse(localStorage.getItem(FILTERS_STORAGE_KEY) || 'null'));
  } catch (_) {
    return { ...DEFAULT_FILTERS };
  }
}

function fmtLocationQuality(q) {
  return { exact: 'Exact', derived_from_driver: 'Derived from driver', approximate: 'Approximate', missing: 'Missing' }[q] || q;
}

/**
 * Trailer rectangle with an in-marker text glyph so state is never color-only:
 * E=Empty, L=Loaded, ?=Unknown cargo, !=Needs review. `offsetIndex` nudges
 * co-located rectangles apart (several derived trailers on one driver, or
 * several dropped trailers at the same facility) instead of stacking them.
 */
function trailerDivIcon(entry, offsetIndex = 0) {
  const { trailer, position, quality } = entry;
  const style = trailerMarkerStyle(trailer);
  const glyph = cargoGlyph(trailer);
  const border = style.outline === '#ef4444' ? '2px solid #ef4444' : `2px solid ${style.dashed ? style.color : '#fff'}`;
  const dashed = style.dashed ? 'border-style:dashed;' : '';
  const baseX = position.derived ? -8 : 10;
  return L.divIcon({
    className: 'trailer-fleet-marker',
    html: `<div role="img" aria-label="${trailerAriaLabel(trailer, quality).replace(/"/g, '&quot;')}"
      style="width:20px;height:14px;border-radius:2px;background:${style.color};${dashed}border:${border};
      box-shadow:0 0 3px rgba(0,0,0,.6);display:grid;place-items:center;
      font:700 10px/1 system-ui,sans-serif;color:#fff;text-shadow:0 0 2px rgba(0,0,0,.8)">${glyph}</div>`,
    iconSize: [20, 14],
    iconAnchor: [baseX - offsetIndex * 12, 7],
  });
}

function trailerPopupHtml(entry) {
  const { trailer: t, position, quality } = entry;
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const review = t.needs_review || t.status_needs_review;
  return `<b>🚚 Trailer ${esc(t.unit_number)}</b><br/>Status: ${esc(displayTrailerStatus(t))}${review ? ' • review' : ''}<br/>`
    + `Driver: ${esc(t.current_driver_name || '—')}<br/>Location: ${esc(t.location_text || t.current_location_text || '—')}<br/>`
    + `Location quality: ${esc(fmtLocationQuality(quality))}${position.derivedFromUnit ? ` (unit ${esc(position.derivedFromUnit)})` : ''}<br/>`
    + `Condition: ${esc(t.condition_text || t.current_condition || '—')}<br/>`
    + `Last event: ${esc(t.last_event_at ? new Date(t.last_event_at).toLocaleString() : '—')}`;
}

export default function DispatchMap() {
  const [condition, setCondition] = useState('all'); // truck load filter (server-side, unchanged)
  const [filters, setFilters] = useState(loadStoredFilters);
  const [search, setSearch] = useState(''); // not persisted
  const [trailerData, setTrailerData] = useState({ trailers: [], noLocation: [] });
  const [trailerError, setTrailerError] = useState(false);
  const [listOpen, setListOpen] = useState(true);

  // Reads the cached snapshot from the backend and auto-refreshes every 30s.
  const q = usePolledApi(`/dispatch-map?condition=${condition}`, [condition], { intervalMs: 30000 });
  const mapRef = useRef(null);
  const mapObj = useRef(null);
  const truckLayerRef = useRef(null);
  const trailerLayerRef = useRef(null);
  const truckMarkersRef = useRef(new Map());   // load_id -> marker
  const trailerMarkersRef = useRef(new Map()); // trailer_id -> marker
  const fittedRef = useRef(false);

  const markers = (q.data && q.data.data && q.data.data.markers) || [];
  const noLoc = (q.data && q.data.data && q.data.data.noLocation) || [];
  const stale = q.data && q.data.meta && q.data.meta.stale;

  // ── persist filters (validated on load; search text is intentionally not stored) ──
  useEffect(() => {
    try { localStorage.setItem(FILTERS_STORAGE_KEY, JSON.stringify(filters)); } catch (_) { /* storage full/blocked */ }
  }, [filters]);
  const setFilter = useCallback((patch) => setFilters((f) => sanitizeFilters({ ...f, ...patch })), []);
  const clearFilters = useCallback(() => { setFilters({ ...DEFAULT_FILTERS }); setSearch(''); }, []);

  // ── unified trailer state (TrailerStateService) — ALWAYS polled so counts and
  //    trailers-only mode work; fully fail-soft: a trailer-store failure keeps
  //    the last good list and never touches the truck map. ──
  useEffect(() => {
    let cancelled = false;
    const loadTrailers = async () => {
      try {
        const resp = await api('/trailer-state/map');
        if (!cancelled && resp && resp.data) {
          setTrailerData({ trailers: resp.data.trailers || [], noLocation: resp.data.noLocation || [] });
          setTrailerError(false);
        }
      } catch (_) { if (!cancelled) setTrailerError(true); /* keep previous data */ }
    };
    loadTrailers();
    const id = setInterval(loadTrailers, TRAILER_REFRESH_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  // ── shared filtered dataset: the map and the side list consume EXACTLY this ──
  // The driver index is built once per snapshot from ALL trucks (even when the
  // truck layer is hidden) so with-driver trailers keep their derived position.
  const driverIndex = useMemo(
    () => buildDriverPositionIndex(markers.map((mk) => ({ names: [mk.driver_name], lat: mk.latitude, lng: mk.longitude, unit: mk.unit }))),
    [markers]
  );
  const visibleTrucks = useMemo(
    () => filterTrucks(markers, filters, { search }),
    [markers, filters, search]
  );
  const visibleTrailers = useMemo(
    () => filterTrailers(trailerData.trailers, filters, { driverIndex, search }),
    [trailerData.trailers, filters, driverIndex, search]
  );
  const counts = useMemo(
    () => calculateAssetCounts({ trucks: markers, trailers: trailerData.trailers, driverIndex }),
    [markers, trailerData.trailers, driverIndex]
  );
  const mappableTrailers = useMemo(
    () => visibleTrailers.filter((e) => e.position.lat != null && e.position.lng != null),
    [visibleTrailers]
  );
  const unmappableTrailers = useMemo(
    () => visibleTrailers.filter((e) => e.position.lat == null || e.position.lng == null),
    [visibleTrailers]
  );

  // ── map init (once; never recreated on filter changes) ──
  useEffect(() => {
    if (!mapRef.current || mapObj.current) return;
    mapObj.current = L.map(mapRef.current).setView([39.5, -95], 4);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OpenStreetMap', maxZoom: 18 }).addTo(mapObj.current);
    truckLayerRef.current = L.layerGroup().addTo(mapObj.current);
    trailerLayerRef.current = L.layerGroup().addTo(mapObj.current);
    return () => { if (mapObj.current) { mapObj.current.remove(); mapObj.current = null; } };
  }, []);

  // Keep Leaflet sized correctly: window resizes and layout-affecting UI
  // changes (toolbar wrap, list collapse, view switch). One debounced call —
  // never a loop.
  useEffect(() => {
    const onResize = () => { if (mapObj.current) mapObj.current.invalidateSize(); };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  useEffect(() => {
    const id = setTimeout(() => { if (mapObj.current) mapObj.current.invalidateSize(); }, 150);
    return () => clearTimeout(id);
  }, [listOpen, filters.assetView]);

  // ── fit helpers: only the CURRENTLY VISIBLE filtered markers ──
  const fitVisible = useCallback(() => {
    const map = mapObj.current;
    if (!map) return;
    const pts = getVisibleMapPoints(visibleTrucks, mappableTrailers);
    if (!pts.length) return; // nothing visible — leave the map alone
    const animate = !prefersReducedMotion();
    if (pts.length === 1) { map.setView(pts[0], 8, { animate }); return; }
    map.fitBounds(L.latLngBounds(pts), { padding: [40, 40], maxZoom: 8, animate });
  }, [visibleTrucks, mappableTrailers]);

  // Auto-fit ONCE on first data, never on the 30s refreshes.
  useEffect(() => {
    if (fittedRef.current) return;
    if (!visibleTrucks.length && !mappableTrailers.length) return;
    fitVisible();
    fittedRef.current = true;
  }, [visibleTrucks, mappableTrailers, fitVisible]);

  // ── truck markers (separate layer; filters only repopulate this layer) ──
  useEffect(() => {
    const layer = truckLayerRef.current;
    if (!layer) return;
    layer.clearLayers();
    truckMarkersRef.current.clear();
    visibleTrucks.forEach((mk) => {
      if (mk.latitude == null || mk.longitude == null) return;
      const color = mk.freshness === 'stale' ? CONDITION_COLOR.stale : (CONDITION_COLOR[mk.condition] || '#1677ff');
      const marker = L.circleMarker([mk.latitude, mk.longitude], { radius: 8, color, fillColor: color, fillOpacity: 0.85, weight: 2 });
      marker.bindPopup(
        `<b>${mk.driver_name || 'Driver'}</b> · Unit ${mk.unit || '—'}<br/>`
        + `${mk.loaded_label || (mk.loaded ? 'Loaded' : 'Empty')}${mk.load_number ? ` · Load ${mk.load_number}` : ''} · ${mk.status}<br/>`
        + `${mk.freshness === 'stale' ? `<span style="color:#d48806">Stale — last seen ${agoLabel(mk.observed_at) || relTime(mk.observed_at)}</span>` : `Last seen ${agoLabel(mk.observed_at) || relTime(mk.observed_at)}`}<br/>`
        + `Speed ${mk.speed_mph} mph · ${mk.source}<br/>`
        + (mk.remaining_miles != null ? `Remaining ${mk.remaining_miles} mi · ${mk.eta_label || ''}` : ''),
      );
      // accessible name (§10.6)
      marker.options.alt = `${mk.driver_name}, unit ${mk.unit}, ${mk.condition}, ${mk.freshness}`;
      layer.addLayer(marker);
      truckMarkersRef.current.set(mk.load_id, marker);
    });
  }, [visibleTrucks]);

  // ── trailer markers (separate layer; truck layer untouched) ──
  useEffect(() => {
    const layer = trailerLayerRef.current;
    if (!layer) return;
    layer.clearLayers();
    trailerMarkersRef.current.clear();
    const seenAt = new Map(); // "lat,lng" -> count, to offset co-located rectangles
    mappableTrailers.forEach((entry) => {
      const key = `${entry.position.lat.toFixed(5)},${entry.position.lng.toFixed(5)}`;
      const dupIndex = seenAt.get(key) || 0;
      seenAt.set(key, dupIndex + 1);
      const mk = L.marker([entry.position.lat, entry.position.lng], {
        icon: trailerDivIcon(entry, dupIndex),
        alt: trailerAriaLabel(entry.trailer, entry.quality),
        title: `Trailer ${entry.trailer.unit_number} — ${displayTrailerStatus(entry.trailer)}`,
      });
      mk.bindPopup(trailerPopupHtml(entry));
      layer.addLayer(mk);
      trailerMarkersRef.current.set(entry.trailer.trailer_id, mk);
    });
  }, [mappableTrailers]);

  const zoomToTrailer = useCallback((entry) => {
    const map = mapObj.current;
    const mk = trailerMarkersRef.current.get(entry.trailer.trailer_id);
    if (map && mk) {
      map.setView(mk.getLatLng(), Math.max(map.getZoom(), 8), { animate: !prefersReducedMotion() });
      mk.openPopup();
    }
    // Not mappable → the list row already shows the details; never move the map.
  }, []);

  const zoomToTruck = useCallback((mk) => {
    const map = mapObj.current;
    const marker = truckMarkersRef.current.get(mk.load_id);
    if (map && marker) {
      map.setView(marker.getLatLng(), Math.max(map.getZoom(), 7), { animate: !prefersReducedMotion() });
      marker.openPopup();
    }
  }, []);

  const trailerControlsDisabled = filters.assetView === 'trucks';
  const showingLine = filters.assetView === 'trucks'
    ? `Showing ${visibleTrucks.length} of ${counts.trucks} trucks`
    : filters.assetView === 'trailers'
      ? `Showing ${visibleTrailers.length} of ${counts.trailers} trailers`
      : `Showing ${visibleTrucks.length} of ${counts.trucks} trucks and ${visibleTrailers.length} of ${counts.trailers} trailers`;

  const selectStyle = { height: 30, borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', fontSize: 13 };
  const dim = (label, key, options) => (
    <label style={{ fontSize: 13, color: 'var(--text-2)', display: 'flex', alignItems: 'center', gap: 4, opacity: trailerControlsDisabled ? 0.5 : 1 }}>
      {label}
      <select value={filters[key]} onChange={(e) => setFilter({ [key]: e.target.value })} disabled={trailerControlsDisabled}
        aria-label={`Trailer filter: ${label}`} style={selectStyle}>
        {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    </label>
  );

  const countChips = [
    ['Trucks', counts.trucks], ['Trailers', counts.trailers], ['With driver', counts.withDriver],
    ['Dropped', counts.dropped], ['Loaded', counts.loaded], ['Empty', counts.empty],
    ['Unknown cargo', counts.unknownCargo], ['Needs review', counts.needsReview], ['No location', counts.locationMissing],
  ];

  return (
    <div>
      <div className="toolbar" role="group" aria-label="Asset view and truck filters">
        <Segmented value={filters.assetView} onChange={(v) => setFilter({ assetView: v })} options={[
          { value: 'all', label: 'All assets' }, { value: 'trucks', label: 'Trucks only' }, { value: 'trailers', label: 'Trailers only' },
        ]} />
        {filters.assetView !== 'trailers' && (
          <Segmented value={condition} onChange={setCondition} options={[
            { value: 'all', label: 'All loads' }, { value: 'empty', label: 'Empty' }, { value: 'finishing', label: 'Finishing' }, { value: 'loaded', label: 'Loaded' },
          ]} />
        )}
        <div className="search-inline"><span className="ico">🔍</span>
          <input placeholder="Search unit, driver, load, location…" aria-label="Search assets"
            value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <button className="btn" onClick={fitVisible} aria-label="Fit map to visible results">⛶ Fit visible</button>
        <button className="btn" aria-label="Refresh displayed locations" onClick={q.reload}>⟳ Refresh</button>
      </div>

      <div className="toolbar" role="group" aria-label="Trailer filters" style={{ flexWrap: 'wrap' }}>
        {dim('Possession:', 'trailerPossession', [['all', 'All'], ['with_driver', 'With driver'], ['dropped', 'Dropped'], ['unknown', 'Unknown']])}
        {dim('Cargo:', 'trailerCargo', [['all', 'All'], ['loaded', 'Loaded'], ['empty', 'Empty'], ['unknown', 'Unknown cargo']])}
        {dim('Review:', 'trailerReview', [['all', 'All'], ['needs_review', 'Needs review'], ['confirmed', 'Confirmed']])}
        {dim('Location:', 'locationQuality', [['all', 'All'], ['exact', 'Exact / manual'], ['derived_from_driver', 'Derived from driver'], ['approximate', 'Approximate'], ['missing', 'Missing']])}
        {QUICK_FILTERS.map((qf) => (
          <button key={qf.key} className="btn" style={{ fontSize: 12 }}
            onClick={() => setFilter(qf.patch)} aria-label={`Quick filter: ${qf.label}`}>
            {qf.label}
          </button>
        ))}
        <button className="btn" style={{ fontSize: 12 }} onClick={clearFilters} aria-label="Clear all filters">✕ Clear filters</button>
        <button className="btn" style={{ fontSize: 12 }} onClick={() => setListOpen((v) => !v)} aria-expanded={listOpen} aria-label="Toggle side list">
          {listOpen ? 'Hide list' : 'Show list'}
        </button>
      </div>

      <div className="toolbar" aria-label="Fleet snapshot counts" style={{ flexWrap: 'wrap', gap: 6 }}>
        {countChips.map(([label, value]) => (
          <span key={label} style={{ fontSize: 12, color: 'var(--text-2)', border: '1px solid var(--border)', borderRadius: 12, padding: '2px 10px' }}>
            {label} <strong style={{ color: 'var(--text)' }}>{value}</strong>
          </span>
        ))}
        <span style={{ fontSize: 12, color: 'var(--text)', fontWeight: 600 }} aria-live="polite">{showingLine}</span>
        <span style={{ fontSize: 11, color: 'var(--text-3)' }}>(counts are the full current snapshot, before filters)</span>
      </div>

      <FreshnessBar meta={q.meta} refreshing={q.refreshing} lastUpdated={q.lastUpdated} onRefresh={q.reload} />
      {stale && <div className="stale-banner">Live locations may be stale; showing the last successfully synced positions.</div>}
      {trailerError && filters.assetView !== 'trucks' && (
        <div className="stale-banner">Trailer state is temporarily unavailable — showing the last loaded trailers. Trucks are unaffected.</div>
      )}

      <div className="map-layout" style={!listOpen ? { gridTemplateColumns: '1fr' } : undefined}>
        {listOpen && (
        <div className="map-list">
          <div style={{ fontWeight: 600, marginBottom: 8 }}>Legend</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 12, fontSize: 13 }}>
            {filters.assetView !== 'trailers' && Object.entries(CONDITION_COLOR).map(([k, c]) => <div key={k} style={{ display: 'flex', gap: 8, alignItems: 'center' }}><span style={{ width: 12, height: 12, borderRadius: '50%', background: c }} />{k === 'stale' ? 'Stale location' : k}</div>)}
            {filters.assetView !== 'trucks' && (
              <>
                <div style={{ fontWeight: 600, marginTop: 4 }}>🚚 Trailers (letter = cargo)</div>
                {[
                  ['Dropped / Empty (E)', TRAILER_COLORS.droppedEmpty],
                  ['Dropped / Loaded (L)', TRAILER_COLORS.droppedLoaded],
                  ['With driver / Empty (E)', TRAILER_COLORS.withDriverEmpty],
                  ['With driver / Loaded (L)', TRAILER_COLORS.withDriverLoaded],
                  ['With driver / Unknown (?)', TRAILER_COLORS.withDriverUnknown],
                ].map(([label, c]) => (
                  <div key={label} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <span style={{ width: 14, height: 10, borderRadius: 2, background: c }} />{label}
                  </div>
                ))}
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <span style={{ width: 14, height: 10, borderRadius: 2, background: 'transparent', border: '2px solid #ef4444' }} />Needs review (!)
                </div>
              </>
            )}
          </div>

          {q.loading ? <Skeleton rows={4} /> : (
            <>
              {filters.assetView !== 'trailers' && (
                <>
                  <div style={{ fontWeight: 600, margin: '8px 0' }}>🚛 Trucks on map ({visibleTrucks.filter((t) => t.latitude != null).length})</div>
                  {visibleTrucks.filter((t) => t.latitude != null).map((mk) => (
                    <div key={mk.load_id} style={{ padding: 8, borderBottom: '1px solid var(--border)', fontSize: 13, cursor: 'pointer' }}
                      onClick={() => zoomToTruck(mk)} onKeyDown={(e) => { if (e.key === 'Enter') zoomToTruck(mk); }} role="button" tabIndex={0}
                      aria-label={`Truck unit ${mk.unit}, driver ${mk.driver_name}`}>
                      <b>{mk.driver_name}</b> · Unit {mk.unit}<br />
                      <span style={{ color: mk.freshness === 'stale' ? 'var(--amber)' : 'var(--text-3)' }}>{mk.freshness === 'stale' ? `Stale — ${relTime(mk.observed_at)}` : `Live · ${relTime(mk.observed_at)}`}</span>
                    </div>
                  ))}
                  {noLoc.length > 0 && filters.locationQuality !== 'exact' && (
                    <>
                      <div style={{ fontWeight: 600, margin: '12px 0 4px', color: 'var(--amber)' }}>Trucks without location ({noLoc.length})</div>
                      {noLoc.map((n) => <div key={n.load_id} style={{ padding: 6, fontSize: 13, color: 'var(--text-2)' }}>{n.driver_name} · Unit {n.unit} — {n.reason}</div>)}
                    </>
                  )}
                </>
              )}

              {filters.assetView !== 'trucks' && (
                <>
                  <div style={{ fontWeight: 600, margin: '12px 0 4px' }}>🚚 Trailers ({visibleTrailers.length})</div>
                  {visibleTrailers.length === 0 && <div style={{ padding: 6, fontSize: 13, color: 'var(--text-3)' }}>No trailers match the current filters.</div>}
                  {visibleTrailers.map((entry) => {
                    const t = entry.trailer;
                    const review = t.needs_review || t.status_needs_review;
                    const mappable = entry.position.lat != null;
                    return (
                      <div key={t.trailer_id}
                        style={{ padding: 8, borderBottom: '1px solid var(--border)', fontSize: 13, cursor: mappable ? 'pointer' : 'default' }}
                        onClick={() => zoomToTrailer(entry)} onKeyDown={(e) => { if (e.key === 'Enter') zoomToTrailer(entry); }}
                        role="button" tabIndex={0} aria-label={trailerAriaLabel(t, entry.quality)}>
                        <b>{t.unit_number}</b> — {displayTrailerStatus(t)}
                        {review ? <span style={{ color: '#ef4444', fontWeight: 700 }}> !</span> : null}<br />
                        <span style={{ color: 'var(--text-3)' }}>
                          {t.current_driver_name ? `${t.current_driver_name} · ` : ''}
                          {t.location_text || t.current_location_text || 'no location text'} · {fmtLocationQuality(entry.quality)}
                          {t.condition_text ? ` · ${t.condition_text}` : ''}
                          {t.last_event_at ? ` · ${relTime(t.last_event_at)}` : ''}
                          {!mappable ? ' · not on map' : ''}
                        </span>
                      </div>
                    );
                  })}
                  {unmappableTrailers.length > 0 && (
                    <div style={{ padding: '6px 8px', fontSize: 12, color: 'var(--text-3)' }}>
                      {unmappableTrailers.length} trailer(s) above have no mappable location and are list-only.
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </div>
        )}
        <div className="map-canvas">
          {q.error ? <ErrorState error={q.error} onRetry={q.reload} /> : <div ref={mapRef} style={{ height: '100%', width: '100%', minHeight: 420 }} />}
        </div>
      </div>
    </div>
  );
}
