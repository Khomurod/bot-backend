import React, { useState, useEffect, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useApp } from '../store.jsx';
import { api, qs } from '../api';
import { useApi, Card, Modal, Field, StatusTag, Skeleton, EmptyState, ErrorState, FilterPopover, initials, relTime, fmtTime, humanize } from '../components.jsx';

const COLS = [
  { key: 'todo', label: 'TODO' }, { key: 'in_progress', label: 'IN PROGRESS' }, { key: 'done', label: 'DONE' },
];
const DEPTS = ['Fleet', 'Updater', 'Dispatcher', 'Insurance', 'Safety', 'HR', 'Accounting'];

export default function TasksPage() {
  const { can, toast } = useApp();
  const [params, setParams] = useSearchParams();
  const [showArchive, setShowArchive] = useState(false);
  const [creating, setCreating] = useState(false);
  const [detailId, setDetailId] = useState(null);
  const [sort, setSort] = useState('created_at');
  const [dir, setDir] = useState('desc');

  const filters = useMemo(() => ({
    department: params.get('department') || '', priority: params.get('priority') || '',
    label: params.get('label') || '', search: params.get('search') || '', sort, dir,
  }), [params, sort, dir]);

  const tasks = useApi(`/tasks${qs(filters)}`, [JSON.stringify(filters)]);
  const labels = useApi('/settings/labels', [], { enabled: can('settings.manage') });

  const setFilter = (k, v) => { const p = new URLSearchParams(params); if (v) p.set(k, v); else p.delete(k); setParams(p); };
  const activeFilterCount = ['department', 'priority', 'label'].filter((k) => params.get(k)).length;

  const cols = showArchive ? [...COLS, { key: 'archived', label: 'ARCHIVE' }] : COLS;
  const rows = (tasks.data && tasks.data.data) || [];

  return (
    <div>
      <div className="toolbar">
        <div className="search-inline"><span className="ico">🔍</span><input placeholder="Search..." defaultValue={filters.search} onChange={(e) => setFilter('search', e.target.value)} aria-label="Search tasks" /></div>
        <select value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Sort field" style={sel}>
          <option value="created_at">Create Time</option><option value="priority">Priority</option><option value="title">Title</option>
        </select>
        <button className="btn" aria-label="Toggle sort direction" onClick={() => setDir(dir === 'asc' ? 'desc' : 'asc')}>{dir === 'asc' ? '↑' : '↓'}</button>
        <FilterPopover active={activeFilterCount} onClear={() => { const p = new URLSearchParams(); if (filters.search) p.set('search', filters.search); setParams(p); }}>
          <h4>Department</h4>
          <select value={filters.department} onChange={(e) => setFilter('department', e.target.value)} style={{ ...sel, width: '100%', marginBottom: 8 }}>
            <option value="">All</option>{DEPTS.map((d) => <option key={d}>{d}</option>)}
          </select>
          <h4>Priority</h4>
          <select value={filters.priority} onChange={(e) => setFilter('priority', e.target.value)} style={{ ...sel, width: '100%', marginBottom: 8 }}>
            <option value="">All</option><option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option>
          </select>
          <h4>Labels</h4>
          <select value={filters.label} onChange={(e) => setFilter('label', e.target.value)} style={{ ...sel, width: '100%' }}>
            <option value="">All</option>{(labels.data && labels.data.data || []).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        </FilterPopover>
        <button className="btn" aria-label="Board columns settings" onClick={() => setShowArchive(!showArchive)}>{showArchive ? 'Hide Archive' : 'Show Archive'}</button>
        <div className="spacer" />
        {can('tasks.create') && <button className="btn primary" onClick={() => setCreating(true)}>+ Create</button>}
      </div>

      {tasks.loading ? <Skeleton rows={6} /> : tasks.error ? <ErrorState error={tasks.error} onRetry={tasks.reload} /> : (
        <div className={`kanban${showArchive ? ' with-archive' : ''}`}>
          {cols.map((c) => {
            const items = rows.filter((t) => t.status === c.key);
            return (
              <div className="kcol" key={c.key}>
                <h4>{c.label}<span>{items.length}</span></h4>
                {items.length === 0 ? <div style={{ color: 'var(--text-3)', fontSize: 12, padding: 8 }}>No tasks</div>
                  : items.map((t) => (
                    <div className="tcard" key={t.id} onClick={() => setDetailId(t.id)} style={{ cursor: 'pointer' }} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter') setDetailId(t.id); }}>
                      <div className="ttitle">{t.title}</div>
                      <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginBottom: 6 }}>
                        <span className="tag gray">{t.department_id}</span>
                        <span className={`tag ${t.priority === 'high' ? 'red' : t.priority === 'medium' ? 'amber' : 'gray'}`}>{t.priority}</span>
                        {t.labels.map((l) => <span key={l.id} className="tag" style={{ background: l.color + '22', color: l.color }}>{l.name}</span>)}
                      </div>
                      <div className="tmeta">
                        <span title={fmtTime(t.created_at)}>{relTime(t.created_at)} · {humanize(t.source)}</span>
                        <span className="avatar" title={t.assignee_name}>{initials(t.assignee_name)}</span>
                      </div>
                    </div>
                  ))}
              </div>
            );
          })}
        </div>
      )}

      {creating && <CreateTask labels={labels.data && labels.data.data || []} onClose={() => setCreating(false)} onCreated={() => { setCreating(false); tasks.reload(); }} />}
      {detailId && <TaskDetail id={detailId} onClose={() => setDetailId(null)} onChanged={tasks.reload} />}
    </div>
  );
}

