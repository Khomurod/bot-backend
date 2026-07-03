import React, { useState, useEffect } from 'react';
import { useApp } from '../store.jsx';
import { api, qs } from '../api';
import { useApi, Card, StatusTag, Skeleton, EmptyState, ErrorState, FilterPopover, humanize } from '../components.jsx';

const sel = { height: 34, borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', padding: '0 8px' };

export default function DriversPage() {
  const { can, toast } = useApp();
  const [search, setSearch] = useState('');
  const [dq, setDq] = useState('');
  const [dispatcher, setDispatcher] = useState('');

  useEffect(() => { const t = setTimeout(() => setDq(search), 300); return () => clearTimeout(t); }, [search]);

  const q = useApi(`/drivers${qs({ search: dq, dispatcher })}`, [dq, dispatcher]);
  const rows = (q.data && q.data.data) || [];

  const refresh = () => { q.reload(); toast('Data refreshed'); };

  const deactivate = async (d) => {
    const reason = window.prompt(`Deactivate ${d.display_name}? Enter a reason:`);
    if (!reason) return;
    try { await api(`/drivers/${d.id}/deactivate`, { method: 'POST', body: { reason } }); toast('Driver deactivated'); q.reload(); }
    catch (ex) { toast(ex.message, 'error'); }
  };

  return (
    <div>
      <div className="toolbar">
        <div className="search-inline"><span className="ico">🔍</span><input placeholder="Search drivers..." value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search drivers" /></div>
        <FilterPopover active={dispatcher ? 1 : 0} onClear={() => setDispatcher('')}>
          <h4>Dispatcher</h4>
          <input value={dispatcher} onChange={(e) => setDispatcher(e.target.value)} placeholder="Filter by dispatcher name" style={{ ...sel, width: '100%' }} />
        </FilterPopover>
        <div className="spacer" />
        <button className="btn" onClick={refresh}>Refresh</button>
        {can('drivers.manage') && <button className="btn primary" onClick={() => toast('Driver create coming soon')}>+ Create</button>}
      </div>

      <Card pad={false}>
        {q.loading ? <Skeleton rows={6} /> : q.error ? <ErrorState error={q.error} onRetry={q.reload} /> : rows.length === 0 ? (
          <EmptyState title={dq ? `No drivers match “${dq}”` : 'No drivers'} hint="Try a different search or clearing filters." />
        ) : (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead><tr>
                <th>Name / Position</th><th>Truck</th><th>Phone / Email</th><th>Dispatcher</th><th>Hired Company</th><th>Status</th><th>Actions</th>
              </tr></thead>
              <tbody>
                {rows.map((d) => (
                  <tr key={d.id}>
                    <td className="stack"><div className="a">{d.display_name}</div><div className="b">{humanize(d.position) || '—'}</div></td>
                    <td>{d.truck_unit || '—'}</td>
                    <td className="stack"><div className="a">{d.phone_e164 || '—'}</div><div className="b">{d.email || '—'}</div></td>
                    <td>{d.dispatcher_name || '—'}</td>
                    <td>{d.hired_company_name || '—'}</td>
                    <td><StatusTag status={d.status} /></td>
                    <td>
                      {can('drivers.manage') && d.status !== 'inactive' && <button className="btn sm" onClick={() => deactivate(d)}>Deactivate</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <div className="demo-hint">Per data-retention rules, drivers are never hard-deleted — Delete becomes Deactivate.</div>
    </div>
  );
}
