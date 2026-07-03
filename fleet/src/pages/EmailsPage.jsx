import React, { useState } from 'react';
import { useApp } from '../store.jsx';
import { api } from '../api';
import { useApi, Skeleton, EmptyState, ErrorState, fmtTime, relTime } from '../components.jsx';

// Minimal HTML sanitizer — strips scripts/handlers before sandboxed render (§6.9).
function sanitize(html) {
  if (!html) return '';
  return String(html)
    .replace(/<\s*script[^>]*>[\s\S]*?<\s*\/\s*script>/gi, '')
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, '')
    .replace(/\son\w+\s*=\s*'[^']*'/gi, '')
    .replace(/javascript:/gi, '');
}

export default function EmailsPage() {
  const { can, toast } = useApp();
  const [category, setCategory] = useState('all');
  const [search, setSearch] = useState('');
  const [dq, setDq] = useState('');
  const [selectedId, setSelectedId] = useState(null);

  React.useEffect(() => { const t = setTimeout(() => setDq(search), 300); return () => clearTimeout(t); }, [search]);
  const cats = useApi('/email/categories');
  const threads = useApi(`/email/threads?category=${category}&search=${encodeURIComponent(dq)}`, [category, dq]);
  const detail = useApi(selectedId ? `/email/threads/${selectedId}` : null, [selectedId], { enabled: !!selectedId });

  const list = (threads.data && threads.data.data) || [];
  const account = threads.data && threads.data.account;
  const msg = detail.data && detail.data.data;

  return (
    <div>
      {account && (
        <div className="stale-banner" style={{ background: account.connection_state === 'connected' ? 'var(--green-soft)' : 'var(--amber-soft)', color: account.connection_state === 'connected' ? 'var(--green)' : 'var(--amber)', borderColor: 'currentColor' }}>
          {account.address} · {account.connection_state} · last sync {fmtTime(account.last_sync_at)}{account.last_error ? ` · ${account.last_error}` : ''}
        </div>
      )}
      <div className="email-layout">
        <div className="email-cats" role="listbox" aria-label="Email categories">
          {(cats.data && cats.data.data || []).map((c) => (
            <div key={c.key} role="option" aria-selected={category === c.key} tabIndex={0}
              className={`email-cat${category === c.key ? ' active' : ''}`} onClick={() => setCategory(c.key)}
              onKeyDown={(e) => { if (e.key === 'Enter') setCategory(c.key); }}>
              <span>{c.label}</span><span>{c.count}</span>
            </div>
          ))}
        </div>

        <div className="email-list">
          <div style={{ padding: 8, borderBottom: '1px solid var(--border)' }}>
            <input placeholder="Search emails" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search emails"
              style={{ width: '100%', height: 32, padding: '0 8px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text)' }} />
          </div>
          {threads.loading ? <Skeleton rows={6} /> : threads.error ? <ErrorState error={threads.error} onRetry={threads.reload} /> : list.length === 0
            ? <EmptyState title="No emails" hint={dq ? `Nothing matches “${dq}”.` : 'This category is empty.'} />
            : list.map((t) => (
              <div key={t.id} className={`email-row${t.unread ? ' unread' : ''}${selectedId === t.id ? ' active' : ''}`} onClick={() => setSelectedId(t.id)} role="button" tabIndex={0}
                onKeyDown={(e) => { if (e.key === 'Enter') setSelectedId(t.id); }}>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ fontWeight: t.unread ? 700 : 500 }}>{t.sender_name}</span>
                  <span style={{ fontSize: 11, color: 'var(--text-3)' }}>{relTime(t.received_at)}</span>
                </div>
                <div className="sub">{t.subject}</div>
                <div className="prev">{t.preview}</div>
                <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
                  {t.critical && <span className="tag red">Critical</span>}
                  {t.has_attachment && <span className="tag gray">📎</span>}
                </div>
              </div>
            ))}
        </div>

        <div className="email-detail">
          {!selectedId ? <EmptyState title="Select an email to view its contents" />
            : detail.loading ? <Skeleton rows={8} /> : detail.error ? <ErrorState error={detail.error} onRetry={detail.reload} /> : msg && (
              <div>
                <h2 style={{ marginTop: 0 }}>{msg.subject}</h2>
                <div style={{ color: 'var(--text-3)', fontSize: 13, marginBottom: 4 }}>From <b>{msg.sender_name}</b> &lt;{msg.sender}&gt;</div>
                <div style={{ color: 'var(--text-3)', fontSize: 13, marginBottom: 12 }}>To {msg.recipients.join(', ')} · {fmtTime(msg.received_at)}</div>
                {msg.messages.map((m) => (
                  <div key={m.id} style={{ marginBottom: 16 }}>
                    <div style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 4 }}>{m.sender_name} · {fmtTime(m.received_at)}</div>
                    <iframe title={`Email body from ${m.sender_name}`} sandbox="allow-popups"
                      srcDoc={`<!doctype html><meta charset="utf-8"><style>body{font-family:system-ui;font-size:14px;color:#1f2733;padding:8px;margin:0}</style>${sanitize(m.body_html)}`} />
                    {m.attachments.map((a) => (
                      <div key={a.id} style={{ marginTop: 8, padding: 8, border: '1px solid var(--border)', borderRadius: 6, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span>📎 {a.filename} · {(a.size_bytes / 1024).toFixed(0)} KB</span>
                        <span style={{ display: 'flex', gap: 6 }}>
                          <button className="btn sm" aria-label={`Preview ${a.filename}`} onClick={async () => { try { const r = await api(`/email/attachments/${a.id}/preview-url`); toast('Preview URL issued (short-lived, tenant-checked)'); } catch (ex) { toast(ex.message, 'error'); } }}>Preview</button>
                          {can('email.download') && <button className="btn sm" aria-label={`Download ${a.filename}`} onClick={async () => { try { await api(`/email/attachments/${a.id}/download-url`); toast('Download URL issued (short-lived)'); } catch (ex) { toast(ex.message, 'error'); } }}>Download</button>}
                        </span>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            )}
        </div>
      </div>
    </div>
  );
}
