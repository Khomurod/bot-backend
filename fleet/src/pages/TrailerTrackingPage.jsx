import React, { useEffect, useState, useCallback } from 'react';
import { useApp } from '../store.jsx';
import { api } from '../api';
import { displayTrailerStatus } from '../utils/trailerState';

// Trailer Tracking = inventory / history / review. The OPERATIONAL map lives on
// the Dispatch Map (its 🚚 Trailers overlay) — this page deliberately has no
// second map implementation. Data comes from the unified TrailerStateService
// endpoint (/trailer-state/current), the same single source of truth the
// Dispatch Map overlay consumes.
const STATUS_COLOR = { with_driver: '#22c55e', dropped: '#f59e0b', unknown: '#94a3b8' };

function fmt(iso) {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleString(); } catch { return String(iso); }
}

function Badge({ state }) {
  const s = (state && (state.possession_status || state.current_status)) || 'unknown';
  return (
    <span style={{ padding: '2px 8px', borderRadius: 10, fontSize: 12, fontWeight: 600, background: (STATUS_COLOR[s] || STATUS_COLOR.unknown) + '22', color: STATUS_COLOR[s] || STATUS_COLOR.unknown }}>
      {state ? displayTrailerStatus(state) : 'Unknown'}
    </span>
  );
}

export default function TrailerTrackingPage() {
  const { toast } = useApp();
  const [trailers, setTrailers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(null);
  const [detail, setDetail] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // Unified trailer state — single source of truth (TrailerStateService).
      const cur = await api('/trailer-state/current');
      setTrailers(cur.data || []);
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

  return (
    <div style={{ padding: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <h1 style={{ margin: 0 }}>Trailer Tracking <span style={{ fontSize: 13, color: '#f59e0b' }}>(Beta)</span></h1>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <span style={{ fontSize: 13, color: '#94a3b8' }}>Operational map: Dispatch Map → 🚚 Trailers</span>
          <button className="btn" onClick={load}>Refresh</button>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: selected ? '1fr 1fr' : '1fr', gap: 16, marginTop: 12 }}>
        <div style={{ overflowX: 'auto' }}>
          <table className="data-table">
            <thead>
              <tr><th>Unit</th><th>Status</th><th>Driver</th><th>Location</th><th>Condition</th><th>Reporter</th><th>Last event</th></tr>
            </thead>
            <tbody>
              {loading && <tr><td colSpan={7}>Loading…</td></tr>}
              {!loading && trailers.length === 0 && <tr><td colSpan={7} style={{ color: '#94a3b8' }}>No trailers tracked yet.</td></tr>}
              {trailers.map((t) => (
                <tr key={t.trailer_id} style={{ cursor: 'pointer' }} onClick={() => openTrailer(t.trailer_id)}>
                  <td><strong>{t.unit_number}</strong>{t.needs_review ? <span style={{ color: '#ef4444', marginLeft: 6, fontSize: 12 }}>• review</span> : null}</td>
                  <td><Badge state={t} /></td>
                  <td>{t.current_driver_name || '—'}</td>
                  <td>{t.location_text || '—'}</td>
                  <td>{t.condition_text || '—'}</td>
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
                <p style={{ margin: '8px 0' }}><Badge state={detail.status || {}} /></p>
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
