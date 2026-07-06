// Fetch wrapper for the Fleet API. Injects the bearer token + active-company
// header, and surfaces the standard error shape (§11.2).

const BASE = '/api/v1';

export function getToken() { return localStorage.getItem('fleet_token'); }
export function setToken(t) { if (t) localStorage.setItem('fleet_token', t); else localStorage.removeItem('fleet_token'); }
export function getCompany() { return localStorage.getItem('fleet_company') || ''; }
export function setCompany(c) { if (c) localStorage.setItem('fleet_company', c); else localStorage.removeItem('fleet_company'); }

export class ApiError extends Error {
  constructor(status, payload) {
    super((payload && payload.error && payload.error.message) || `Request failed (${status})`);
    this.status = status;
    this.code = payload && payload.error && payload.error.code;
    this.fieldErrors = (payload && payload.error && payload.error.fieldErrors) || {};
    this.correlationId = payload && payload.error && payload.error.correlationId;
    this.retryable = payload && payload.error && payload.error.retryable;
  }
}

export async function api(path, { method = 'GET', body, headers = {}, signal } = {}) {
  const token = getToken();
  const res = await fetch(BASE + path, {
    method,
    signal,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(getCompany() ? { 'X-Company-Id': getCompany() } : {}),
      ...headers,
    },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  let payload = null;
  const text = await res.text();
  if (text) { try { payload = JSON.parse(text); } catch { payload = null; } }
  if (res.status === 401) {
    setToken(null);
    if (!path.includes('/login')) window.location.hash = '#/login';
  }
  if (!res.ok) throw new ApiError(res.status, payload);
  return payload;
}

export const qs = (obj) => {
  const p = new URLSearchParams();
  Object.entries(obj || {}).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') p.set(k, v); });
  const s = p.toString();
  return s ? `?${s}` : '';
};
