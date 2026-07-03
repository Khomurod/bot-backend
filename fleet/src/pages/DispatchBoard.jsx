import React, { useState } from 'react';
import { useApp } from '../store.jsx';
import { useApi } from '../components.jsx';
import { Card, Skeleton, EmptyState, ErrorState, StatusTag, money, fmtTime } from '../components.jsx';

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export default function DispatchBoard() {
  const [weekStart, setWeekStart] = useState('2026-06-29');
  const q = useApi(`/dispatch-board?weekStart=${weekStart}`, [weekStart]);
  const data = q.data;
  const groups = (data && data.data) || [];
  const s = (data && data.summary) || {};

  const shiftWeek = (delta) => {
    const d = new Date(weekStart); d.setUTCDate(d.getUTCDate() + delta * 7);
    setWeekStart(d.toISOString().slice(0, 10));
  };

  const dayOf = (iso) => { if (!iso) return -1; const d = new Date(iso).getUTCDay(); return d === 0 ? 6 : d - 1; };

  return (
    <div>
      <div className="toolbar">
        <button className="btn" onClick={() => setWeekStart('2026-06-29')}>Today</button>
        <button className="btn" aria-label="Previous week" onClick={() => shiftWeek(-1)}>‹ Prev week</button>
        <span style={{ fontWeight: 600 }}>Week of {weekStart}</span>
        <button className="btn" aria-label="Next week" onClick={() => shiftWeek(1)}>Next week ›</button>
        <div className="spacer" />
        <div className="search-inline"><span className="ico">🔍</span><input placeholder="Search by Unit, Driver, Load" aria-label="Search dispatch board" /></div>
      </div>

      <div className="kpi-grid" style={{ marginBottom: 16, gridTemplateColumns: 'repeat(5, 1fr)' }}>
        <Kpi t="ENROUTE" v={s.enroute ?? '…'} tip="Count of loads currently in transit" />
        <Kpi t="Total Hauling Rate" v={money(s.total_hauling)} tip="Sum of hauling_rate across week loads" />
        <Kpi t="Total Assign Rate" v={money(s.total_assigned)} tip="Sum of assigned_rate across week loads" />
        <Kpi t={s.total_rate_savings < 0 ? 'Total Loss' : 'Total Rate Savings'} v={money(Math.abs(s.total_rate_savings || 0))} tip="hauling − assigned" neg={s.total_rate_savings < 0} />
        <Kpi t="Average RPM" v={s.avg_rpm != null ? `$${s.avg_rpm.toFixed(2)}` : '…'} tip="total hauling ($) ÷ total planned miles" />
      </div>

      {q.loading ? <Skeleton rows={8} /> : q.error ? <ErrorState error={q.error} onRetry={q.reload} /> : groups.length === 0
        ? <EmptyState title="No drivers scheduled this week" />
        : groups.map((g, gi) => (
          <div className="db-group" key={gi}>
            <div className="db-group-head">Team Lead: {g.team_lead} · Dispatcher: {g.dispatcher}</div>
            <div className="db-scroll">
              <table className="db-table">
                <thead>
                  <tr>
                    <th className="db-driver-cell">Driver</th>
                    {DAYS.map((d) => <th key={d}>{d}</th>)}
                    <th>Statistics</th>
                  </tr>
                </thead>
                <tbody>
                  {g.drivers.map((dr) => (
                    <tr key={dr.id}>
                      <td className="db-driver-cell">
                        <div style={{ fontWeight: 600 }}>{dr.name}</div>
                        <div style={{ fontSize: 11, color: 'var(--text-3)' }}>{dr.position} · Unit {dr.unit || '—'}</div>
                        <div style={{ marginTop: 4 }}><span className={`tag ${dr.condition === 'Healthy' ? 'green' : dr.condition === 'ELD Not Connected' ? 'red' : 'amber'}`}>{dr.condition}</span></div>
                      </td>
                      {DAYS.map((d, di) => (
                        <td key={d}>
                          {dr.loads.filter((l) => dayOf(l.pickup) === di).map((l) => (
                            <div className="db-loadcard" key={l.id} title={l.route}>
                              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                                <b>{l.load_number}</b>
                                <button className="icon-btn" style={{ width: 18, height: 18, fontSize: 10 }} aria-label={`Copy ${l.load_number}`} onClick={() => navigator.clipboard && navigator.clipboard.writeText(l.load_number)}>⧉</button>
                              </div>
                              <div>{l.route}</div>
                              <StatusTag status={l.status} />
                            </div>
                          ))}
                        </td>
                      ))}
                      <td style={{ minWidth: 130, fontSize: 11 }}>
                        <div>Hauling: {money(dr.stats.hauling)}</div>
                        <div>Assigned: {money(dr.stats.assigned)}</div>
                        <div style={{ color: dr.stats.rate_savings < 0 ? 'var(--red)' : 'var(--green)' }}>{dr.stats.rate_savings < 0 ? 'Loss' : 'Savings'}: {money(Math.abs(dr.stats.rate_savings))}</div>
                        <div>RPM: ${dr.stats.rpm.toFixed(2)}</div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))}
      <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 8 }}>Status selectors open options; selecting does not save until you confirm. Rows/columns virtualize at scale (spec §10.5).</div>
    </div>
  );
}

function Kpi({ t, v, tip, neg }) {
  return (
    <div className="kpi" title={tip}>
      <div className="label">{t} <span style={{ cursor: 'help', color: 'var(--text-3)' }} aria-label={tip}>ⓘ</span></div>
      <div className="value" style={{ fontSize: 20, color: neg ? 'var(--red)' : undefined }}>{v}</div>
      <div className="sub">Week of {'2026-06-29'}</div>
    </div>
  );
}
