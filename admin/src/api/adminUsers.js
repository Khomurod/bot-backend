/**
 * Settings → Administration → Admin Accounts: who can sign in to this panel.
 * Mirrors server/routes/adminUserRoutes.js, which requires `users.manage`.
 */

import { API_BASE, getHeaders, handleApiError } from './http';

/** Every admin account with its roles: `[{ id, username, active, last_login_at, roles: [...] }]`. */
export async function getAdminUsers() {
  const res = await fetch(`${API_BASE}/admin/users`, { headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  const data = await res.json();
  return Array.isArray(data?.users) ? data.users : [];
}

/** The roles an account can be given: `[{ id, system_key, display_name, description, active }]`. */
export async function getAdminRoles() {
  const res = await fetch(`${API_BASE}/admin/roles`, { headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  const data = await res.json();
  return Array.isArray(data?.roles) ? data.roles : [];
}

export async function createAdminUser({ username, password, roleIds }) {
  const res = await fetch(`${API_BASE}/admin/users`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ username, password, role_ids: roleIds }),
  });
  if (!res.ok) { await handleApiError(res); }
  return (await res.json()).user;
}

/**
 * Change one account: `{ active }` to disable or re-enable it, `{ password }`
 * to reset its password. Either ends that account's open sessions.
 */
export async function updateAdminUser(id, { active, password } = {}) {
  const body = {};
  if (typeof active === 'boolean') body.active = active;
  if (password) body.password = password;
  const res = await fetch(`${API_BASE}/admin/users/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: getHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) { await handleApiError(res); }
  return (await res.json()).user;
}
