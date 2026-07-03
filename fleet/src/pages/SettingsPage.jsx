import React, { useState } from 'react';
import { useApp } from '../store.jsx';
import { api } from '../api';
import { useApi, Card, Modal, Field, StatusTag, Skeleton, EmptyState, ErrorState, fmtTime } from '../components.jsx';

const SECTIONS = [
  { key: 'general', label: 'General Settings' },
  { key: 'bot', label: 'Bot Settings' },
  { key: 'integrations', label: 'Integrations' },
  { key: 'roles', label: 'Role Management' },
  { key: 'labels', label: 'Task Settings' },
  { key: 'platform', label: 'Platform Notifications' },
  { key: 'email', label: 'Email Settings' },
];

export default function SettingsPage() {
  const { can } = useApp();
  const [section, setSection] = useState('general');
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '220px 1fr', gap: 16, alignItems: 'start' }}>
      <Card pad={false}>
        <div style={{ padding: 6 }}>
          {SECTIONS.map((s) => (
            <div key={s.key} className={`nav-item${section === s.key ? ' active' : ''}`} role="button" tabIndex={0}
              onClick={() => setSection(s.key)} onKeyDown={(e) => { if (e.key === 'Enter') setSection(s.key); }} style={{ borderRadius: 6 }}>
              {s.label}
            </div>
          ))}
        </div>
      </Card>
      <div>
        {section === 'general' && <GeneralSettings />}
        {section === 'bot' && <BotSettings />}
        {section === 'integrations' && <Integrations />}
        {section === 'roles' && <RoleManagement />}
        {section === 'labels' && <TaskLabels />}
        {section === 'platform' && <PlatformNotifications />}
        {section === 'email' && <EmailSettings />}
      </div>
    </div>
  );
}

function GeneralSettings() {
  const { toast, can } = useApp();
  const q = useApi('/settings/general');
  const [edit, setEdit] = useState(false);
  const [form, setForm] = useState(null);
  const [errs, setErrs] = useState({});
  const [confirm, setConfirm] = useState(false);
  const s = q.data && q.data.data;
  React.useEffect(() => { if (s && !form) setForm({ ...s }); }, [s]);

  const save = async () => {
    setErrs({});
    try { await api('/settings/general', { method: 'PUT', body: form }); toast('Settings saved'); setEdit(false); setConfirm(false); q.reload(); }
    catch (ex) { setErrs(ex.fieldErrors || {}); setConfirm(false); toast(ex.message, 'error'); }
  };

  if (q.loading || !form) return <Card title="General Settings"><Skeleton rows={4} /></Card>;
  if (q.error) return <Card title="General Settings"><ErrorState error={q.error} onRetry={q.reload} /></Card>;
  return (
    <Card title="General Settings" extra={can('settings.manage') && (edit
      ? <span style={{ display: 'flex', gap: 8 }}><button className="btn sm" onClick={() => { setEdit(false); setForm({ ...s }); }}>Cancel</button><button className="btn primary sm" onClick={() => setConfirm(true)}>Save</button></span>
      : <button className="btn sm" onClick={() => setEdit(true)}>Edit</button>)}>
      <div className="grid-2">
        <Field label="Check-in Radius (miles, 0.1–5.0)" error={errs.check_in_radius_miles}>
          <input type="number" step="0.1" disabled={!edit} value={form.check_in_radius_miles} onChange={(e) => setForm({ ...form, check_in_radius_miles: +e.target.value })} />
        </Field>
        <Field label="ELD inspection expiration (days)">
          <input type="number" disabled={!edit} value={form.eld_inspection_expiration_days} onChange={(e) => setForm({ ...form, eld_inspection_expiration_days: +e.target.value })} />
        </Field>
        <Field label="Detention threshold (minutes)">
          <input type="number" disabled={!edit} value={form.detention_threshold_minutes} onChange={(e) => setForm({ ...form, detention_threshold_minutes: +e.target.value })} />
        </Field>
        <Field label="Automatically create detention task">
          <select disabled={!edit} value={String(form.auto_create_detention_task)} onChange={(e) => setForm({ ...form, auto_create_detention_task: e.target.value === 'true' })} style={selS}>
            <option value="true">Enabled</option><option value="false">Disabled</option>
          </select>
        </Field>
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-3)' }}>Version {form.version} · Updated {fmtTime(form.updated_at)}. High-impact settings do not autosave.</div>
      {confirm && (
        <Modal title="Confirm settings change" onClose={() => setConfirm(false)} footer={<><button className="btn" onClick={() => setConfirm(false)}>Cancel</button><button className="btn primary" onClick={save}>Confirm & Save</button></>}>
          <p>Review before/after. Changing detention threshold or check-in radius affects automated detention tasks and check-in geofencing.</p>
          <table className="tbl"><thead><tr><th>Field</th><th>Before</th><th>After</th></tr></thead><tbody>
            {['check_in_radius_miles', 'eld_inspection_expiration_days', 'detention_threshold_minutes', 'auto_create_detention_task'].map((k) => (
              <tr key={k}><td>{k}</td><td>{String(s[k])}</td><td>{String(form[k])}</td></tr>
            ))}
          </tbody></table>
        </Modal>
      )}
    </Card>
  );
}