const sel = { height: 34, borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', padding: '0 8px' };

function CreateTask({ labels, onClose, onCreated }) {
  const { toast } = useApp();
  const [f, setF] = useState({ title: '', description: '', department: '', priority: 'medium' });
  const [errs, setErrs] = useState({});
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true); setErrs({});
    try { await api('/tasks', { method: 'POST', body: f }); toast('Task created'); onCreated(); }
    catch (ex) { setErrs(ex.fieldErrors || {}); toast(ex.message, 'error'); }
    finally { setBusy(false); }
  };
  return (
    <Modal title="Create Task" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy} onClick={submit}>Create Task</button></>}>
      <Field label="Title" required error={errs.title}><input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} maxLength={200} /></Field>
      <Field label="Description" error={errs.description}><textarea value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} maxLength={10000} /></Field>
      <div className="grid-2">
        <Field label="Department" required error={errs.department}>
          <select value={f.department} onChange={(e) => setF({ ...f, department: e.target.value })} style={{ ...sel, width: '100%' }}><option value="">Select…</option>{DEPTS.map((d) => <option key={d}>{d}</option>)}</select>
        </Field>
        <Field label="Priority" required error={errs.priority}>
          <select value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })} style={{ ...sel, width: '100%' }}><option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option></select>
        </Field>
      </div>
    </Modal>
  );
}

