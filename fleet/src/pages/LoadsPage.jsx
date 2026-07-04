import React, { useState, useEffect } from 'react';
import { useApp } from '../store.jsx';
import { api, qs } from '../api';
import { useApi, Card, Kpi, Segmented, Modal, Field, StatusTag, TimingTag, Skeleton, EmptyState, ErrorState, FilterPopover, Pagination, money, fmtTime } from '../components.jsx';
import LoadDrawer from './LoadDrawer.jsx';

const SEGMENTS = ['upcoming', 'dispatched', 'in_transit', 'delivered', 'canceled', 'rejected', 'all'];
const sel = { height: 34, borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', padding: '0 8px', width: '100%', marginBottom: 8 };

export default function LoadsPage() {
  const { can } = useApp();
  const kpis = useApi('/loads/kpis');
  const [segment, setSegment] = useState('all');
  const [search, setSearch] = useState('');
  const [dq, setDq] = useState('');
  const [page, setPage] = useState(1);
  const [filters, setFilters] = useState({ dispatcher: '', driver: '', broker: '', paperwork: '', warning: '' });
  const [focus, setFocus] = useState(null);
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);

  useEffect(() => { const t = setTimeout(() => { setDq(search); setPage(1); }, 300); return () => clearTimeout(t); }, [search]);
  const q = useApi(`/loads${qs({ status: segment, search: dq, page, pageSize: 12, ...filters })}`, [segment, dq, page, JSON.stringify(filters)]);
  const brokers = useApi('/brokers', [], { enabled: can('brokers.read') });
  const drivers = useApi('/drivers', [], { enabled: can('drivers.read') });

  const k = kpis.data || {};
  const activeFilters = Object.values(filters).filter(Boolean).length;
  const rows = (q.data && q.data.data) || [];

  return (
    <div>
      <div className="kpi-grid" style={{ marginBottom: 16 }}>
        <Kpi label="Delayed" value={kpis.loading ? '…' : k.delayed} />
        <Kpi label="Exceptions" value={kpis.loading ? '…' : k.exceptions} />
        <Kpi label="In Transit" value={kpis.loading ? '…' : k.inTransit} />
        <Kpi label="Delivered" value={kpis.loading ? '…' : k.delivered} />
      </div>

      <div className="toolbar">
        <Segmented value={segment} onChange={(v) => { setSegment(v); setPage(1); }} options={SEGMENTS.map((s) => ({ value: s, label: s === 'all' ? 'All' : s.replace('_', ' ').replace(/\b\w/g, (c) => c.toUpperCase()) }))} />
        <div className="spacer" />
        <div className="search-inline"><span className="ico">🔍</span><input placeholder="Search" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search loads" /></div>
        <FilterPopover active={activeFilters} onClear={() => setFilters({ dispatcher: '', driver: '', broker: '', paperwork: '', warning: '' })}>
          <h4>Broker</h4>
          <select style={sel} value={filters.broker} onChange={(e) => setFilters({ ...filters, broker: e.target.value })}>
            <option value="">All</option>{(brokers.data && brokers.data.data || []).map((b) => <option key={b.id} value={b.id}>{b.display_name}</option>)}
          </select>
          <h4>Driver</h4>
          <select style={sel} value={filters.driver} onChange={(e) => setFilters({ ...filters, driver: e.target.value })}>
            <option value="">All</option>{(drivers.data && drivers.data.data || []).map((d) => <option key={d.id} value={d.id}>{d.display_name}</option>)}
          </select>
          <h4>Paperwork</h4>
          <select style={sel} value={filters.paperwork} onChange={(e) => setFilters({ ...filters, paperwork: e.target.value })}>
            <option value="">All</option><option value="document_missing">Document missing</option><option value="has_issue">Has issue</option><option value="all_good">All good</option>
          </select>
          <h4>Warnings</h4>
          <select style={sel} value={filters.warning} onChange={(e) => setFilters({ ...filters, warning: e.target.value })}>
            <option value="">None</option><option value="eld_not_connected">ELD not connected</option><option value="stationary">Stationary</option><option value="detention">Detention detected</option>
          </select>
        </FilterPopover>
        {can('loads.create') && <button className="btn primary" onClick={() => setCreating(true)}>+ Create</button>}
        {can('import.run') && <button className="btn" onClick={() => setImporting(true)}>Import</button>}
      </div>

      <Card pad={false}>
        {q.meta && q.meta.stale && <div className="stale-banner" style={{ margin: 12 }}>Showing cached data — last sync {fmtTime(q.meta.lastSuccessfulSyncAt)}</div>}
        {q.loading ? <Skeleton rows={8} /> : q.error ? <ErrorState error={q.error} onRetry={q.reload} /> : rows.length === 0
          ? <EmptyState title={dq ? `No loads match “${dq}”` : `No ${segment === 'all' ? '' : segment.replace('_', ' ')} loads`} hint="Adjust filters or create a load." />
          : (
            <>
              <div className="tbl-wrap">
                <table className="tbl">
                  <thead><tr><th></th><th>Trip # / Load #</th><th>Status</th><th>Driver</th><th>Dispatcher</th><th>Origin – Destination</th><th>Rate</th><th>ETA</th><th>Timing</th><th>Paperwork</th><th>Actions</th></tr></thead>
                  <tbody>
                    {rows.map((l) => (
                      <tr key={l.id} style={{ cursor: 'pointer' }} onClick={() => setFocus(l.id)}>
                        <td>{l.pinned ? '📌' : ''}</td>
                        <td className="stack"><div className="a">{l.trip_number}</div><div className="b">{l.load_number}</div></td>
                        <td><StatusTag status={l.status} /></td>
                        <td>{l.driver_name || '—'}</td><td>{l.dispatcher_name || '—'}</td>
                        <td>{l.origin_label} → {l.destination_label}</td>
                        <td className="stack"><div className="a">{money(l.hauling_rate)}</div><div className="b">RPM {l.rpm != null ? `$${l.rpm.toFixed(2)}` : '—'}</div></td>
                        <td>{l.eta ? fmtTime(l.eta.eta_utc) : '—'}</td>
                        <td><TimingTag eta={l.eta} /></td>
                        <td><StatusTag status={l.paperwork_state} /></td>
                        <td onClick={(e) => e.stopPropagation()}>
                          <button className="btn sm" aria-label={`View load ${l.load_number}`} onClick={() => setFocus(l.id)}>View load</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Pagination page={q.data.page} pageSize={q.data.pageSize} total={q.data.total} onPage={setPage} />
            </>
          )}
      </Card>

      {focus && <LoadDrawer id={focus} onClose={() => setFocus(null)} onChanged={() => { q.reload(); kpis.reload(); }} />}
      {creating && <CreateLoad brokers={brokers.data && brokers.data.data || []} drivers={drivers.data && drivers.data.data || []} onClose={() => setCreating(false)} onCreated={() => { setCreating(false); q.reload(); kpis.reload(); }} />}
      {importing && <ImportWizard onClose={() => setImporting(false)} onDone={() => { setImporting(false); q.reload(); }} />}
    </div>
  );
}

function CreateLoad({ brokers, drivers, onClose, onCreated }) {
  const { toast } = useApp();
  const [f, setF] = useState({ load_number: '', trip_number: '', broker_id: '', driver_id: '', hauling_rate: '', assigned_rate: '', origin_label: '', destination_label: '', status: 'upcoming' });
  const [errs, setErrs] = useState({});
  const [review, setReview] = useState(false);
  const submit = async () => {
    setErrs({});
    try {
      await api('/loads', { method: 'POST', body: { ...f, hauling_rate: Math.round((+f.hauling_rate || 0) * 100), assigned_rate: Math.round((+f.assigned_rate || 0) * 100) } });
      toast('Load created'); onCreated();
    } catch (ex) { setErrs(ex.fieldErrors || {}); setReview(false); toast(ex.message, 'error'); }
  };
  return (
    <Modal title={review ? 'Review load' : 'Create Load'} wide onClose={onClose} footer={
      review
        ? <><button className="btn" onClick={() => setReview(false)}>Back</button><button className="btn primary" onClick={submit}>Confirm & Create</button></>
        : <><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={() => setReview(true)} disabled={!f.load_number || !f.broker_id || !f.hauling_rate}>Review</button></>
    }>
      {review ? (
        <div style={{ fontSize: 14, lineHeight: 1.9 }}>
          <div>Load #: <b>{f.load_number}</b> · Trip: {f.trip_number || '—'}</div>
          <div>Broker: {(brokers.find((b) => b.id === f.broker_id) || {}).display_name}</div>
          <div>Driver: {(drivers.find((d) => d.id === f.driver_id) || {}).display_name || '—'}</div>
          <div>Route: {f.origin_label} → {f.destination_label}</div>
          <div>Hauling: ${f.hauling_rate} · Assigned: ${f.assigned_rate || 0}</div>
          <div>Status: {f.status}</div>
          <div style={{ marginTop: 8, color: 'var(--text-3)', fontSize: 12 }}>The server validates duplicate load number and assignment conflicts on confirm.</div>
        </div>
      ) : (
        <>
          <div className="grid-2">
            <Field label="Load number" required error={errs.load_number}><input value={f.load_number} onChange={(e) => setF({ ...f, load_number: e.target.value })} /></Field>
            <Field label="Trip / reference"><input value={f.trip_number} onChange={(e) => setF({ ...f, trip_number: e.target.value })} /></Field>
          </div>
          <Field label="Broker" required error={errs.broker_id}>
            <select value={f.broker_id} onChange={(e) => setF({ ...f, broker_id: e.target.value })} style={{ ...sel, marginBottom: 0 }}><option value="">Select…</option>{brokers.map((b) => <option key={b.id} value={b.id}>{b.display_name}</option>)}</select>
          </Field>
          <Field label="Driver">
            <select value={f.driver_id} onChange={(e) => setF({ ...f, driver_id: e.target.value })} style={{ ...sel, marginBottom: 0 }}><option value="">Unassigned</option>{drivers.map((d) => <option key={d.id} value={d.id}>{d.display_name}</option>)}</select>
          </Field>
          <div className="grid-2">
            <Field label="Hauling rate ($)" required error={errs.hauling_rate}><input type="number" value={f.hauling_rate} onChange={(e) => setF({ ...f, hauling_rate: e.target.value })} /></Field>
            <Field label="Assigned rate ($)"><input type="number" value={f.assigned_rate} onChange={(e) => setF({ ...f, assigned_rate: e.target.value })} /></Field>
          </div>
          <div className="grid-2">
            <Field label="Origin"><input value={f.origin_label} onChange={(e) => setF({ ...f, origin_label: e.target.value })} placeholder="Chicago, IL" /></Field>
            <Field label="Destination"><input value={f.destination_label} onChange={(e) => setF({ ...f, destination_label: e.target.value })} placeholder="Dallas, TX" /></Field>
          </div>
        </>
      )}
    </Modal>
  );
}

function ImportWizard({ onClose, onDone }) {
  const { toast } = useApp();
  const [step, setStep] = useState(1);
  const [rows, setRows] = useState([{ load_number: 'L90001', origin: 'Chicago, IL', destination: 'Denver, CO', hauling_rate: 250000 }]);
  const [preview, setPreview] = useState(null);
  const runPreview = async () => { try { const r = await api('/loads/imports/preview', { method: 'POST', body: { rows } }); setPreview(r); setStep(3); } catch (ex) { toast(ex.message, 'error'); } };
  const commit = async () => { try { const r = await api('/loads/imports/commit', { method: 'POST', body: { rows, idempotencyKey: 'demo-key-1' } }); toast(`Imported ${r.data.created} loads`); onDone(); } catch (ex) { toast(ex.message, 'error'); } };
  return (
    <Modal title="Import loads" wide onClose={onClose} footer={
      <>
        <button className="btn" onClick={onClose}>Cancel</button>
        {step === 1 && <button className="btn primary" onClick={() => setStep(2)}>Next: Map columns</button>}
        {step === 2 && <button className="btn primary" onClick={runPreview}>Validate & preview</button>}
        {step === 3 && <button className="btn primary" onClick={commit} disabled={!preview || preview.summary.valid === 0}>Confirm import ({preview ? preview.summary.valid : 0})</button>}
      </>
    }>
      <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>{['Upload', 'Map', 'Validate', 'Confirm'].map((s, i) => <span key={s} className={`tag ${step > i ? 'green' : step === i + 1 ? 'blue' : 'gray'}`}>{i + 1}. {s}</span>)}</div>
      {step === 1 && <div><p>Upload CSV/XLSX. For this demo a sample row is preloaded. Files are type/size checked and malware-scanned before processing.</p><input type="file" disabled /><p style={{ color: 'var(--text-3)', fontSize: 12 }}>Dry-run preview and a downloadable error report are provided before any data is written.</p></div>}
      {step === 2 && <div><p>Map spreadsheet columns to load fields (load_number, origin, destination, hauling_rate). Sample mapping applied.</p></div>}
      {step === 3 && preview && (
        <div>
          <p>{preview.summary.valid} valid / {preview.summary.invalid} invalid of {preview.summary.total} rows.</p>
          <table className="tbl"><thead><tr><th>Row</th><th>Load #</th><th>Result</th></tr></thead>
            <tbody>{preview.data.map((p) => <tr key={p.row}><td>{p.row}</td><td>{p.load_number}</td><td>{p.valid ? <span className="tag green">Valid</span> : <span className="tag red">{p.errors.join(', ')}</span>}</td></tr>)}</tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}
