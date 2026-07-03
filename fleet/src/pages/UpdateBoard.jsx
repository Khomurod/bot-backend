import React, { useState, useEffect } from 'react';
import { useApp } from '../store.jsx';
import { api, qs } from '../api';
import { useApi, Card, Segmented, Modal, Field, StatusTag, TimingTag, Skeleton, EmptyState, ErrorState, fmtTime } from '../components.jsx';

const SEGS = [
  { value: 'active', label: 'Active loads' }, { value: 'paperwork', label: 'Paperwork issues' },
  { value: 'stationary', label: 'Stationary' }, { value: 'delayed', label: 'Delayed' }, { value: 'sleep', label: 'Sleep' },
];

export default function UpdateBoard() {
  const { can, toast } = useApp();
  const [segment, setSegment] = useState('active');
  const [search, setSearch] = useState('');
  const [dq, setDq] = useState('');
  const [selected, setSelected] = useState(new Set());
  const [note, setNote] = useState(null);
  const [lastSync, setLastSync] = useState('2026-07-03T17:59:50Z');

  useEffect(() => { const t = setTimeout(() => setDq(search), 300); return () => clearTimeout(t); }, [search]);
  const q = useApi(`/update-board${qs({ segment, search: dq })}`, [segment, dq]);
  const rows = (q.data && q.data.data) || [];

  const toggle = (id) => { const s = new Set(selected); s.has(id) ? s.delete(id) : s.add(id); setSelected(s); };
  const refreshDisplayed = () => { q.reload(); toast('Displayed data refreshed'); };

  return (
    <div>
      <div className="toolbar">
        <Segmented value={segment} onChange={setSegment} options={SEGS} />
        <div className="spacer" />
        <div className="search-inline"><span className="ico">🔍</span><input placeholder="Search by Unit, Driver, Load" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search update board" /></div>
        <button className="btn" onClick={refreshDisplayed} aria-label="Refresh displayed data">⟳ Refresh displayed data</button>
      </div>
      {selected.size > 0 && can('loads.update_status') && (
        <div className="stale-banner" style={{ background: 'var(--blue-soft)', color: 'var(--blue)', borderColor: 'var(--blue)' }}>
          {selected.size} selected · <button className="btn sm" style={{ marginLeft: 8 }} onClick={() => { toast('Bulk status update requires confirmation (demo)'); }}>Bulk add status</button>
          <button className="btn sm" style={{ marginLeft: 8 }} onClick={() => setSelected(new Set())}>Clear</button>
        </div>
      )}
      <div style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 8 }}>Last successful source update: {fmtTime(lastSync)} · This action only re-fetches displayed data (no upstream TMS/ELD sync).</div>

      <Card pad={false}>
        {q.loading ? <Skeleton rows={8} /> : q.error ? <ErrorState error={q.error} onRetry={q.reload} /> : rows.length === 0
          ? <EmptyState title="No units in this segment" hint="Switch segment or refresh." />
          : (
            <div className="tbl-wrap">
              <table className="tbl">
                <thead><tr>
                  <th><input type="checkbox" aria-label="Select all" checked={selected.size === rows.length} onChange={(e) => setSelected(e.target.checked ? new Set(rows.map((r) => r.id)) : new Set())} /></th>
                  <th></th><th>Dispatcher</th><th>Truck</th><th>Trailer</th><th>Driver</th><th>Current Load</th><th>Heading To</th><th>ETA/Timing</th><th>Sleep</th><th>Note</th><th>Truck Status</th><th>Actions</th>
                </tr></thead>
                <tbody>
                  {rows.map((l) => (
                    <tr key={l.id}>
                      <td><input type="checkbox" aria-label={`Select ${l.load_number}`} checked={selected.has(l.id)} onChange={() => toggle(l.id)} /></td>
                      <td>{l.pinned ? '📌' : ''}</td>
                      <td>{l.dispatcher_name || '—'}</td>
                      <td>{l.truck_unit || '—'}</td>
                      <td>{l.trailer_unit || '—'}</td>
                      <td>{l.driver_name || '—'}</td>
                      <td className="stack"><div className="a">{l.load_number}</div><div className="b">{l.origin_label} → {l.destination_label}</div></td>
                      <td>{l.destination_label}</td>
                      <td className="stack"><div className="a">{l.eta ? fmtTime(l.eta.eta_utc) : '—'}</div><div className="b"><TimingTag eta={l.eta} /></div></td>
                      <td>{l.eld_state && l.eld_state.sleep_timer_minutes > 0 ? `${Math.round(l.eld_state.sleep_timer_minutes / 60)}h` : '—'}</td>
                      <td><button className="btn sm" aria-label={`Add note to ${l.load_number}`} onClick={() => setNote(l)}>Add Note</button></td>
                      <td><StatusTag status={(l.eld_state && l.eld_state.connection_state) || 'disconnected'} label={l.eld_state ? undefined : 'No ELD'} /></td>
                      <td>
                        <div style={{ display: 'flex', gap: 4 }}>
                          {can('drivers.assign') && <button className="btn sm" aria-label={`Assign trailer for ${l.load_number}`} onClick={() => toast('Assign Trailer drawer (demo): lists available trailers + conflicts')}>Assign Trailer</button>}
                          <button className="btn sm" aria-label={`More actions for ${l.load_number}`} onClick={() => toast('More: named actions with confirmation')}>More</button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
      </Card>
      {note && <AddNote load={note} onClose={() => setNote(null)} />}
    </div>
  );
}

function AddNote({ load, onClose }) {
  const { toast } = useApp();
  const [text, setText] = useState('');
  const [visibility, setVisibility] = useState('internal');
  return (
    <Modal title={`Add note — ${load.load_number}`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!text.trim()} onClick={() => { toast('Note saved'); onClose(); }}>Save</button></>}>
      <Field label="Note"><textarea value={text} onChange={(e) => setText(e.target.value)} /></Field>
      <Field label="Visibility"><select value={visibility} onChange={(e) => setVisibility(e.target.value)} style={{ height: 34, borderRadius: 6, border: '1px solid var(--border-strong)', background: 'var(--surface)', color: 'var(--text)', padding: '0 8px' }}><option value="internal">Internal</option><option value="team">Team</option></select></Field>
    </Modal>
  );
}
