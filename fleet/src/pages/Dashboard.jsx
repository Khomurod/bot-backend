import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApi, usePolledApi, Async, Kpi, Card, Segmented, StatusTag, TimingTag, Skeleton, EmptyState, ErrorState, FreshnessBar, Pagination, money, relTime, fmtTime } from '../components.jsx';
import { api, qs } from '../api';
import LoadDrawer from './LoadDrawer.jsx';

export default function Dashboard() {
  const nav = useNavigate();
  const summary = useApi('/dashboard/task-summary');
  const chart = useApi('/dashboard/task-chart');
  const [segment, setSegment] = useState('all');
  const [search, setSearch] = useState('');
  const [dq, setDq] = useState('');
  const [page, setPage] = useState(1);
  const [focus, setFocus] = useState(null);

  React.useEffect(() => { const t = setTimeout(() => { setDq(search); setPage(1); }, 300); return () => clearTimeout(t); }, [search]);
  // Cached snapshot read; auto-refreshes every 30s without blocking the UI.
  const loads = usePolledApi(`/dashboard/loads${qs({ segment, search: dq, page, pageSize: 10 })}`, [segment, dq, page], { intervalMs: 30000 });

  const s = summary.data || {};
  return (
    <div>
      <div className="kpi-grid" style={{ marginBottom: 16 }}>
        {summary.loading ? Array.from({ length: 4 }).map((_, i) => <div key={i} className="kpi"><div className="skel" style={{ height: 40 }} /></div>) : (
          <>
            <Kpi label="Done Tickets" value={s.doneTickets ?? '—'} onClick={() => nav('/dashboard/tasks?status=done')} />
            <Kpi label="High Priority Tickets" value={s.highPriorityTickets ?? '—'} onClick={() => nav('/dashboard/tasks?priority=high')} />
            <Kpi label="Unassigned Tickets" value={s.unassignedTickets ?? '—'} onClick={() => nav('/dashboard/tasks')} />
            <Kpi label="Today's Tickets" value={s.todaysTickets ?? '—'} onClick={() => nav('/dashboard/tasks')} />
          </>
        )}
      </div>

      <div style={{ marginBottom: 16 }}>
        <Card title="Tasks by Department">
          {chart.loading ? <Skeleton rows={4} /> : chart.error ? <ErrorState error={chart.error} onRetry={chart.reload} /> : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {(chart.data.data || []).map((d) => {
                const total = d.todo + d.inProgress + d.done || 1;
                return (
                  <div key={d.department} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <div style={{ width: 90, fontSize: 13, color: 'var(--text-2)' }}>{d.department}</div>
                    <div style={{ flex: 1, display: 'flex', height: 20, borderRadius: 4, overflow: 'hidden', background: 'var(--gray-soft)' }}>
                      <div style={{ width: `${d.todo / total * 100}%`, background: 'var(--text-3)' }} title={`To Do: ${d.todo}`} />
                      <div style={{ width: `${d.inProgress / total * 100}%`, background: 'var(--blue)' }} title={`In Progress: ${d.inProgress}`} />
                      <div style={{ width: `${d.done / total * 100}%`, background: 'var(--green)' }} title={`Done: ${d.done}`} />
                    </div>
                    <div style={{ width: 90, fontSize: 12, color: 'var(--text-3)', textAlign: 'right' }}>{d.todo}/{d.inProgress}/{d.done}</div>
                  </div>
                );
              })}
              <div style={{ fontSize: 12, color: 'var(--text-3)' }}>Legend: To Do · <span style={{ color: 'var(--blue)' }}>In Progress</span> · <span style={{ color: 'var(--green)' }}>Done</span></div>
            </div>
          )}
        </Card>
      </div>

      <Card title="Loads" pad={false} extra={
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <Segmented value={segment} onChange={(v) => { setSegment(v); setPage(1); }} options={[
            { value: 'all', label: 'All Loads' }, { value: 'dispatched', label: 'Dispatched' }, { value: 'in_transit', label: 'In Transit' },
          ]} />
          <div className="search-inline"><span className="ico">🔍</span><input placeholder="Search" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search loads" /></div>
        </div>
      }>
        <div style={{ padding: '4px 12px 0' }}><FreshnessBar meta={loads.meta} refreshing={loads.refreshing} lastUpdated={loads.lastUpdated} onRefresh={loads.reload} /></div>
        <LoadTable query={loads} onRow={setFocus} onPage={setPage} search={dq} />
      </Card>

      {focus && <LoadDrawer id={focus} onClose={() => setFocus(null)} onChanged={loads.reload} />}
    </div>
  );
}

export function LoadTable({ query, onRow, onPage, search }) {
  if (query.loading) return <Skeleton rows={6} />;
  if (query.error) return <ErrorState error={query.error} onRetry={query.reload} />;
  const rows = query.data.data || [];
  if (rows.length === 0) return <EmptyState title={search ? `No loads match “${search}”` : 'No loads for this filter'} hint="Try a different segment or clearing search." />;
  return (
    <>
      <div className="tbl-wrap">
        <table className="tbl">
          <thead><tr>
            <th aria-label="Pin"></th><th>Trip # / Load #</th><th>Status</th><th>Driver</th><th>Dispatcher</th>
            <th>Origin – Destination</th><th>Sleep</th><th>ETA</th><th>Timing</th><th>Last ETA</th><th>Actions</th>
          </tr></thead>
          <tbody>
            {rows.map((l) => (
              <tr key={l.id} style={{ cursor: 'pointer' }} onClick={() => onRow(l.id)}>
                <td>{l.pinned ? '📌' : ''}</td>
                <td className="stack"><div className="a">{l.trip_number}</div><div className="b">{l.load_number}</div></td>
                <td><StatusTag status={l.status} /></td>
                <td>{l.driver_name || '—'}</td>
                <td>{l.dispatcher_name || '—'}</td>
                <td>{l.origin_label} → {l.destination_label}</td>
                <td>{l.eld_state && l.eld_state.sleep_timer_minutes > 0 ? `${Math.round(l.eld_state.sleep_timer_minutes / 60)}h` : '—'}</td>
                <td className="stack"><div className="a">{l.eta ? fmtTime(l.eta.eta_utc) : '—'}</div><div className="b">{l.eta ? `${l.eta.remaining_miles} mi` : ''}</div></td>
                <td><TimingTag eta={l.eta} /></td>
                <td title={l.previous_eta ? `Calculated ${fmtTime(l.previous_eta.calculated_at)}` : ''}>{l.previous_eta ? fmtTime(l.previous_eta.eta_utc) : '—'}</td>
                <td onClick={(e) => e.stopPropagation()}>
                  <button className="btn sm" aria-label={`View load ${l.load_number}`} onClick={() => onRow(l.id)}>View load</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {onPage && <Pagination page={query.data.page} pageSize={query.data.pageSize} total={query.data.total} onPage={onPage} />}
    </>
  );
}