function TaskDetail({ id, onClose, onChanged }) {
  const { can, toast, me } = useApp();
  const detail = useApi(`/tasks/${id}`, [id]);
  const [tab, setTab] = useState('comments');
  const [comment, setComment] = useState('');
  const comments = useApi(`/tasks/${id}/comments`, [id], { enabled: tab === 'comments' });
  const chat = useApi(`/tasks/${id}/chat-history`, [id], { enabled: tab === 'chat' });
  const brokerMail = useApi(`/tasks/${id}/broker-mail-history`, [id], { enabled: tab === 'broker' });
  const t = detail.data && detail.data.data;

  const changeStatus = async (status) => {
    try { await api(`/tasks/${id}`, { method: 'PATCH', body: { status, version: t.version } }); toast(`Moved to ${humanize(status)}`); detail.reload(); onChanged(); }
    catch (ex) { toast(ex.message, 'error'); }
  };
  const archive = async () => { try { await api(`/tasks/${id}/archive`, { method: 'POST', body: {} }); toast('Archived'); detail.reload(); onChanged(); } catch (ex) { toast(ex.message, 'error'); } };
  const addComment = async () => {
    if (!comment.trim()) return;
    try { await api(`/tasks/${id}/comments`, { method: 'POST', body: { body: comment } }); setComment(''); comments.reload(); }
    catch (ex) { toast(ex.message, 'error'); }
  };

  return (
    <Modal title={t ? t.title : 'Task'} wide onClose={onClose} footer={<button className="btn" onClick={onClose}>Close</button>}>
      {detail.loading ? <Skeleton rows={6} /> : detail.error ? <ErrorState error={detail.error} /> : (
        <div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 14, flexWrap: 'wrap' }}>
            <select value={t.status} onChange={(e) => changeStatus(e.target.value)} aria-label="Status" style={sel} disabled={!can('tasks.create')}>
              {['todo', 'in_progress', 'done', 'archived'].map((s) => <option key={s} value={s}>{humanize(s)}</option>)}
            </select>
            <span className={`tag ${t.priority === 'high' ? 'red' : t.priority === 'medium' ? 'amber' : 'gray'}`}>{t.priority}</span>
            {can('tasks.archive') && <button className="btn sm" onClick={archive}>Archive</button>}
            {can('drivers.contact') && t.driver_name && <button className="btn sm" onClick={() => window.confirm(`Call ${t.driver_name}? This initiates an outbound call.`) && toast('Call initiated (simulated)')}>Call to Driver</button>}
          </div>
          <div className="grid-2" style={{ fontSize: 13 }}>
            <Info k="Department" v={t.department_id} /><Info k="Created" v={fmtTime(t.created_at)} />
            <Info k="Carrier" v={t.related_company_id ? 'Company' : '—'} /><Info k="Dispatcher" v={t.dispatcher_name} />
            <Info k="Driver" v={t.driver_name} /><Info k="Assignee" v={t.assignee_name} />
            <Info k="Load" v={t.load_number} /><Info k="ETA" v={t.eta_label} />
            <Info k="Drop-off" v={t.dropoff_address} /><Info k="Broker" v={t.broker_name} />
          </div>
          {t.labels.length > 0 && <div style={{ margin: '8px 0' }}>{t.labels.map((l) => <span key={l.id} className="tag" style={{ background: l.color + '22', color: l.color, marginRight: 4 }}>{l.name}</span>)}</div>}

          <div className="segmented" style={{ margin: '14px 0' }} role="tablist">
            {[['comments', 'Comments'], ['chat', 'Chat history'], ['broker', 'Broker mail history']].map(([k, lbl]) => (
              <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>{lbl}</button>
            ))}
          </div>

          {tab === 'comments' && (
            <div>
              {(comments.data && comments.data.data || []).map((c) => (
                <div key={c.id} style={{ padding: 8, borderBottom: '1px solid var(--border)' }}>
                  <div style={{ fontSize: 12, color: 'var(--text-3)' }}>{c.author_name} · {relTime(c.created_at)}</div>
                  <div>{c.body}</div>
                </div>
              ))}
              {can('tasks.comment') && (
                <div style={{ marginTop: 10 }}>
                  <textarea value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Add a comment… use @ to mention" style={{ width: '100%', minHeight: 60, borderRadius: 6, border: '1px solid var(--border-strong)', background: 'var(--surface)', color: 'var(--text)', padding: 8 }} />
                  {comment.includes('@') && <div style={{ fontSize: 12, color: 'var(--text-3)' }}>Mentions will notify the referenced users.</div>}
                  <div style={{ marginTop: 6, display: 'flex', gap: 8 }}>
                    <button className="btn primary sm" disabled={!comment.trim()} onClick={addComment}>Save</button>
                    <button className="btn sm" onClick={() => setComment('')}>Cancel</button>
                  </div>
                </div>
              )}
            </div>
          )}
          {tab === 'chat' && (chat.data && chat.data.data.length ? chat.data.data.map((m) => <div key={m.id} style={{ padding: 6 }}><b>{m.from}:</b> {m.text}</div>) : <EmptyState title="No linked conversation" hint="This task has no linked chat." />)}
          {tab === 'broker' && (brokerMail.data && brokerMail.data.data.length ? brokerMail.data.data.map((m) => <div key={m.id} style={{ padding: 8, borderBottom: '1px solid var(--border)' }}>{m.subject}</div>) : <EmptyState title="No broker emails are linked to this task." />)}
        </div>
      )}
    </Modal>
  );
}
function Info({ k, v }) { return <div style={{ padding: '4px 0' }}><span style={{ color: 'var(--text-3)' }}>{k}: </span>{v || '—'}</div>; }
