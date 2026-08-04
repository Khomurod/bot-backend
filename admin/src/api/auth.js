/**
 * Sign-in, token verification, and sign-out.
 */

import { API_BASE, getHeaders, handleApiError } from './http';

export async function login(username, password) {
  const res = await fetch(`${API_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) { await handleApiError(res); }
  const data = await res.json();
  localStorage.setItem('token', data.token);
  return data;
}

export async function verifyAuth() {
  const res = await fetch(`${API_BASE}/auth/verify`, {
    headers: getHeaders(),
  });
  if (!res.ok) return null;
  return res.json();
}

export function logout() {
  localStorage.removeItem('token');
}
