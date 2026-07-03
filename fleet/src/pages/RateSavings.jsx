import React, { useState, useEffect, useMemo } from 'react';
import { useApp } from '../store.jsx';
import { api, qs } from '../api';
import { useApi, Card, Modal, Field, Segmented, StatusTag, Skeleton, EmptyState, ErrorState, FilterPopover, money, humanize } from '../components.jsx';

const sel = { height: 34, borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', padding: '0 8px' };

export default function RateSavings() {
  const { can } = useApp();
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [dq, setDq] = useState('');
  const [dispatcher, setDispatcher] = useState('');
  const [position, setPosition] = useState('');
  const [adjusting, setAdjusting] = useState(null);

  useEffect(() => { const t = setTimeout(() => setDq(search), 300); return () => clearTimeout(t); }, [search]);

  const q = useApi(`/reports/rate-savings${qs({ status })}`, [status]);
  const all = (q.data && q.data.data) || [];

  const dispatchers = useMemo(() => Array.from(new Set(all.map((r) => r.dispatcher_name).filter(Boolean))).sort(), [all]);
  const positions = useMemo(() => Array.from(new Set(all.map((r) => r.position).filter(Boolean))).sort(), [all]);

  const rows = all.filter((r) => {
    if (dq && !(`${r.driver_name} ${r.position}`.toLowerCase().includes(dq.toLowerCase()))) return false;
    if (dispatcher && r.dispatcher_name !== dispatcher) return false;
    if (position && r.position !== position) return false;
    return true;
  });
  const activeFilters = [dispatcher, position].filter(Boolean).length;

  return (
    <div>
      <div className="toolbar">
        <Segmented value={status} onChange={setStatus} options={[
          { value: '', label: 'All' }, { value: 'active', label: 'Active' }, { value: 'inactive', label: 'Inactive' },
        ]} />
        <div className="search-inline"><span className="ico">🔍</span><input placeholder="Search driver…" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search drivers" /></div>
        <FilterPopover active={activeFilters} onClear={() => { setDispatcher(''); setPosition(''); }}>
          <h4>Dispatcher</h4>
          <select value={dispatcher} onChange={(e) => setDispatcher(e.target.value)} style={{ ...sel, width: '100%', marginBottom: 8 }}>
            <option value="">All</option>{dispatchers.map((d) => <option key={d}>{d}</option>)}
          </select>
          <h4>Position</h4>
          <select value={position} onChange={(e) => setPosition(e.target.value)} style={{ ...sel, width: '100%' }}>
            <option value="">All</option>{positions.map((p) => <option key={p} value={p}>{humanize(p)}</option>)}
          </select>
          <div style={{ marginTop: 8, fontSize: 11, color: 'var(--text-3)' }}>Dispatcher/position/pickup-date filters are applied client-side.</div>
        </FilterPopover>
        <div className="spacer" />
        <span style={{ fontSize: 12, color: 'var(--text-3)' }}>Showing current pay period</span>
      </div>

      <Card pad={false}>
        {q.meta && q.meta.stale && <div className="stale-banner" style={{ margin: 12 }}>Showing cached data.</div>}
        {q.loading ? <Skeleton rows={6} /> : q.error ? <ErrorState error={q.error} onRetry={q.reload} /> : rows.length === 0 ? (
          <EmptyState title="No rate savings records" hint="Adjust filters or status to see drivers." />
        ) : (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead><tr>
                <th>Driver</th><th>Status</th><th>Position</th><th>Loads booked</th><th>Rate Savings</th><th>Manual adjustment</th><th>Final balance</th>
                {can('reports.adjust') && <th>Actions</th>}
              </tr></thead>
              <tbody>
                {rows.map((r) => {
                  const negative = r.rate_savings < 0;
                  return (
                    <tr key={r.driver_id}>
                      <td>{r.driver_name}</td>
                      <td><StatusTag status={r.status} /></td>
                      <td>{humanize(r.position)}</td>
                      <td>{r.loads_booked ?? 0}</td>
                      <td style={negative ? { color: 'var(--red)' } : undefined}>
                        {money(r.rate_savings)}{negative && r.savings_label ? ` · ${r.savings_label}` : ''}
                      </td>
                      <td>{money(r.manual_adjustment)}</td>
                      <td style={{ fontWeight: 600 }}>{money(r.final_balance)}</td>
                      {can('reports.adjust') && <td><button className="btn sm" onClick={() => setAdjusting(r)}>Adjust</button></td>}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {adjusting && <AdjustModal driver={adjusting} onClose={() => setAdjusting(null)} onSaved={() => { setAdjusting(null); q.reload(); }} />}
    </div>
  );
}

function AdjustModal({ driver, onClose, onSaved }) {
  const { toast } = useApp();
  const [f, setF] = useState({ amount: '', reason: '', effective_date: '' });
  const [errs, setErrs] = useState({});
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true); setErrs({});
    try {
      await api(`/reports/rate-savings/${driver.driver_id}/adjust`, { method: 'POST', body: { amount: Number(f.amount), reason: f.reason } });
      toast('Adjustment saved');
      onSaved();
    } catch (ex) {
      setErrs(ex.fieldErrors || {});
      toast(ex.message, 'error');
    } finally { setBusy(false); }
  };

  return (
    <Modal title={`Adjust — ${driver.driver_name}`} onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy || !f.reason.trim()} onClick={submit}>Save adjustment</button></>}>
      <Field label="Amount (cents)" error={errs.amount}>
        <input type="number" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} placeholder="e.g. -5000" />
      </Field>
      <Field label="Reason" required error={errs.reason}>
        <textarea value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} maxLength={2000} />
      </Field>
      <Field label="Effective date" error={errs.effective_date}>
        <input type="date" value={f.effective_date} onChange={(e) => setF({ ...f, effective_date: e.target.value })} style={{ ...sel, width: '100%' }} />
      </Field>
    </Modal>
  );
}
