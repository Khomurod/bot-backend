import React, { useEffect, useState, useCallback, useRef } from 'react';
import { api, ApiError } from './api';

// ── Data hook with loading / empty / error / stale states (§20) ──────────────
export function useApi(path, deps = [], { enabled = true } = {}) {
  const [state, setState] = useState({ loading: true, error: null, data: null, meta: null });
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  useEffect(() => {
    if (!enabled || !path) { setState({ loading: false, error: null, data: null, meta: null }); return; }
    let alive = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    api(path)
      .then((res) => { if (alive) setState({ loading: false, error: null, data: res, meta: res && res.meta }); })
      .catch((err) => { if (alive) setState({ loading: false, error: err, data: null, meta: null }); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, tick, enabled, ...deps]);
  return { ...state, reload };
}

// ── Auto-refreshing data hook ────────────────────────────────────────────────
// Polls an internal cached FleetView endpoint on an interval. Keeps the previous
// data visible while refreshing, only shows the skeleton on the very first load
// or an explicit manual refresh, aborts the in-flight request on unmount, and
// never stacks duplicate intervals. It talks ONLY to the internal API (which
// serves the database snapshot) — never to DataTruck/Samsara directly.
export function usePolledApi(path, deps = [], { enabled = true, intervalMs = 30000 } = {}) {
  const [state, setState] = useState({ loading: true, refreshing: false, error: null, data: null, meta: null, lastUpdated: null });
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  const firstLoad = useRef(true);

  useEffect(() => {
    if (!enabled || !path) { setState((s) => ({ ...s, loading: false, refreshing: false })); return undefined; }
    let alive = true;
    const controller = new AbortController();
    let timer = null;

    const fetchOnce = async () => {
      if (!alive) return;
      setState((s) => (firstLoad.current ? { ...s, loading: true } : { ...s, refreshing: true }));
      try {
        const res = await api(path, { signal: controller.signal });
        if (!alive) return;
        firstLoad.current = false;
        setState({ loading: false, refreshing: false, error: null, data: res, meta: res && res.meta, lastUpdated: new Date().toISOString() });
      } catch (err) {
        if (!alive || err.name === 'AbortError') return;
        firstLoad.current = false;
        // Keep the previous data on a refresh error; only surface the error hard
        // when we have nothing to show yet.
        setState((s) => ({ ...s, loading: false, refreshing: false, error: s.data ? s.error : err }));
      }
    };

    fetchOnce();
    if (intervalMs > 0) timer = setInterval(fetchOnce, intervalMs);
    return () => { alive = false; controller.abort(); if (timer) clearInterval(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, tick, enabled, intervalMs, ...deps]);

  return { ...state, reload };
}

// ── State renderers ──────────────────────────────────────────────────────────
export function Skeleton({ rows = 5 }) {
  return (
    <div style={{ padding: 12 }} aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="skel" style={{ height: 16, margin: '10px 0', width: `${70 + (i % 3) * 10}%` }} />
      ))}
    </div>
  );
}
export function EmptyState({ title = 'Nothing to show', hint, action }) {
  return (
    <div className="state" role="status">
      <div className="big">{title}</div>
      {hint && <div>{hint}</div>}
      {action && <div style={{ marginTop: 12 }}>{action}</div>}
    </div>
  );
}
export function ErrorState({ error, onRetry }) {
  const e = error || {};
  return (
    <div className="state" role="alert">
      <div className="big">Something went wrong</div>
      <div>{e.message || 'Unexpected error.'}</div>
      {e.correlationId && <div className="cid">Correlation ID: {e.correlationId}</div>}
      {onRetry && e.status !== 403 && <div style={{ marginTop: 12 }}><button className="btn" onClick={onRetry}>Retry</button></div>}
    </div>
  );
}
export function StaleBanner({ meta }) {
  if (!meta || !meta.stale) return null;
  return <div className="stale-banner">⚠ Showing cached data. Last successful sync: {fmtTime(meta.lastSuccessfulSyncAt)}.</div>;
}

// Real-clock "x ago" (relTime is pinned to the demo date; this is for real
// freshness). Returns null for missing timestamps.
export function agoLabel(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const diff = Math.max(0, (Date.now() - t) / 1000);
  if (diff < 45) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

// Freshness/refresh strip for cached FleetView sections. Shows when the snapshot
// was last synced, a live "refreshing…" hint, a stale/error warning, and a
// manual refresh button that re-requests the cached endpoint (no live API spam).
export function FreshnessBar({ meta, refreshing, lastUpdated, onRefresh }) {
  const synced = (meta && (meta.lastSuccessfulSyncAt || meta.generatedAt)) || lastUpdated;
  const stale = !!(meta && meta.stale);
  const err = meta && meta.error;
  const ago = agoLabel(synced);
  return (
    <div className={`freshness-bar${stale ? ' stale' : ''}`} role="status"
      style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: stale ? 'var(--amber)' : 'var(--text-3)', padding: '4px 0' }}>
      <span style={{ width: 8, height: 8, borderRadius: '50%', background: stale ? 'var(--amber)' : 'var(--green)', display: 'inline-block' }} />
      {refreshing ? <span>Refreshing…</span> : stale
        ? <span>Data may be stale — last synced {ago || '—'}{err ? ` · ${String(err).slice(0, 80)}` : ''}</span>
        : <span>Last synced {ago || '—'}</span>}
      {onRefresh && <button className="btn sm" style={{ marginLeft: 'auto' }} onClick={onRefresh} disabled={refreshing} aria-label="Refresh data">⟳ Refresh</button>}
    </div>
  );
}

