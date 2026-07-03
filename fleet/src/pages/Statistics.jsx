import React, { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApp } from '../store.jsx';
import { api } from '../api';
import { useApi, Card, Modal, Field, Segmented, Kpi, Skeleton, EmptyState, ErrorState, money } from '../components.jsx';

const sel = { height: 34, borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', padding: '0 8px' };

export default function Statistics() {
  const [report, setReport] = useState('cancellations');
  return (
    <div>
      <div className="toolbar">
        <Segmented value={report} onChange={setReport} options={[
          { value: 'cancellations', label: 'Cancellations' },
          { value: 'gross', label: 'Gross Board' },
          { value: 'rate', label: 'Rate Savings' },
        ]} />
      </div>
      {report === 'cancellations' && <Cancellations />}
      {report === 'gross' && <GrossBoard />}
      {report === 'rate' && <RateNote />}
    </div>
  );
}

function Cancellations() {
  const q = useApi('/reports/cancellations');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [search, setSearch] = useState('');

  const data = q.data || {};
  const summary = data.summary || {};
  const all = data.data || [];
  const rows = all.filter((l) => {
    if (search && !`${l.load_number} ${l.driver_name} ${l.broker_name}`.toLowerCase().includes(search.toLowerCase())) return false;
    if (start && l.canceled_at && l.canceled_at < start) return false;
    if (end && l.canceled_at && l.canceled_at > end + 'T23:59:59') return false;
    return true;
  });

  return (
    <div>
      <div className="kpi-grid" style={{ marginBottom: 16 }}>
        <Kpi label="Dispatchers" value={summary.dispatcher_count ?? '—'} />
        <Kpi label="Canceled Loads" value={summary.canceled_load_count ?? '—'} />
      </div>
      <div className="toolbar">
        <div className="search-inline"><span className="ico">🔍</span><input placeholder="Search load, driver, broker…" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search canceled loads" /></div>
        <label style={{ fontSize: 12, color: 'var(--text-3)' }}>From <input type="date" value={start} onChange={(e) => setStart(e.target.value)} style={sel} /></label>
        <label style={{ fontSize: 12, color: 'var(--text-3)' }}>To <input type="date" value={end} onChange={(e) => setEnd(e.target.value)} style={sel} /></label>
      </div>
      <Card pad={false}>
        {q.loading ? <Skeleton rows={6} /> : q.error ? <ErrorState error={q.error} onRetry={q.reload} /> : rows.length === 0 ? (
          <EmptyState title="No canceled loads in range." hint="Adjust the date range or search." />
        ) : (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead><tr><th>Load #</th><th>Driver</th><th>Broker</th><th>Origin – Destination</th></tr></thead>
              <tbody>
                {rows.map((l) => (
                  <tr key={l.id || l.load_number}>
                    <td>{l.load_number}</td>
                    <td>{l.driver_name || '—'}</td>
                    <td>{l.broker_name || '—'}</td>
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

function GrossBoard() {
  const { can } = useApp();
  const q = useApi('/reports/gross-board');
  const [expanded, setExpanded] = useState(() => new Set());
  const [showTargets, setShowTargets] = useState(false);

  const data = q.data || {};
  const summary = data.summary || {};
  const targets = data.targets || {};
  const leads = data.data || [];

  const toggle = (key) => setExpanded((prev) => {
    const next = new Set(prev);
    next.has(key) ? next.delete(key) : next.add(key);
    return next;
  });

  const rpm = (n) => (n == null ? '—' : `$${(n / 100).toFixed(2)}`);

  return (
    <div>
      <div className="toolbar">
        <div className="spacer" />
        {can('reports.adjust') && <button className="btn" onClick={() => setShowTargets(true)}>Targets</button>}
      </div>

      {q.loading ? <Skeleton rows={6} /> : q.error ? <ErrorState error={q.error} onRetry={q.reload} /> : (
        <>
          <div className="kpi-grid" style={{ marginBottom: 16 }}>
            <Kpi label="Total Gross" value={money(summary.total_gross)} />
            <Kpi label="Dispatchers" value={summary.dispatchers ?? '—'} />
            <Kpi label="Drivers" value={summary.drivers ?? '—'} />
            <Kpi label="Loads" value={summary.loads ?? '—'} />
            <Kpi label="Avg Score" value={summary.avg_score ?? '—'} />
          </div>

          <Card pad={false}>
            {leads.length === 0 ? <EmptyState title="No gross board data" hint="No teams reported for this period." /> : (
              <div className="tbl-wrap">
                <table className="tbl">
                  <thead><tr><th>Team / Dispatcher / Driver</th><th>Gross</th><th>RPM</th><th>Loads</th><th>Score</th></tr></thead>
                  <tbody>
                    {leads.map((lead, li) => {
                      const lk = `l${lead.id ?? li}`;
                      const lExpanded = expanded.has(lk);
                      const dispatchers = lead.dispatchers || [];
                      return (
                        <React.Fragment key={lk}>
                          <tr style={{ cursor: 'pointer' }} onClick={() => toggle(lk)}>
                            <td><span style={{ display: 'inline-block', width: 16 }}>{lExpanded ? '▾' : '▸'}</span><b>{lead.name}</b></td>
                            <td>{money(lead.gross)}</td>
                            <td colSpan={3}></td>
                          </tr>
                          {lExpanded && dispatchers.map((d, di) => {
                            const dk = `${lk}-d${d.id ?? di}`;
                            const dExpanded = expanded.has(dk);
                            const drivers = d.drivers || [];
                            return (
                              <React.Fragment key={dk}>
                                <tr style={{ cursor: 'pointer', background: 'var(--gray-soft)' }} onClick={() => toggle(dk)}>
                                  <td style={{ paddingLeft: 24 }}><span style={{ display: 'inline-block', width: 16 }}>{dExpanded ? '▾' : '▸'}</span>{d.name}</td>
                                  <td>{money(d.gross)}</td>
                                  <td colSpan={3}></td>
                                </tr>
                                {dExpanded && drivers.map((dr, dri) => (
                                  <tr key={`${dk}-dr${dr.id ?? dri}`}>
                                    <td style={{ paddingLeft: 48, color: 'var(--text-2)' }}>{dr.name}</td>
                                    <td>{money(dr.gross)}</td>
                                    <td>{rpm(dr.rpm)}</td>
                                    <td>{dr.loads ?? 0}</td>
                                    <td>{dr.score ?? '—'}</td>
                                  </tr>
                                ))}
                              </React.Fragment>
                            );
                          })}
                        </React.Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </>
      )}

      {showTargets && <TargetsModal targets={targets} onClose={() => setShowTargets(false)} onSaved={() => { setShowTargets(false); q.reload(); }} />}
    </div>
  );
}

function TargetsModal({ targets, onClose, onSaved }) {
  const { toast } = useApp();
  // solo_gross/team_gross are cents; edited in dollars. rpm stored as integer (×100); edited as decimal.
  const [f, setF] = useState({
    solo_gross: targets.solo_gross != null ? String(targets.solo_gross / 100) : '10000',
    team_gross: targets.team_gross != null ? String(targets.team_gross / 100) : '15000',
    rpm: targets.rpm != null ? (targets.rpm / 100).toFixed(2) : '2.40',
  });
  const [errs, setErrs] = useState({});
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true); setErrs({});
    try {
      await api('/reports/targets', { method: 'PUT', body: {
        solo_gross: Math.round(Number(f.solo_gross) * 100),
        team_gross: Math.round(Number(f.team_gross) * 100),
        rpm: Math.round(Number(f.rpm) * 100),
      } });
      toast('Targets updated');
      onSaved();
    } catch (ex) {
      setErrs(ex.fieldErrors || {});
      toast(ex.message, 'error');
    } finally { setBusy(false); }
  };

  return (
    <Modal title="Gross Board Targets" onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy} onClick={submit}>Save targets</button></>}>
      <p style={{ fontSize: 12, color: 'var(--text-3)' }}>Defaults: Solo $10,000 · Team $15,000 · RPM 2.40</p>
      <Field label="Solo gross target ($)" error={errs.solo_gross}>
        <input type="number" value={f.solo_gross} onChange={(e) => setF({ ...f, solo_gross: e.target.value })} />
      </Field>
      <Field label="Team gross target ($)" error={errs.team_gross}>
        <input type="number" value={f.team_gross} onChange={(e) => setF({ ...f, team_gross: e.target.value })} />
      </Field>
      <Field label="RPM target ($/mi)" error={errs.rpm}>
        <input type="number" step="0.01" value={f.rpm} onChange={(e) => setF({ ...f, rpm: e.target.value })} />
      </Field>
    </Modal>
  );
}

function RateNote() {
  const nav = useNavigate();
  return (
    <Card title="Rate Savings">
      <p style={{ color: 'var(--text-2)' }}>The full rate savings breakdown lives on its own page, with per-driver adjustments and filters.</p>
      <button className="btn primary" onClick={() => nav('/dashboard/rate-savings')}>Open Rate Savings</button>
    </Card>
  );
}
