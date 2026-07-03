import React, { createContext, useContext, useEffect, useState, useCallback, useRef } from 'react';
import { api, setToken, getToken, setCompany, getCompany } from './api';

const AppCtx = createContext(null);
export const useApp = () => useContext(AppCtx);

let toastId = 0;

export function AppProvider({ children }) {
  const [me, setMe] = useState(null);
  const [loadingMe, setLoadingMe] = useState(true);
  const [theme, setTheme] = useState(localStorage.getItem('fleet_theme') || 'light');
  const [toasts, setToasts] = useState([]);
  const [dataStatus, setDataStatus] = useState('live'); // live | polling | stale | reconnecting | offline

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('fleet_theme', theme);
  }, [theme]);

  const refreshMe = useCallback(async () => {
    if (!getToken()) { setLoadingMe(false); return; }
    try {
      const data = await api('/me');
      setMe(data);
      if (!getCompany()) setCompany(data.activeCompanyId);
    } catch { setMe(null); }
    setLoadingMe(false);
  }, []);

  useEffect(() => { refreshMe(); }, [refreshMe]);

  // Simulated connection health monitor (§9.3). Real build would use WebSocket.
  useEffect(() => {
    const online = () => setDataStatus('live');
    const offline = () => setDataStatus('offline');
    window.addEventListener('online', online);
    window.addEventListener('offline', offline);
    if (!navigator.onLine) setDataStatus('offline');
    return () => { window.removeEventListener('online', online); window.removeEventListener('offline', offline); };
  }, []);

  const login = useCallback(async (email, password) => {
    const res = await api('/login', { method: 'POST', body: { email, password } });
    setToken(res.token);
    setCompany(res.activeCompanyId);
    await refreshMe();
    return res;
  }, [refreshMe]);

  const logout = useCallback(async () => {
    try { await api('/logout', { method: 'POST' }); } catch { /* noop */ }
    setToken(null); setCompany(null); setMe(null);
    window.location.hash = '#/login';
  }, []);

  const switchCompany = useCallback(async (companyId) => {
    const res = await api('/session/active-company', { method: 'POST', body: { companyId } });
    setToken(res.token); setCompany(companyId);
    await refreshMe();
  }, [refreshMe]);

  const toast = useCallback((message, type = 'success') => {
    const id = ++toastId;
    setToasts((t) => [...t, { id, message, type }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4000);
  }, []);

  const can = useCallback((perm) => !!me && me.permissions.includes(perm), [me]);

  const value = {
    me, loadingMe, refreshMe, login, logout, switchCompany, can,
    theme, setTheme, toast, toasts, setToasts, dataStatus, setDataStatus,
  };
  return <AppCtx.Provider value={value}>{children}</AppCtx.Provider>;
}
