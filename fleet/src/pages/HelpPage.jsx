import React, { useState, useMemo } from 'react';
import { Card, EmptyState } from '../components.jsx';

const ARTICLES = [
  {
    id: 'getting-started',
    title: 'Getting started',
    body: 'FleetView centralizes loads, tasks, drivers, and equipment for your carrier operation. Start on the Dashboard for a live view of active loads and open tickets, then use the left navigation to reach the Dispatch board, Tasks, and reports. Your visible menu items and actions depend on the permissions assigned to your role.',
  },
  {
    id: 'load-statuses',
    title: 'Understanding load statuses',
    body: 'A load moves through Upcoming → Dispatched → In Transit → Delivered. Canceled and Rejected are terminal states. Status is derived from the provider/ELD feed and dispatcher actions; when the imported provider state disagrees with the local assignment you may see a "Conflict" indicator, which means the two sources need reconciliation.',
  },
  {
    id: 'eta-timing',
    title: 'How ETA timing (Early/Late) is calculated',
    body: 'The ETA compares the projected arrival time against the appointment window. If the projected arrival is before the window it is flagged Early (blue); within tolerance it is On time (green); after the window it is Late (red). The projection uses remaining miles and current motion from the latest telemetry, so the timing label updates as new positions arrive.',
  },
  {
    id: 'managing-tasks',
    title: 'Managing tasks',
    body: 'Tasks are organized on a Kanban board across TODO, IN PROGRESS, and DONE columns, with an optional Archive column. Filter by department, priority, or label, and search by title. Open a task to change its status, add comments (use @ to mention teammates), and review linked chat or broker-mail history. Creating and archiving tasks require the appropriate permissions.',
  },
  {
    id: 'tenant-switching',
    title: 'Tenant & company switching',
    body: 'If your account has access to more than one company, use the company switcher to change the active tenant. Switching re-scopes every screen — loads, tasks, drivers, and reports all reflect the selected company. The active company is sent with each API request, so data never mixes across tenants.',
  },
  {
    id: 'data-freshness',
    title: 'Data freshness indicator',
    body: 'FleetView streams live updates when connected. If the connection degrades, screens fall back to the most recent cached snapshot and show a "Showing cached data" banner with the last successful sync time. When live updates resume, the banner clears automatically and figures refresh.',
  },
];

export default function HelpPage() {
  const [search, setSearch] = useState('');
  const [openId, setOpenId] = useState(null);

  const results = useMemo(() => {
    const t = search.trim().toLowerCase();
    if (!t) return ARTICLES;
    return ARTICLES.filter((a) => `${a.title} ${a.body}`.toLowerCase().includes(t));
  }, [search]);

  return (
    <div>
      <div className="toolbar">
        <div className="search-inline"><span className="ico">🔍</span><input placeholder="Search help articles…" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search help" /></div>
      </div>

      <Card title="Help & Documentation" pad={false}>
        {results.length === 0 ? (
          <EmptyState title={`No articles match “${search}”`} hint="Try a different keyword." />
        ) : (
          <div>
            {results.map((a) => {
              const open = openId === a.id;
              return (
                <div key={a.id} style={{ borderBottom: '1px solid var(--border)' }}>
                  <button
                    className="btn"
                    style={{ width: '100%', textAlign: 'left', border: 'none', background: 'transparent', padding: '12px 14px', fontWeight: 600 }}
                    aria-expanded={open}
                    onClick={() => setOpenId(open ? null : a.id)}
                  >
                    <span style={{ display: 'inline-block', width: 16, color: 'var(--text-3)' }}>{open ? '▾' : '▸'}</span>{a.title}
                  </button>
                  {open && <div style={{ padding: '0 14px 14px 44px', color: 'var(--text-2)', lineHeight: 1.5 }}>{a.body}</div>}
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
}