// Wraps common query rendering: skeleton / error / empty / content.
export function Async({ query, empty, children, skeletonRows }) {
  if (query.loading) return <Skeleton rows={skeletonRows} />;
  if (query.error) return <ErrorState error={query.error} onRetry={query.reload} />;
  const rows = query.data && (Array.isArray(query.data.data) ? query.data.data : query.data.data);
  if (empty && Array.isArray(rows) && rows.length === 0) return empty;
  return children;
}

// ── Presentational ───────────────────────────────────────────────────────────
export function Card({ title, extra, children, pad = true }) {
  return (
    <div className="card">
      {(title || extra) && <div className="card-head"><h3>{title}</h3><div>{extra}</div></div>}
      <div className={pad ? 'card-pad' : ''}>{children}</div>
    </div>
  );
}

export function Kpi({ label, value, sub, onClick }) {
  return (
    <div className={`kpi${onClick ? ' clickable' : ''}`} onClick={onClick} role={onClick ? 'button' : undefined} tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => { if (e.key === 'Enter') onClick(); } : undefined}>
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {sub && <div className="sub">{sub}</div>}
    </div>
  );
}

export function Segmented({ options, value, onChange }) {
  return (
    <div className="segmented" role="tablist">
      {options.map((o) => (
        <button key={o.value} role="tab" aria-selected={value === o.value}
          className={value === o.value ? 'active' : ''} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

const STATUS_TAG = {
  upcoming: 'gray', dispatched: 'blue', in_transit: 'purple', delivered: 'green', canceled: 'gray', rejected: 'red',
  todo: 'gray', in_progress: 'blue', done: 'green', archived: 'gray',
  active: 'green', inactive: 'gray', available: 'green', assigned: 'blue', maintenance: 'amber',
  connected: 'green', degraded: 'amber', disconnected: 'red', error: 'red', connecting: 'blue',
  all_good: 'green', document_missing: 'red', has_issue: 'amber',
  high: 'red', medium: 'amber', low: 'gray',
};
export function StatusTag({ status, label }) {
  const color = STATUS_TAG[status] || 'gray';
  return <span className={`tag ${color}`}><span className="tdot" />{label || humanize(status)}</span>;
}
export function TimingTag({ eta }) {
  if (!eta) return <span className="tag gray">Unknown</span>;
  const c = eta.timing_state === 'late' ? 'red' : eta.timing_state === 'early' ? 'blue' : 'green';
  return <span className={`tag ${c}`}>{eta.timing_label}</span>;
}

// ── Drawer / Modal ───────────────────────────────────────────────────────────
export function Drawer({ title, onClose, children, footer }) {
  useEscClose(onClose);
  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="drawer" role="dialog" aria-modal="true" aria-label={title}>
        <div className="dm-head"><h2>{title}</h2><button className="icon-btn" aria-label="Close" onClick={onClose}>✕</button></div>
        <div className="dm-body">{children}</div>
        {footer && <div className="dm-foot">{footer}</div>}
      </div>
    </div>
  );
}
export function Modal({ title, onClose, children, footer, wide }) {
  useEscClose(onClose);
  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`modal${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="dm-head"><h2>{title}</h2><button className="icon-btn" aria-label="Close" onClick={onClose}>✕</button></div>
        <div className="dm-body">{children}</div>
        {footer && <div className="dm-foot">{footer}</div>}
      </div>
    </div>
  );
}
function useEscClose(onClose) {
  useEffect(() => {
    const h = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
}

// ── Form field ───────────────────────────────────────────────────────────────
export function Field({ label, required, error, children }) {
  return (
    <div className={`field${error ? ' invalid' : ''}`}>
      {label && <label>{label} {required && <span className="req">*</span>}</label>}
      {children}
      {error && <div className="err">{error}</div>}
    </div>
  );
}

// ── Filter popover ───────────────────────────────────────────────────────────
export function FilterPopover({ children, active, onClear }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);
  return (
    <div style={{ position: 'relative' }} ref={ref}>
      <button className="btn" aria-label="Filters" aria-expanded={open} onClick={() => setOpen(!open)}>
        ⚙ Filter{active ? ` (${active})` : ''}
      </button>
      {open && (
        <div className="popover">
          {children}
          {onClear && <div style={{ marginTop: 12, textAlign: 'right' }}><button className="btn sm" onClick={() => { onClear(); }}>Clear all</button></div>}
        </div>
      )}
    </div>
  );
}

export function Pagination({ page, pageSize, total, onPage }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <div className="pagination">
      <span>{total} items</span>
      <button className="btn sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>Prev</button>
      <span>Page {page} / {pages}</span>
      <button className="btn sm" disabled={page >= pages} onClick={() => onPage(page + 1)}>Next</button>
    </div>
  );
}

// ── Formatting helpers ───────────────────────────────────────────────────────
export function money(cents, currency = 'USD') {
  if (cents == null) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 0 }).format(cents / 100);
}
export function humanize(s) {
  if (!s) return '';
  return String(s).replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
export function fmtTime(iso) {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch { return iso; }
}
export function relTime(iso) {
  if (!iso) return '—';
  const diff = (new Date('2026-07-03T18:00:00Z').getTime() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}
export function initials(name) {
  if (!name) return '?';
  return name.split(' ').map((p) => p[0]).slice(0, 2).join('').toUpperCase();
}
