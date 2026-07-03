import React, { useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useApp } from '../store.jsx';
import { api } from '../api';
import { Card, Field } from '../components.jsx';

const sel = { height: 34, borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', padding: '0 8px' };
const DEST = 'FleetView Support';
const CATEGORIES = ['Bug', 'Question', 'Billing', 'Other'];
const EMPTY = { category: 'Bug', subject: '', description: '', attach: true };

export default function SupportPage() {
  const { toast } = useApp();
  const loc = useLocation();
  const [f, setF] = useState(EMPTY);
  const [errs, setErrs] = useState({});
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  const set = (k, v) => setF((prev) => ({ ...prev, [k]: v }));

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setErrs({});
    try {
      const res = await api('/support/tickets', { method: 'POST', body: { category: f.category, subject: f.subject, description: f.description } });
      const data = (res && res.data) || res || {};
      setResult({ ticketNumber: data.ticketNumber, destination: data.destination });
    } catch (ex) {
      setErrs(ex.fieldErrors || {});
      toast(ex.message, 'error');
    } finally { setBusy(false); }
  };

  const reset = () => { setF(EMPTY); setErrs({}); setResult(null); };

  if (result) {
    return (
      <Card title="Support request submitted">
        <div className="state" role="status" style={{ textAlign: 'left' }}>
          <div className="big">✓ Ticket {result.ticketNumber || '—'} created</div>
          <div>Routed to {result.destination || DEST}. Our team will follow up by email.</div>
          <div style={{ marginTop: 12 }}><button className="btn primary" onClick={reset}>Submit another request</button></div>
        </div>
      </Card>
    );
  }

  return (
    <Card title="Contact Support">
      <form onSubmit={submit}>
        <Field label="Category" required>
          <select value={f.category} onChange={(e) => set('category', e.target.value)} style={{ ...sel, width: '100%' }}>
            {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </Field>
        <Field label="Subject" required error={errs.subject}>
          <input value={f.subject} onChange={(e) => set('subject', e.target.value)} maxLength={200} />
        </Field>
        <Field label="Description" required error={errs.description}>
          <textarea value={f.description} onChange={(e) => set('description', e.target.value)} maxLength={10000} />
        </Field>
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, margin: '6px 0 12px' }}>
          <input type="checkbox" checked={f.attach} onChange={(e) => set('attach', e.target.checked)} />
          Attach current page + correlation ID (excludes secrets)
        </label>
        <div style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 14 }}>
          This request goes to <b>{DEST}</b>.{f.attach ? ` Current page path (${loc.pathname}) and a correlation ID will be attached. No secrets or credentials are included.` : ' No diagnostic context will be attached.'}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="submit" className="btn primary" disabled={busy || !f.subject.trim() || !f.description.trim()}>Submit request</button>
          <button type="button" className="btn" onClick={reset}>Cancel</button>
        </div>
      </form>
    </Card>
  );
}
