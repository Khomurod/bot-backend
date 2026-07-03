import React, { useState, useEffect, useRef } from 'react';
import { NavLink, useNavigate, useLocation } from 'react-router-dom';
import { useApp } from './store.jsx';
import { api } from './api';
import { initials, fmtTime } from './components.jsx';

const NAV = [
  { group: 'Main', items: [
    { to: '/dashboard', label: 'Dashboard', ico: '▤' },
    { to: '/dashboard/tasks', label: 'Tasks', ico: '☑' },
    { to: '/dashboard/loads', label: 'Loads', ico: '▦' },
    { to: '/dashboard/update-board', label: 'Update Board', ico: '⟳' },
    { to: '/dashboard/dispatch-board', label: 'Dispatch Board', ico: '▥' },
    { to: '/dashboard/dispatch-map', label: 'Dispatch Map', ico: '◎' },
    { to: '/dashboard/emails', label: 'Emails', ico: '✉' },
    { to: '/dashboard/rate-savings', label: 'Rate savings', ico: '％' },
    { to: '/dashboard/statistics', label: 'Statistics', ico: '📊' },
  ] },
  { group: 'Account Resources', items: [
    { to: '/dashboard/users', label: 'Site Users', ico: '👥' },
    { to: '/dashboard/brokers', label: 'Brokers', ico: '🤝' },
    { to: '/dashboard/drivers', label: 'Drivers', ico: '🚛' },
    { to: '/dashboard/equipments', label: 'Equipment', ico: '🚚' },
    { to: '/dashboard/fuel-tolls', label: 'Fuel & Tolls', ico: '⛽' },
    { to: '/dashboard/companies', label: 'My Companies', ico: '🏢' },
  ] },
  { group: 'Utility', items: [
    { to: '/dashboard/settings', label: 'Settings', ico: '⚙' },
    { to: '/support', label: 'Contact Support', ico: '🛟' },
    { to: '/help', label: 'Help Center', ico: '❓' },
  ] },
];

const CRUMBS = {
  '/dashboard': 'Dashboard', '/dashboard/tasks': 'Tasks', '/dashboard/loads': 'Loads',
  '/dashboard/update-board': 'Update Board', '/dashboard/dispatch-board': 'Dispatch Board',
  '/dashboard/dispatch-map': 'Dispatch Map', '/dashboard/emails': 'Emails',
  '/dashboard/rate-savings': 'Rate Savings', '/dashboard/statistics': 'Statistics',
  '/dashboard/users': 'Site Users', '/dashboard/brokers': 'Brokers', '/dashboard/drivers': 'Drivers',
  '/dashboard/equipments': 'Equipment', '/dashboard/fuel-tolls': 'Fuel & Tolls',
  '/dashboard/companies': 'My Companies', '/dashboard/settings': 'Settings',
  '/support': 'Contact Support', '/help': 'Help Center',
};

function GlobalSearch() {
  const [q, setQ] = useState('');
  const [res, setRes] = useState(null);
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const nav = useNavigate();
  const ref = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    const t = setTimeout(async () => {
      if (!q.trim()) { setRes(null); return; }
      try { setRes(await api(`/search?q=${encodeURIComponent(q)}`)); setOpen(true); } catch { setRes(null); }
    }, 300);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => {
    const key = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); inputRef.current && inputRef.current.focus(); }
    };
    const click = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    window.addEventListener('keydown', key);
    document.addEventListener('mousedown', click);
    return () => { window.removeEventListener('keydown', key); document.removeEventListener('mousedown', click); };
  }, []);

  const flat = res ? [
    ...res.loads.map((r) => ({ ...r, type: 'load', path: `/dashboard/loads?focus=${r.id}` })),
    ...res.drivers.map((r) => ({ ...r, type: 'driver', path: `/dashboard/drivers?focus=${r.id}` })),
    ...res.trucks.map((r) => ({ ...r, type: 'truck', path: `/dashboard/equipments?focus=${r.id}` })),
  ] : [];

  const go = (item) => { if (item) { nav(item.path); setOpen(false); setQ(''); } };

  return (
    <div className="gsearch" ref={ref}>
      <span className="ico" aria-hidden>🔍</span>
      <input ref={inputRef} value={q} placeholder="Search by Load, Driver, Truck" aria-label="Global search"
        onChange={(e) => { setQ(e.target.value); setHi(0); }} onFocus={() => res && setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setHi((h) => Math.min(h + 1, flat.length - 1)); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)); }
          else if (e.key === 'Enter') go(flat[hi]);
          else if (e.key === 'Escape') setOpen(false);
        }} />
      <span className="kbd">⌘K</span>
      {open && (
        <div className="gsearch-results" role="listbox">
          {!res ? <div className="gsearch-item">Searching…</div>
            : flat.length === 0 ? <div className="gsearch-item">No loads, drivers, or trucks match “{q}”</div>
            : ['load', 'driver', 'truck'].map((type) => {
              const items = flat.filter((f) => f.type === type);
              if (!items.length) return null;
              return (
                <div key={type}>
                  <div className="gsearch-group-title">{type === 'load' ? 'Loads' : type === 'driver' ? 'Drivers' : 'Trucks'}</div>
                  {items.map((item) => (
                    <div key={item.id} role="option" aria-selected={flat[hi] === item}
                      className={`gsearch-item${flat[hi] === item ? ' hi' : ''}`} onClick={() => go(item)}>
                      <span>{item.label}</span><span className="ctx">{item.context}</span>
                    </div>
                  ))}
                </div>
              );
            })}
        </div>
      )}
    </div>
  );
}

