import React, { useState, useEffect } from 'react';
import { useApp } from '../store.jsx';
import { api, qs } from '../api';
import { useApi, Card, Modal, Field, StatusTag, Skeleton, EmptyState, ErrorState } from '../components.jsx';

export default function BrokersPage() {
  const { can, toast } = useApp();
  const [search, setSearch] = useState('');
  const [dq, setDq] = useState('');
  const [creating, setCreating] = useState(false);

  useEffect(() => { const t = setTimeout(() => setDq(search), 300); return () => clearTimeout(t); }, [search]);

  const q = useApi(`/brokers${qs({ search: dq })}`, [dq]);
  const dupes = useApi('/brokers/duplicates', []);
  const rows = (q.data && q.data.data) || [];
  const dupeRows = (dupes.data && dupes.data.data) || [];

  const refresh = () => { q.reload(); toast('Data refreshed'); };

  const deactivate = async (b) => {
    const reason = window.prompt(`Deactivate ${b.display_name}? Enter a reason:`);
    if (!reason) return;
    try { await api(`/brokers/${b.id}/deactivate`, { method: 'POST', body: { reason } }); toast('Broker deactivated'); q.reload(); }
    catch (ex) { toast(ex.message, 'error'); }
  };

  return (
    <div>
      <div className="toolbar">
        <div className="search-inline"><span className="ico">🔍</span><input placeholder="Search brokers..." value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search brokers" /></div>
        <div className="spacer" />
        <button className="btn" onClick={refresh}>Refresh displayed data</button>
        {can('brokers.manage') && <button className="btn primary" onClick={() => setCreating(true)}>+ Create</button>}
      </div>

      {dupeRows.length > 0 && (
        <div className="stale-banner">{dupeRows.length} possible duplicate broker{dupeRows.length === 1 ? '' : 's'} detected — review &amp; merge</div>
      )}

      <Card pad={false}>
        {q.loading ? <Skeleton rows={6} /> : q.error ? <ErrorState error={q.error} onRetry={q.reload} /> : rows.length === 0 ? (
          <EmptyState title={dq ? `No brokers match “${dq}”` : 'No brokers'} hint="Try a different search." />
        ) : (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead><tr>
                <th>Name / Identifier</th><th>Email</th><th>Address</th><th>Status</th><th>Actions</th>
              </tr></thead>
              <tbody>
                {rows.map((b) => (
                  <tr key={b.id}>
                    <td className="stack"><div className="a">{b.display_name}</div><div className="b">{b.mc_number ? `MC ${b.mc_number}` : '—'}</div></td>
                    <td>{b.email || '—'}</td>
                    <td>{b.address || '—'}</td>
                    <td><StatusTag status={b.status} /></td>
                    <td>
                      {can('brokers.manage') && b.status !== 'inactive' && <button className="btn sm" onClick={() => deactivate(b)}>Deactivate</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {creating && <CreateBroker onClose={() => setCreating(false)} onCreated={() => { setCreating(false); q.reload(); }} />}
    </div>
  );
}

const sel = { height: 34, borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', padding: '0 8px' };

function CreateBroker({ onClose, onCreated }) {
  const { toast } = useApp();
  const [f, setF] = useState({ display_name: '', legal_name: '', mc_number: '', email: '', phone_e164: '', address: '' });
  const [errs, setErrs] = useState({});
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true); setErrs({});
    try { await api('/brokers', { method: 'POST', body: f }); toast('Broker created'); onCreated(); }
    catch (ex) { setErrs(ex.fieldErrors || {}); toast(ex.message, 'error'); }
    finally { setBusy(false); }
  };
  return (
    <Modal title="Create Broker" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy} onClick={submit}>Create Broker</button></>}>
      <Field label="Display Name" required error={errs.display_name}><input value={f.display_name} onChange={(e) => setF({ ...f, display_name: e.target.value })} /></Field>
      <div className="grid-2">
        <Field label="Legal Name" error={errs.legal_name}><input value={f.legal_name} onChange={(e) => setF({ ...f, legal_name: e.target.value })} /></Field>
        <Field label="MC Number" error={errs.mc_number}><input value={f.mc_number} onChange={(e) => setF({ ...f, mc_number: e.target.value })} /></Field>
        <Field label="Email" error={errs.email}><input value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
        <Field label="Phone" error={errs.phone_e164}><input value={f.phone_e164} onChange={(e) => setF({ ...f, phone_e164: e.target.value })} placeholder="+13125551234" /></Field>
      </div>
      <Field label="Address" error={errs.address}><input value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} /></Field>
    </Modal>
  );
}
