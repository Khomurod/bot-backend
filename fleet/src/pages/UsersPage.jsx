import React, { useState, useEffect } from 'react';
import { useApp } from '../store.jsx';
import { api, qs } from '../api';
import { useApi, Card, Modal, Field, StatusTag, Skeleton, EmptyState, ErrorState, FilterPopover, Pagination } from '../components.jsx';

const sel = { height: 34, borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', padding: '0 8px' };
const DEPTS = ['Fleet', 'Updater', 'Dispatcher', 'Insurance', 'Safety', 'HR', 'Accounting'];
const ROLES = ['Admin', 'Manager', 'Dispatcher', 'Safety', 'Accountant', 'Viewer'];

export default function UsersPage() {
  const { can, toast } = useApp();
  const [search, setSearch] = useState('');
  const [dq, setDq] = useState('');
  const [page, setPage] = useState(1);
  const [department, setDepartment] = useState('');
  const [role, setRole] = useState('');
  const [importing, setImporting] = useState(false);
  const [creating, setCreating] = useState(false);

  useEffect(() => { const t = setTimeout(() => { setDq(search); setPage(1); }, 300); return () => clearTimeout(t); }, [search]);

  const q = useApi(`/users${qs({ search: dq, department, role, page, pageSize: 20 })}`, [dq, department, role, page]);
  const rows = (q.data && q.data.data) || [];
  const activeFilters = [department, role].filter(Boolean).length;

  const deactivate = async (u) => {
    const reason = window.prompt(`Deactivate ${u.name}? Enter a reason:`);
    if (!reason) return;
    try { await api(`/users/${u.id}/deactivate`, { method: 'POST', body: { reason } }); toast('User deactivated'); q.reload(); }
    catch (ex) { toast(ex.message, 'error'); }
  };

  return (
    <div>
      <div className="toolbar">
        <div className="search-inline"><span className="ico">🔍</span><input placeholder="Search users..." value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search users" /></div>
        <FilterPopover active={activeFilters} onClear={() => { setDepartment(''); setRole(''); setPage(1); }}>
          <h4>Department</h4>
          <select value={department} onChange={(e) => { setDepartment(e.target.value); setPage(1); }} style={{ ...sel, width: '100%', marginBottom: 8 }}>
            <option value="">All</option>{DEPTS.map((d) => <option key={d}>{d}</option>)}
          </select>
          <h4>Role</h4>
          <select value={role} onChange={(e) => { setRole(e.target.value); setPage(1); }} style={{ ...sel, width: '100%' }}>
            <option value="">All</option>{ROLES.map((r) => <option key={r}>{r}</option>)}
          </select>
        </FilterPopover>
        <div className="spacer" />
        <button className="btn" onClick={() => setImporting(true)}>Import</button>
        {can('users.manage') && <button className="btn primary" onClick={() => setCreating(true)}>+ Create</button>}
      </div>

      <Card pad={false}>
        {q.loading ? <Skeleton rows={6} /> : q.error ? <ErrorState error={q.error} onRetry={q.reload} /> : rows.length === 0 ? (
          <EmptyState title={dq ? `No users match “${dq}”` : 'No users'} hint="Try adjusting your search or filters." />
        ) : (
          <>
            <div className="tbl-wrap">
              <table className="tbl">
                <thead><tr>
                  <th>Name</th><th>Leader</th><th>Email</th><th>Role</th><th>Department</th><th>Status</th><th>Actions</th>
                </tr></thead>
                <tbody>
                  {rows.map((u) => (
                    <tr key={u.id}>
                      <td className="stack"><div className="a">{u.name}</div><div className="b">{u.phone_e164 || '—'}</div></td>
                      <td>{u.leader_name || '—'}</td>
                      <td>{u.email}</td>
                      <td>{(u.roles || []).join(', ') || '—'}</td>
                      <td>{u.department || '—'}</td>
                      <td><StatusTag status={u.status} /></td>
                      <td>
                        {can('users.manage') && u.status !== 'inactive' && <button className="btn sm" onClick={() => deactivate(u)}>Deactivate</button>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {q.data && <Pagination page={q.data.page} pageSize={q.data.pageSize} total={q.data.total} onPage={setPage} />}
          </>
        )}
      </Card>

      {importing && (
        <Modal title="Import Users (CSV)" onClose={() => setImporting(false)} footer={<><button className="btn" onClick={() => setImporting(false)}>Cancel</button><button className="btn primary" onClick={() => setImporting(false)}>Close</button></>}>
          <p>CSV import is a 4-step wizard:</p>
          <ol style={{ paddingLeft: 18, color: 'var(--text-2)', fontSize: 14, lineHeight: 1.8 }}>
            <li>Upload a CSV file</li>
            <li>Map columns to user fields</li>
            <li>Preview &amp; validate rows</li>
            <li>Confirm &amp; send invitations</li>
          </ol>
          <div className="demo-hint">The full wizard is not wired up in this build.</div>
        </Modal>
      )}

      {creating && <CreateUser onClose={() => setCreating(false)} />}
    </div>
  );
}

function CreateUser({ onClose }) {
  const { toast } = useApp();
  const [f, setF] = useState({ name: '', email: '', phone_e164: '', department: '', role: '', leader: '', status: 'active' });
  const submit = () => { toast('Invitation will be sent after confirmation'); onClose(); };
  return (
    <Modal title="Create User" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={submit}>Send Invitation</button></>}>
      <Field label="Name" required><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
      <Field label="Email" required><input value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
      <div className="grid-2">
        <Field label="Phone"><input value={f.phone_e164} onChange={(e) => setF({ ...f, phone_e164: e.target.value })} placeholder="+13125551234" /></Field>
        <Field label="Department">
          <select value={f.department} onChange={(e) => setF({ ...f, department: e.target.value })} style={{ ...sel, width: '100%' }}><option value="">Select…</option>{DEPTS.map((d) => <option key={d}>{d}</option>)}</select>
        </Field>
        <Field label="Role">
          <select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })} style={{ ...sel, width: '100%' }}><option value="">Select…</option>{ROLES.map((r) => <option key={r}>{r}</option>)}</select>
        </Field>
        <Field label="Leader"><input value={f.leader} onChange={(e) => setF({ ...f, leader: e.target.value })} /></Field>
        <Field label="Status">
          <select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })} style={{ ...sel, width: '100%' }}><option value="active">Active</option><option value="inactive">Inactive</option></select>
        </Field>
      </div>
    </Modal>
  );
}