function DataStatus() {
  const { dataStatus } = useApp();
  const [open, setOpen] = useState(false);
  const label = { live: 'Live', polling: 'Polling', stale: 'Stale', reconnecting: 'Reconnecting', offline: 'Offline' }[dataStatus];
  return (
    <div style={{ position: 'relative' }}>
      <span className={`datastatus ${dataStatus}`} role="button" tabIndex={0} onClick={() => setOpen(!open)}
        onKeyDown={(e) => { if (e.key === 'Enter') setOpen(!open); }} aria-label={`Data status: ${label}`}>
        <span className="pulse" />{label}
      </span>
      {open && (
        <div className="popover" style={{ width: 260 }}>
          <h4>Connection</h4>
          <div style={{ fontSize: 13, lineHeight: 1.7 }}>
            <div>Status: <b>{label}</b></div>
            <div>Source: primary-db + eld-provider</div>
            <div>Last successful update: {fmtTime('2026-07-03T17:59:50Z')}</div>
            <div>Transport: {dataStatus === 'live' ? 'WebSocket (simulated)' : 'Polling fallback'}</div>
          </div>
        </div>
      )}
    </div>
  );
}

function Notifications() {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState([]);
  useEffect(() => { api('/notifications').then((r) => setItems(r.data || [])).catch(() => {}); }, [open]);
  const unread = items.filter((n) => !n.read).length;
  return (
    <div style={{ position: 'relative' }}>
      <button className="icon-btn" aria-label={`Notifications (${unread} unread)`} onClick={() => setOpen(!open)}>
        🔔{unread > 0 && <span style={{ position: 'absolute', top: -4, right: -4, background: 'var(--red)', color: '#fff', borderRadius: 10, fontSize: 10, padding: '0 5px' }}>{unread}</span>}
      </button>
      {open && (
        <div className="popover" style={{ width: 320 }}>
          <h4>Notifications</h4>
          {items.length === 0 ? <div style={{ padding: 8, color: 'var(--text-3)' }}>No notifications</div>
            : items.map((n) => (
              <div key={n.id} style={{ padding: '8px 4px', borderBottom: '1px solid var(--border)', opacity: n.read ? 0.6 : 1 }}>
                <div style={{ fontWeight: 600, fontSize: 13 }}>{n.type}</div>
                <div style={{ fontSize: 12, color: 'var(--text-2)' }}>{n.message}</div>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}

export default function Shell({ children }) {
  const { me, theme, setTheme, logout, switchCompany } = useApp();
  const loc = useLocation();
  const [collapsed, setCollapsed] = useState(localStorage.getItem('fleet_sidebar') === '1');
  const [profileOpen, setProfileOpen] = useState(false);
  const crumb = CRUMBS[loc.pathname] || 'Dashboard';

  const toggleCollapse = () => { const v = !collapsed; setCollapsed(v); localStorage.setItem('fleet_sidebar', v ? '1' : '0'); };
  const toggleFullscreen = () => { if (!document.fullscreenElement) document.documentElement.requestFullscreen?.(); else document.exitFullscreen?.(); };

  return (
    <div className="app">
      <aside className={`sidebar${collapsed ? ' collapsed' : ''}`}>
        <div className="sidebar-logo"><span className="dot">FV</span>{!collapsed && <span>FleetView</span>}</div>
        <nav className="nav">
          {NAV.map((g) => (
            <div key={g.group}>
              <div className="nav-group-title">{collapsed ? '•••' : g.group}</div>
              {g.items.map((it) => (
                <NavLink key={it.to} to={it.to} end={it.to === '/dashboard'} className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`} title={it.label}>
                  <span className="ico" aria-hidden>{it.ico}</span><span className="label">{it.label}</span>
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
        <button className="nav-item" onClick={toggleCollapse} aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} style={{ border: 'none', background: 'none', width: '100%' }}>
          <span className="ico">{collapsed ? '»' : '«'}</span><span className="label">Collapse</span>
        </button>
      </aside>
      <div className="main">
        <header className="header">
          <span className="crumb">{crumb}</span>
          <div className="spacer" />
          <GlobalSearch />
          {me && me.companies.length > 0 && (
            <select aria-label="Company" value={me.activeCompanyId} onChange={(e) => switchCompany(e.target.value)}
              style={{ height: 34, border: '1px solid var(--border)', borderRadius: 6, background: 'var(--surface-2)', color: 'var(--text)', padding: '0 8px' }}>
              {me.companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          )}
          <DataStatus />
          <button className="icon-btn" aria-label="Toggle theme" onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}>{theme === 'light' ? '🌙' : '☀'}</button>
          <button className="icon-btn" aria-label="Toggle fullscreen" onClick={toggleFullscreen}>⛶</button>
          <Notifications />
          <div style={{ position: 'relative' }}>
            <button className="icon-btn" aria-label="Profile menu" onClick={() => setProfileOpen(!profileOpen)}>
              <span className="avatar">{initials(me && me.name)}</span>
            </button>
            {profileOpen && (
              <div className="popover" style={{ width: 220 }}>
                <div style={{ fontWeight: 600 }}>{me && me.name}</div>
                <div style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 8 }}>{me && me.email}</div>
                <div style={{ fontSize: 12, color: 'var(--text-2)', marginBottom: 8 }}>Roles: {me && me.roles.join(', ')}</div>
                <button className="btn sm" style={{ width: '100%' }} onClick={logout}>Log out</button>
              </div>
            )}
          </div>
        </header>
        <main className="content">{children}</main>
      </div>
    </div>
  );
}
