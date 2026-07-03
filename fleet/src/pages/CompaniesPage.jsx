import React, { useState, useEffect } from 'react';
import { useApp } from '../store.jsx';
import { api, qs } from '../api';
import { useApi, Card, Modal, Field, Skeleton, EmptyState, ErrorState } from '../components.jsx';

const sel = { height: 34, borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', padding: '0 8px' };
const TIMEZONES = ['America/Chicago', 'America/New_York', 'America/Denver', 'America/Los_Angeles'];

export default function CompaniesPage() {
  const { can, toast } = useApp();
  const [search, setSearch] = useState('');
  const [dq, setDq] = useState('');
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState(null);

  useEffect(() => { const t = setTimeout(() => setDq(search), 300); return () => clearTimeout(t); }, [search]);

  const q = useApi(`/companies${qs({ search: dq })}`, [dq]);
  const rows = (q.data && q.data.data) || [];

  return (
    <div>
      <div className="toolbar">
        <div className="search-inline"><span className="ico">🔍</span><input placeholder="Search companies..." value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search companies" /></div>
        <div className="spacer" />
        {can('settings.manage') && <button className="btn primary" onClick={() => setCreating(true)}>+ Create</button>}
      </div>

      {q.loading ? <Skeleton rows={6} /> : q.error ? <ErrorState error={q.error} onRetry={q.reload} /> : rows.length === 0 ? (
        <EmptyState title={dq ? `No companies match “${dq}”` : 'No companies'} hint="Try a different search." />
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 14 }}>
          {rows.map((c) => (
            <div className="card" key={c.id}>
              <div className="card-pad">
                <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 6 }}>{c.name}</div>
                <div style={{ fontSize: 13, color: 'var(--text-2)', lineHeight: 1.9 }}>
                  <div>MC: {c.mc_number || '—'} · ID {c.id}</div>
                  <div>📞 {c.phone_e164 || '—'}</div>
                  <div>✉ {c.email || '—'}</div>
                  <div>🕑 {c.timezone_iana || '—'}</div>
                  <div>📍 {[c.city, c.state].filter(Boolean).join(', ') || '—'}</div>
                </div>
                <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                  <button className="btn sm" onClick={() => setEditing(c)}>Edit</button>
                  <button className="btn sm" onClick={() => toast(`${c.name} deactivated`)}>Deactivate</button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {creating && <CompanyForm onClose={() => setCreating(false)} onSaved={() => { setCreating(false); q.reload(); }} />}
      {editing && <CompanyForm company={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); q.reload(); }} />}
    </div>
  );
}

function CompanyForm({ company, onClose, onSaved }) {
  const { toast } = useApp();
  const [f, setF] = useState({
    name: (company && company.name) || '', mc_number: (company && company.mc_number) || '',
    phone_e164: (company && company.phone_e164) || '', email: (company && company.email) || '',
    timezone_iana: (company && company.timezone_iana) || 'America/Chicago',
    city: (company && company.city) || '', state: (company && company.state) || '',
  });
  const [errs, setErrs] = useState({});
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true); setErrs({});
    try {
      await api(company ? `/companies/${company.id}` : '/companies', { method: company ? 'PATCH' : 'POST', body: f });
      toast(company ? 'Company updated' : 'Company created'); onSaved();
    } catch (ex) { setErrs(ex.fieldErrors || {}); toast(ex.message, 'error'); }
    finally { setBusy(false); }
  };
  return (
    <Modal title={company ? 'Edit Company' : 'Create Company'} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy} onClick={submit}>{company ? 'Save' : 'Create Company'}</button></>}>
      <Field label="Name" required error={errs.name}><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
      <div className="grid-2">
        <Field label="MC Number" error={errs.mc_number}><input value={f.mc_number} onChange={(e) => setF({ ...f, mc_number: e.target.value })} /></Field>
        <Field label="Phone" error={errs.phone_e164}><input value={f.phone_e164} onChange={(e) => setF({ ...f, phone_e164: e.target.value })} placeholder="+13125551234" /></Field>
        <Field label="Email" error={errs.email}><input value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
        <Field label="Timezone" error={errs.timezone_iana}>
          <select value={f.timezone_iana} onChange={(e) => setF({ ...f, timezone_iana: e.target.value })} style={{ ...sel, width: '100%' }}>{TIMEZONES.map((t) => <option key={t}>{t}</option>)}</select>
        </Field>
        <Field label="City" error={errs.city}><input value={f.city} onChange={(e) => setF({ ...f, city: e.target.value })} /></Field>
        <Field label="State" error={errs.state}><input value={f.state} onChange={(e) => setF({ ...f, state: e.target.value })} /></Field>
      </div>
      <div className="demo-hint">Geocode confirmation is optional and can be completed after saving.</div>
    </Modal>
  );
}
