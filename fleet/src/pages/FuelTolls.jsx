import React, { useState, useEffect, useMemo } from 'react';
import { useApp } from '../store.jsx';
import { qs } from '../api';
import { useApi, Card, Modal, Segmented, Skeleton, EmptyState, ErrorState, fmtTime } from '../components.jsx';

const sel = { height: 34, borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', padding: '0 8px' };
const price = (n) => (n == null ? '—' : `$${(n / 100).toFixed(2)}`);

export default function FuelTolls() {
  const [tab, setTab] = useState('fuel');
  return (
    <div>
      <div className="toolbar">
        <Segmented value={tab} onChange={setTab} options={[
          { value: 'fuel', label: 'Fuel Prices' }, { value: 'tolls', label: 'Tolls' },
        ]} />
      </div>
      {tab === 'fuel' ? <FuelTab /> : <TollsTab />}
    </div>
  );
}

function FuelTab() {
  const { toast } = useApp();
  const [search, setSearch] = useState('');
  const [dq, setDq] = useState('');
  const [state, setState] = useState('');
  const [importing, setImporting] = useState(false);

  useEffect(() => { const t = setTimeout(() => setDq(search), 300); return () => clearTimeout(t); }, [search]);

  const q = useApi(`/fuel-prices${qs({ state, city: dq })}`, [state, dq]);
  const rows = (q.data && q.data.data) || [];
  const states = useMemo(() => Array.from(new Set(rows.map((r) => r.state).filter(Boolean))).sort(), [rows]);
  const first = rows[0];

  return (
    <div>
      <div className="toolbar">
        <div className="search-inline"><span className="ico">🔍</span><input placeholder="Search city…" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search fuel prices" /></div>
        <select value={state} onChange={(e) => setState(e.target.value)} aria-label="State filter" style={sel}>
          <option value="">All states</option>
          {states.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <div className="spacer" />
        <button className="btn" onClick={() => setImporting(true)}>Import</button>
      </div>

      <Card pad={false}>
        {q.loading ? <Skeleton rows={6} /> : q.error ? <ErrorState error={q.error} onRetry={q.reload} /> : rows.length === 0 ? (
          <EmptyState title="No fuel prices for the selected filters." hint="Adjust the state filter or search." />
        ) : (
          <>
            <div className="tbl-wrap">
              <table className="tbl">
                <thead><tr>
                  <th>State</th><th>City</th><th>Retail Price</th><th>Discounted Price</th><th>Saving Per Gallon</th><th>Effective Date</th>
                </tr></thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id}>
                      <td>{r.state}</td>
                      <td>{r.city}</td>
                      <td>{price(r.retail_price)}</td>
                      <td>{price(r.discounted_price)}</td>
                      <td>{price(r.saving_per_gallon)}</td>
                      <td>{fmtTime(r.effective_date)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {first && <div style={{ padding: '10px 12px', fontSize: 12, color: 'var(--text-3)', borderTop: '1px solid var(--border)' }}>Source: {first.source || '—'} · Last import: {fmtTime(first.effective_date)}</div>}
          </>
        )}
      </Card>

      {importing && (
        <Modal title="Import Fuel Prices" onClose={() => setImporting(false)} footer={<button className="btn" onClick={() => setImporting(false)}>Close</button>}>
          <p style={{ color: 'var(--text-2)' }}>Fuel price import pulls from the discount-network provider feed. This is a stub in the current build.</p>
        </Modal>
      )}
    </div>
  );
}

function TollsTab() {
  return (
    <Card>
      <EmptyState
        title="Tolls module not configured"
        hint="The original product exposed no toll UI. This module is intentionally unbuilt until toll business rules are defined."
      />
    </Card>
  );
}
