import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApp } from '../store.jsx';
import { usePolledApi, Card, Segmented, Kpi, Skeleton, EmptyState, ErrorState, FreshnessBar, money } from '../components.jsx';

const sel = { height: 34, borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', padding: '0 8px' };

// Shared period controls → builds the ?period / ?from / ?to query the backend
// stats endpoints understand. Presets or an explicit custom range.
function usePeriod() {
  const [period, setPeriod] = useState('week');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const custom = from || to;
  const query = custom
    ? `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`
    : `period=${period}`;
  return { period, setPeriod, from, setFrom, to, setTo, custom, query };
}

function PeriodBar({ p }) {
  return (
    <div className="toolbar" style={{ gap: 10 }}>
      <Segmented value={p.custom ? '' : p.period} onChange={(v) => { p.setFrom(''); p.setTo(''); p.setPeriod(v); }} options={[
        { value: 'today', label: 'Today' },
        { value: 'week', label: 'This Week' },
        { value: 'month', label: 'This Month' },
        { value: '7d', label: 'Last 7d' },
      ]} />
      <label style={{ fontSize: 12, color: 'var(--text-3)' }}>From <input type="date" value={p.from} onChange={(e) => p.setFrom(e.target.value)} style={sel} /></label>
      <label style={{ fontSize: 12, color: 'var(--text-3)' }}>To <input type="date" value={p.to} onChange={(e) => p.setTo(e.target.value)} style={sel} /></label>
    </div>
  );
}

export default function Statistics() {
  const [report, setReport] = useState('gross');
  return (
    <div>
      <div className="toolbar">
        <Segmented value={report} onChange={setReport} options={[
          { value: 'gross', label: 'Gross Board' },
          { value: 'cancellations', label: 'Cancellations' },
          { value: 'rate', label: 'Rate Savings' },
        ]} />
      </div>
      {report === 'gross' && <GrossBoard />}
      {report === 'cancellations' && <Cancellations />}
      {report === 'rate' && <RateNote />}
    </div>
  );
}

// Gross Board — per-driver gross from real DataTruck orders. Gross counts
// delivered + in-transit + dispatched (loaded) loads over the chosen period.
function GrossBoard() {
  const p = usePeriod();
  const [search, setSearch] = useState('');
  const q = usePolledApi(`/reports/gross-board?${p.query}`, [p.query], { intervalMs: 120000 });

  const data = q.data || {};
  const summary = data.summary || {};
  const all = data.data || [];
  const rows = all.filter((d) => !search || `${d.name} ${d.dispatcher_name || ''}`.toLowerCase().includes(search.toLowerCase()));
  const rpm = (n) => (n == null ? '—' : `$${(n).toFixed(2)}`);

  return (
    <div>
      <PeriodBar p={p} />
      <FreshnessBar meta={q.meta} refreshing={q.refreshing} lastUpdated={q.lastUpdated} onRefresh={q.reload} />
      {q.loading ? <Skeleton rows={6} /> : q.error ? <ErrorState error={q.error} onRetry={q.reload} /> : (
        <>
          <div className="kpi-grid" style={{ marginBottom: 16 }}>
            <Kpi label="Total Gross" value={money(summary.total_gross)} />
            <Kpi label="Drivers" value={summary.drivers ?? '—'} />
            <Kpi label="Loads" value={summary.loads ?? '—'} />
            <Kpi label="Avg RPM" value={summary.avg_rpm != null ? `$${summary.avg_rpm.toFixed(2)}` : '—'} />
          </div>
          <div className="toolbar">
            <div className="search-inline"><span className="ico">🔍</span><input placeholder="Search driver / dispatcher…" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search gross board" /></div>
          </div>
          <Card pad={false}>
            {rows.length === 0 ? (
              <EmptyState title="No gross in this period" hint="No delivered, in-transit or dispatched loads found for the selected range. Adjust the period." />
            ) : (
              <div className="tbl-wrap">
                <table className="tbl">
                  <thead><tr><th>Driver</th><th>Dispatcher</th><th>Gross</th><th>RPM</th><th>Loads</th><th>Loaded / Delivered</th></tr></thead>
                  <tbody>
                    {rows.map((d) => (
                      <tr key={d.driver_id || d.name}>
                        <td><b>{d.name}</b></td>
                        <td>{d.dispatcher_name || '—'}</td>
                        <td>{money(d.gross)}</td>
                        <td>{rpm(d.rpm)}</td>
                        <td>{d.loads ?? 0}</td>
                        <td style={{ color: 'var(--text-2)' }}>{(d.in_transit + d.dispatched) || 0} loaded · {d.delivered || 0} delivered</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
          {data.meta && data.meta.note && <p style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 8 }}>{data.meta.note}</p>}
        </>
      )}
    </div>
  );
}

function Cancellations() {
  const p = usePeriod();
  const [search, setSearch] = useState('');
  const q = usePolledApi(`/reports/cancellations?${p.query}`, [p.query], { intervalMs: 120000 });

  const data = q.data || {};
  const summary = data.summary || {};
  const all = data.data || [];
  const rows = all.filter((l) => !search || `${l.load_number} ${l.driver_name} ${l.broker_name}`.toLowerCase().includes(search.toLowerCase()));

  return (
    <div>
      <PeriodBar p={p} />
      <FreshnessBar meta={q.meta} refreshing={q.refreshing} lastUpdated={q.lastUpdated} onRefresh={q.reload} />
      <div className="kpi-grid" style={{ marginBottom: 16 }}>
        <Kpi label="Dispatchers" value={summary.dispatcher_count ?? '—'} />
        <Kpi label="Canceled Loads" value={summary.canceled_load_count ?? '—'} />
      </div>
      <div className="toolbar">
        <div className="search-inline"><span className="ico">🔍</span><input placeholder="Search load, driver, broker…" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search canceled loads" /></div>
      </div>
      <Card pad={false}>
        {q.loading ? <Skeleton rows={6} /> : q.error ? <ErrorState error={q.error} onRetry={q.reload} /> : rows.length === 0 ? (
          <EmptyState title="No canceled loads in this period." hint="Adjust the period or search." />
        ) : (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead><tr><th>Load #</th><th>Driver</th><th>Broker</th><th>Dispatcher</th><th>Origin – Destination</th></tr></thead>
              <tbody>
                {rows.map((l) => (
                  <tr key={l.id || l.load_number}>
                    <td>{l.load_number}</td>
                    <td>{l.driver_name || '—'}</td>
                    <td>{l.broker_name || '—'}</td>
                    <td>{l.dispatcher_name || '—'}</td>
                    <td>{l.origin_label} → {l.destination_label}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

function RateNote() {
  const nav = useNavigate();
  const q = usePolledApi('/reports/rate-savings', [], { intervalMs: 0 });
  const note = q.meta && q.meta.note;
  return (
    <Card title="Rate Savings">
      <p style={{ color: 'var(--text-2)' }}>
        {note || 'Rate Savings compares each load’s booked hauling rate against the driver’s assigned/settlement rate.'}
      </p>
      <p style={{ color: 'var(--text-3)', fontSize: 13 }}>
        The driver settlement (assigned) rate is not exposed by the DataTruck order feed, so a savings figure cannot be computed yet.
        Once a settlement data source is connected this section will populate automatically.
      </p>
      <button className="btn" onClick={() => nav('/dashboard/rate-savings')}>Open Rate Savings page</button>
    </Card>
  );
}