function BotSettings() {
  const [seg, setSeg] = useState('permissions');
  const perms = useApi('/settings/bot/permissions', [], { enabled: seg === 'permissions' });
  const logs = useApi('/settings/bot/logs', [], { enabled: seg === 'logs' });
  return (
    <Card title="Bot Settings" extra={
      <div className="segmented">
        {[['authorization', 'Authorization'], ['logs', 'Bot Logs'], ['permissions', 'Permissions'], ['quick', 'Quick Actions'], ['notifications', 'Notifications']].map(([k, l]) => (
          <button key={k} className={seg === k ? 'active' : ''} onClick={() => setSeg(k)}>{l}</button>
        ))}
      </div>
    }>
      {seg === 'authorization' && (
        <div>
          <div className="segmented" style={{ marginBottom: 12 }}><button className="active">Driver Group</button><button>Internal Group</button></div>
          <button className="btn primary sm">Connect Telegram Group</button>
          <table className="tbl" style={{ marginTop: 12 }}><thead><tr><th>Group</th><th>Status</th><th>Actions</th></tr></thead>
            <tbody><tr><td>Drivers — Main</td><td><StatusTag status="active" /></td><td><button className="btn sm">More</button></td></tr></tbody>
          </table>
        </div>
      )}
      {seg === 'logs' && (logs.loading ? <Skeleton rows={4} /> : (
        <table className="tbl"><thead><tr><th>Time</th><th>Event</th><th>Actor</th><th>Message</th><th>Status</th><th>Correlation</th></tr></thead>
          <tbody>{(logs.data && logs.data.data || []).map((l) => <tr key={l.id}><td>{fmtTime(l.timestamp)}</td><td>{l.event_type}</td><td>{l.actor}</td><td>{l.message}</td><td><StatusTag status={l.status === 'ok' ? 'active' : 'error'} label={l.status} /></td><td style={{ fontFamily: 'monospace', fontSize: 11 }}>{l.correlation_id}</td></tr>)}</tbody>
        </table>
      ))}
      {seg === 'permissions' && (perms.loading ? <Skeleton rows={4} /> : (
        <div>{(perms.data && perms.data.data || []).map((p) => (
          <div key={p.key} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
            <span>{p.label}</span>
            <span>{p.enabled ? <StatusTag status="active" label="Enabled" /> : <span className="tag gray">Disabled{p.restriction ? ` (${p.restriction})` : ''}</span>}</span>
          </div>
        ))}</div>
      ))}
      {seg === 'quick' && <div><p>Quick actions define driver-facing buttons (Button Title + Note).</p><button className="btn primary sm">Create quick action</button><div style={{ marginTop: 8, fontSize: 13, color: 'var(--text-3)' }}>Preview shows exactly what drivers will see before saving.</div></div>}
      {seg === 'notifications' && (
        <div>{['ETA Update', 'Load Assignment', 'Accept', 'Resend Document', 'Paperwork Issue', 'Wake Up Call', 'Mark As Delivered', 'Stationary Driver', 'Check-in / Check-out'].map((n) => (
          <div key={n} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--border)' }}><span>{n}</span><span className="tag gray">Driver Group · Internal Team</span></div>
        ))}<div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 8 }}>Templates use validated variables with a sample-data preview. No executable template code.</div></div>
      )}
    </Card>
  );
}

function Integrations() {
  const { toast, can } = useApp();
  const q = useApi('/settings/integrations');
  const rows = (q.data && q.data.data) || [];
  const [seg, setSeg] = useState('tms');
  const act = async (type, action) => { try { await api(`/settings/integrations/${type}/${action}`, { method: 'POST', body: {} }); toast(`${action} complete`); q.reload(); } catch (ex) { toast(ex.message, 'error'); } };
  const typeMap = { tms: 'tms', 'call center': 'ringcentral', email: 'email', eld: 'eld' };
  const shown = rows.filter((r) => r.type === typeMap[seg] || (seg === 'tms' && r.type === 'telegram'));
  return (
    <Card title="Integrations" extra={<div className="segmented">{['tms', 'call center', 'email', 'eld'].map((s) => <button key={s} className={seg === s ? 'active' : ''} onClick={() => setSeg(s)}>{s.toUpperCase()}</button>)}</div>}>
      {q.loading ? <Skeleton rows={4} /> : q.error ? <ErrorState error={q.error} onRetry={q.reload} /> : shown.length === 0 ? <EmptyState title="No integrations of this type" /> : shown.map((i) => (
        <div key={i.id} className="card card-pad" style={{ marginBottom: 10 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <div style={{ fontWeight: 600 }}>{i.provider} <span className="tag gray">{i.masked_account_label}</span></div>
              <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 4 }}>Last health check {fmtTime(i.last_health_check_at)} · Last sync {fmtTime(i.last_successful_sync_at)}</div>
              {i.error_message && <div style={{ fontSize: 12, color: 'var(--amber)' }}>{i.error_message}</div>}
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <StatusTag status={i.state} />
              {can('integrations.manage') && <>
                <button className="btn sm" onClick={() => act(i.type, 'health-check')}>Health check</button>
                {i.state !== 'disconnected' && <button className="btn sm danger" onClick={() => window.confirm('Disconnect? This stops the named data flows.') && act(i.type, 'disconnect')}>Disconnect</button>}
              </>}
            </div>
          </div>
        </div>
      ))}
      <div style={{ fontSize: 12, color: 'var(--text-3)' }}>Credentials are encrypted at rest and never returned to the browser after creation.</div>
    </Card>
  );
}

