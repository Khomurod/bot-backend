import React, { useEffect, useState, useRef, useCallback } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { useApp } from '../store.jsx';
import { api } from '../api';

const STATUS_LABEL = { with_driver: 'With driver', dropped: 'Dropped', unknown: 'Unknown' };
const STATUS_COLOR = { with_driver: '#22c55e', dropped: '#f59e0b', unknown: '#94a3b8' };

function fmt(iso) {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleString(); } catch { return String(iso); }
}

function Badge({ status }) {
  const s = status || 'unknown';
  return (
    <span style={{ padding: '2px 8px', borderRadius: 10, fontSize: 12, fontWeight: 600, background: STATUS_COLOR[s] + '22', color: STATUS_COLOR[s] }}>
      {STATUS_LABEL[s] || s}
    </span>
  );
}

export default function TrailerTrackingPage() {
  const { toast } = useApp();
  const [trailers, setTrailers] = useState([]);
  const [mapData, setMapData] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showTrailers, setShowTrailers] = useState(true);
  const [selected, setSelected] = useState(null);
  const [detail, setDetail] = useState(null);

  const mapContainerRef = useRef(null);
  const mapRef = useRef(null);
  const layerRef = useRef(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [cur, map] = await Promise.all([
        api('/trailers/current'),
        api('/trailers/map'),
      ]);
      setTrailers(cur.data || []);
      setMapData(map.data || []);
    } catch (err) {
      toast(err.message || 'Failed to load trailers', 'error');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { load(); }, [load]);

  const openTrailer = useCallback(async (id) => {
    setSelected(id);
    setDetail(null);
    try {
      const d = await api(`/trailers/${id}/timeline`);
      setDetail(d.data);
    } catch (err) {
      toast(err.message || 'Failed to load timeline', 'error');
    }
  }, [toast]);

  // ── map init ──
  useEffect(() => {
    if (mapRef.current || !mapContainerRef.current) return;
    const map = L.map(mapContainerRef.current, { zoomControl: true }).setView([39.5, -98.35], 4);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap', maxZoom: 19,
    }).addTo(map);
    layerRef.current = L.layerGroup().addTo(map);
    mapRef.current = map;
    setTimeout(() => map.invalidateSize(), 200);
    return () => { map.remove(); mapRef.current = null; };
  }, []);

  useEffect(() => {
    const layer = layerRef.current;
    if (!layer) return;
    layer.clearLayers();
    if (!showTrailers) return;
    for (const t of mapData.filter((x) => x.current_lat != null && x.current_lng != null)) {
      const approximate = t.location_source === 'approximate_state' || t.location_source === 'approximate';
      const color = STATUS_COLOR[t.current_status] || STATUS_COLOR.unknown;
      const border = t.status_needs_review ? '3px solid #ef4444' : '2px solid #fff';
      const dashed = approximate ? 'border-style:dashed;' : '';
      const icon = L.divIcon({
        className: 'trailer-marker',
        html: `<div style="width:16px;height:12px;border-radius:3px;background:${color};${dashed}border:${border};box-shadow:0 0 3px rgba(0,0,0,.6)"></div>`,
        iconSize: [16, 12], iconAnchor: [8, 6],
      });
      L.marker([t.current_lat, t.current_lng], { icon })
        .bindPopup(
          `<b>${t.unit_number}</b><br/>Status: ${STATUS_LABEL[t.current_status] || t.current_status}<br/>`
          + `Driver: ${t.current_driver_name || '—'}<br/>Location: ${t.current_location_text || '—'}<br/>`
          + `Condition: ${t.current_condition || '—'}<br/>Reporter: ${t.last_reporter_name || '—'}<br/>`
          + `Last event: ${fmt(t.last_event_at)}`
        )
        .on('click', () => openTrailer(t.trailer_id))
        .addTo(layer);
    }
  }, [mapData, showTrailers, openTrailer]);

  const textOnly = mapData.filter((t) => (t.current_lat == null || t.current_lng == null) && t.current_location_text);

  return (
    <div style={{ padding: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <h1 style={{ margin: 0 }}>Trailer Tracking <span style={{ fontSize: 13, color: '#f59e0b' }}>(Beta)</span></h1>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input type="checkbox" checked={showTrailers} onChange={(e) => setShowTrailers(e.target.checked)} />
            Show trailers
          </label>
          <button className="btn" onClick={load}>Refresh</button>
        </div>
      </div>

      <div ref={mapContainerRef} style={{ height: 380, borderRadius: 8, overflow: 'hidden', border: '1px solid rgba(148,163,184,.2)', margin: '12px 0' }} />

      {textOnly.length > 0 && (
        <div className="card" style={{ padding: 12, marginBottom: 12 }}>
          <strong>Text-only locations (not mappable):</strong>
          <ul style={{ margin: '6px 0 0' }}>
            {textOnly.map((t) => (
              <li key={t.trailer_id}>{t.unit_number} — {t.current_location_text} ({STATUS_LABEL[t.current_status] || t.current_status})</li>
            ))}
          </ul>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: selected ? '1fr 1fr' : '1fr', gap: 16 }}>
        <div style={{ overflowX: 'auto' }}>
          <table className="data-table">
            <thead>
              <tr><th>Unit</th><th>Status</th><th>Driver</th><th>Location</th><th>Condition</th><th>Reporter</th><th>Last event</th></tr>
            </thead>
            <tbody>
              {loading && <tr><td colSpan={7}>Loading…</td></tr>}
              {!loading && trailers.length === 0 && <tr><td colSpan={7} style={{ color: '#94a3b8' }}>No trailers tracked yet.</td></tr>}
              {trailers.map((t) => (
                <tr key={t.id} style={{ cursor: 'pointer' }} onClick={() => openTrailer(t.id)}>
                  <td><strong>{t.unit_number}</strong></td>
                  <td><Badge status={t.current_status} /></td>
                  <td>{t.current_driver_name || '—'}</td>
                  <td>{t.current_location_text || '—'}</td>
                  <td>{t.current_condition || '—'}</td>
                  <td>{t.last_reporter_name || '—'}</td>
                  <td>{fmt(t.last_event_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {selected && (
          <div className="card" style={{ padding: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h3 style={{ margin: 0 }}>Trailer {detail?.trailer?.unit_number || ''}</h3>
              <button className="btn" onClick={() => { setSelected(null); setDetail(null); }}>Close</button>
            </div>
            {!detail ? <p>Loading…</p> : (
              <>
                <p style={{ margin: '8px 0' }}><Badge status={detail.status?.current_status} /></p>
                <div style={{ fontSize: 14, color: '#94a3b8', marginBottom: 8 }}>
                  Driver: {detail.status?.current_driver_name || '—'} · Location: {detail.status?.current_location_text || '—'}
                  {detail.status?.last_reporter_name ? ` · Reporter: ${detail.status.last_reporter_name}` : ''}
                </div>
                <h4>Timeline</h4>
                <table className="data-table">
                  <thead><tr><th>When</th><th>Type</th><th>Location</th><th>Condition</th><th>Reporter</th></tr></thead>
                  <tbody>
                    {(detail.events || []).length === 0 && <tr><td colSpan={5} style={{ color: '#94a3b8' }}>No events.</td></tr>}
                    {(detail.events || []).map((e) => (
                      <tr key={e.id}>
                        <td>{fmt(e.event_time || e.created_at)}</td>
                        <td>{e.event_type}</td>
                        <td>{e.location_text || '—'}</td>
                        <td>{e.condition_text || '—'}</td>
                        <td>{e.reported_by_name || e.reported_by_username || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
