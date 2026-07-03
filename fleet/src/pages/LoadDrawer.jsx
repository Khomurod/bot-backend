import React, { useState, useEffect } from 'react';
import { useApp } from '../store.jsx';
import { api } from '../api';
import { Drawer, Field, StatusTag, TimingTag, Skeleton, ErrorState, money, fmtTime } from '../components.jsx';

const NEXT = { upcoming: ['dispatched', 'canceled', 'rejected'], dispatched: ['in_transit', 'canceled', 'rejected'], in_transit: ['delivered'], canceled: ['upcoming'], rejected: ['upcoming'], delivered: [] };

export default function LoadDrawer({ id, onClose, onChanged }) {
  const { can, toast } = useApp();
  const [load, setLoad] = useState(null);
  const [err, setErr] = useState(null);
  const [edit, setEdit] = useState(false);
  const [form, setForm] = useState({});
  const [transitionTo, setTransitionTo] = useState('');
  const [reason, setReason] = useState('');

  const reload = () => api(`/loads/${id}`).then((r) => { setLoad(r.data); setForm({ hauling_rate: r.data.hauling_rate, assigned_rate: r.data.assigned_rate, planned_distance_miles: r.data.planned_distance_miles }); }).catch(setErr);
  useEffect(() => { reload(); /* eslint-disable-next-line */ }, [id]);

  const saveEdit = async () => {
    try {
      await api(`/loads/${id}`, { method: 'PATCH', body: { ...form, version: load.version } });
      toast('Load updated'); setEdit(false); await reload(); onChanged && onChanged();
    } catch (ex) { toast(ex.message, 'error'); }
  };

  const doTransition = async () => {
    const reopening = load.status === 'canceled' || load.status === 'rejected';
    if (reopening && !reason.trim()) { toast('Reason required to reopen', 'error'); return; }
    try {
      await api(`/loads/${id}/transition`, { method: 'POST', body: { to: transitionTo, reason, version: load.version } });
      toast(`Load moved to ${transitionTo}`); setTransitionTo(''); setReason(''); await reload(); onChanged && onChanged();
    } catch (ex) { toast(ex.message, 'error'); }
  };

  if (err) return <Drawer title="Load" onClose={onClose}><ErrorState error={err} /></Drawer>;
  if (!load) return <Drawer title="Load" onClose={onClose}><Skeleton rows={8} /></Drawer>;

  const savings = load.rate_savings;
  return (
    <Drawer title={`Load ${load.load_number}`} onClose={onClose} footer={
      <>
        {edit ? <><button className="btn" onClick={() => setEdit(false)}>Cancel</button><button className="btn primary" onClick={saveEdit}>Save changes</button></>
          : can('loads.update') && <button className="btn" onClick={() => setEdit(true)}>Edit load</button>}
      </>
    }>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 14 }}>
        <StatusTag status={load.status} /><TimingTag eta={load.eta} />
        {load.paperwork_state !== 'all_good' && <StatusTag status={load.paperwork_state} />}
      </div>

      <Row k="Trip #" v={load.trip_number} />
      <Row k="Route" v={`${load.origin_label} → ${load.destination_label}`} />
      <Row k="Broker" v={load.broker_name} />
      <Row k="Driver" v={load.driver_name} />
      <Row k="Dispatcher" v={load.dispatcher_name} />
      <Row k="Truck / Trailer" v={`${load.truck_unit || '—'} / ${load.trailer_unit || '—'}`} />

      {edit ? (
        <div style={{ marginTop: 8 }}>
          <div className="grid-2">
            <Field label="Hauling rate (¢)"><input type="number" value={form.hauling_rate} onChange={(e) => setForm({ ...form, hauling_rate: +e.target.value })} /></Field>
            <Field label="Assigned rate (¢)"><input type="number" value={form.assigned_rate} onChange={(e) => setForm({ ...form, assigned_rate: +e.target.value })} /></Field>
          </div>
          <Field label="Planned distance (mi)"><input type="number" value={form.planned_distance_miles} onChange={(e) => setForm({ ...form, planned_distance_miles: +e.target.value })} /></Field>
        </div>
      ) : (
        <>
          <Row k="Hauling rate" v={money(load.hauling_rate)} />
          <Row k="Assigned rate" v={money(load.assigned_rate)} />
          <Row k={savings < 0 ? 'Loss/Over assignment' : 'Rate savings'} v={<b style={{ color: savings < 0 ? 'var(--red)' : 'var(--green)' }}>{money(Math.abs(savings))}</b>} />
          <Row k="RPM" v={`$${load.rpm.toFixed(2)}`} />
          <Row k="Planned distance" v={`${load.planned_distance_miles} mi`} />
        </>
      )}

      {load.location && <Row k="Current location" v={<>{load.location.latitude.toFixed(3)}, {load.location.longitude.toFixed(3)} · <span style={{ color: load.location.freshness === 'stale' ? 'var(--amber)' : 'var(--text-3)' }}>{load.location.freshness === 'stale' ? 'Stale' : 'Fresh'} · {fmtTime(load.location.observed_at)}</span></>} />}
      {load.eta && <Row k="ETA" v={`${fmtTime(load.eta.eta_utc)} · ${load.eta.remaining_miles} mi remaining`} />}

      {load.stops && (
        <div style={{ marginTop: 14 }}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>Stops</div>
          {load.stops.map((s) => (
            <div key={s.id} style={{ padding: 8, border: '1px solid var(--border)', borderRadius: 6, marginBottom: 6, fontSize: 13 }}>
              <b>{s.sequence}. {s.type}</b> — {s.facility_name}<br /><span style={{ color: 'var(--text-3)' }}>{s.address}</span><br />
              <span style={{ color: 'var(--text-3)' }}>Appt: {fmtTime(s.appointment_start)}</span>
            </div>
          ))}
        </div>
      )}

      {can('loads.update_status') && !edit && (NEXT[load.status] || []).length > 0 && (
        <div style={{ marginTop: 16, padding: 12, border: '1px solid var(--border)', borderRadius: 6 }}>
          <div style={{ fontWeight: 600, marginBottom: 8 }}>Change status</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <select value={transitionTo} onChange={(e) => setTransitionTo(e.target.value)} aria-label="New status" style={{ height: 32, borderRadius: 6, border: '1px solid var(--border-strong)', background: 'var(--surface)', color: 'var(--text)' }}>
              <option value="">Select…</option>
              {NEXT[load.status].map((s) => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}
            </select>
            {(load.status === 'canceled' || load.status === 'rejected') && <input placeholder="Reason (required)" value={reason} onChange={(e) => setReason(e.target.value)} style={{ flex: 1, minWidth: 140, padding: '0 8px', borderRadius: 6, border: '1px solid var(--border-strong)', background: 'var(--surface)', color: 'var(--text)' }} />}
            <button className="btn primary sm" disabled={!transitionTo} onClick={doTransition}>Confirm</button>
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 6 }}>Illegal transitions are rejected by the server (409).</div>
        </div>
      )}
    </Drawer>
  );
}

function Row({ k, v }) {
  return <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid var(--border)', fontSize: 13 }}><span style={{ color: 'var(--text-2)' }}>{k}</span><span style={{ textAlign: 'right' }}>{v || '—'}</span></div>;
}