function RoleManagement() {
  const q = useApi('/settings/roles');
  const rows = (q.data && q.data.data) || [];
  return (
    <Card title="Role Management" extra={<button className="btn sm">Create Role</button>}>
      {q.loading ? <Skeleton rows={4} /> : q.error ? <ErrorState error={q.error} onRetry={q.reload} /> : (
        <table className="tbl"><thead><tr><th>Name</th><th>Permission count</th><th>Actions</th></tr></thead>
          <tbody>{rows.map((r) => <tr key={r.id}><td>{r.name}{r.system && <span className="tag blue" style={{ marginLeft: 6 }}>system</span>}</td><td>{r.permission_count}</td><td><button className="btn sm" disabled={r.system}>Edit</button></td></tr>)}</tbody>
        </table>
      )}
      <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 8 }}>Roles assigned to users or required system roles cannot be deleted.</div>
    </Card>
  );
}

function TaskLabels() {
  const q = useApi('/settings/labels');
  const rows = (q.data && q.data.data) || [];
  return (
    <Card title="Task Settings — Labels" extra={<button className="btn sm">Create label</button>}>
      {q.loading ? <Skeleton rows={3} /> : rows.map((l) => (
        <div key={l.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
          <span className="tag" style={{ background: l.color + '22', color: l.color }}>{l.name}</span>
          <span>{l.active ? <StatusTag status="active" /> : <span className="tag gray">Inactive</span>}{l.name === 'Detention' && <span className="tag amber" style={{ marginLeft: 6 }}>system behavior preserved</span>}</span>
        </div>
      ))}
    </Card>
  );
}

function PlatformNotifications() {
  const items = ['New comment', 'Mention', 'Ticket assigned', 'Ticket status changed', 'Ticket created', 'System notification', 'New broker', 'New load', 'New email', 'Duplicate load', 'Paperwork issue', 'Stationary alert', 'SLA warning', 'SLA breached', 'Detention'];
  const { toast } = useApp();
  const [state, setState] = useState(Object.fromEntries(items.map((i) => [i, true])));
  const [dirty, setDirty] = useState(false);
  return (
    <Card title="Platform Notifications" extra={dirty && <span style={{ display: 'flex', gap: 8 }}><button className="btn sm" onClick={() => setDirty(false)}>Cancel</button><button className="btn primary sm" onClick={() => { toast('Notification settings saved (company-wide)'); setDirty(false); }}>Save</button></span>}>
      {items.map((i) => (
        <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
          <span>{i}</span>
          <input type="checkbox" checked={state[i]} onChange={(e) => { setState({ ...state, [i]: e.target.checked }); setDirty(true); }} aria-label={i} />
        </div>
      ))}
      <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 8 }}>Human-readable labels only. Changes are company-wide and require Save/Cancel.</div>
    </Card>
  );
}

function EmailSettings() {
  const { toast } = useApp();
  const [items, setItems] = useState(['@wenzel.example.com', 'noreply@']);
  const [val, setVal] = useState('');
  const add = () => {
    if (!/^(@[\w.-]+\.\w+|[^@\s]+@[\w.-]+\.\w+)$/.test(val)) { toast('Enter a valid email or @domain', 'error'); return; }
    setItems([...items, val]); setVal('');
  };
  return (
    <Card title="Email Settings — Exclusions">
      <p style={{ color: 'var(--text-2)' }}>Excluded emails/domains will not create broker or updater items. Internal domains are typically excluded.</p>
      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <input value={val} onChange={(e) => setVal(e.target.value)} placeholder="email@domain.com or @domain.com" style={{ flex: 1, height: 34, padding: '0 10px', borderRadius: 6, border: '1px solid var(--border-strong)', background: 'var(--surface)', color: 'var(--text)' }} />
        <button className="btn primary" onClick={add}>Create</button>
      </div>
      <table className="tbl"><thead><tr><th>Exclusion value</th><th>Actions</th></tr></thead>
        <tbody>{items.map((i) => <tr key={i}><td>{i}</td><td><button className="btn sm" onClick={() => setItems(items.filter((x) => x !== i))}>Remove</button></td></tr>)}</tbody>
      </table>
    </Card>
  );
}

const selS = { height: 34, borderRadius: 6, border: '1px solid var(--border-strong)', background: 'var(--surface)', color: 'var(--text)', padding: '0 8px', width: '100%' };
