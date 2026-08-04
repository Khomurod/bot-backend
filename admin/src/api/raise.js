/**
 * Driver raise approval (75¢/mile).
 *
 * Both sides of the feature: the authenticated admin API (teams, rounds,
 * results) and the public token-based endpoints a driver uses to respond.
 */

import { API_BASE, getHeaders, handleApiError } from './http';

// ─── Driver Raise Approval (75¢/mile) — admin ───

const RAISE_ADMIN = `${API_BASE}/raise/admin`;

export async function getRaiseSettings() {
  const res = await fetch(`${RAISE_ADMIN}/settings`, { headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function updateRaiseSettings(patch) {
  const res = await fetch(`${RAISE_ADMIN}/settings`, {
    method: 'PUT', headers: getHeaders(), body: JSON.stringify(patch || {}),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function getRaiseCompanyDrivers() {
  const res = await fetch(`${RAISE_ADMIN}/company-drivers`, { headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function getRaiseTeams() {
  const res = await fetch(`${RAISE_ADMIN}/teams`, { headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function createRaiseTeam(name) {
  const res = await fetch(`${RAISE_ADMIN}/teams`, {
    method: 'POST', headers: getHeaders(), body: JSON.stringify({ name }),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function updateRaiseTeam(id, patch) {
  const res = await fetch(`${RAISE_ADMIN}/teams/${id}`, {
    method: 'PATCH', headers: getHeaders(), body: JSON.stringify(patch || {}),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function deleteRaiseTeam(id) {
  const res = await fetch(`${RAISE_ADMIN}/teams/${id}`, {
    method: 'DELETE', headers: getHeaders(),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function getRaiseTeamDrivers(id) {
  const res = await fetch(`${RAISE_ADMIN}/teams/${id}/drivers`, { headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function setRaiseTeamDrivers(id, drivers) {
  const res = await fetch(`${RAISE_ADMIN}/teams/${id}/drivers`, {
    method: 'PUT', headers: getHeaders(), body: JSON.stringify({ drivers }),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function getRaiseAssignableDrivers({ includeInactive = false, search = '' } = {}) {
  const params = new URLSearchParams();
  if (includeInactive) params.set('include_inactive', 'true');
  if (search) params.set('search', search);
  const qs = params.toString();
  const res = await fetch(`${RAISE_ADMIN}/assignable-drivers${qs ? `?${qs}` : ''}`, { headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

// Assign (or move, with force) a driver to a team. On a 409 conflict returns
// { conflict: true, error, conflictTeam } so the UI can offer "Move".
export async function assignRaiseDriver(teamId, { groupId, driverProfileId, force = false }) {
  const res = await fetch(`${RAISE_ADMIN}/teams/${teamId}/assign-driver`, {
    method: 'POST', headers: getHeaders(), body: JSON.stringify({ groupId, driverProfileId, force }),
  });
  if (res.status === 409) {
    const body = await res.json().catch(() => ({}));
    return { conflict: true, ...body };
  }
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function removeRaiseTeamDriver(driverId) {
  const res = await fetch(`${RAISE_ADMIN}/team-drivers/${driverId}`, {
    method: 'DELETE', headers: getHeaders(),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function getRaiseTeamMembers(teamId) {
  const res = await fetch(`${RAISE_ADMIN}/teams/${teamId}/members`, { headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function createRaiseTeamMember(teamId, member) {
  const res = await fetch(`${RAISE_ADMIN}/teams/${teamId}/members`, {
    method: 'POST', headers: getHeaders(), body: JSON.stringify(member || {}),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function updateRaiseTeamMember(memberId, patch) {
  const res = await fetch(`${RAISE_ADMIN}/members/${memberId}`, {
    method: 'PATCH', headers: getHeaders(), body: JSON.stringify(patch || {}),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function deleteRaiseTeamMember(memberId) {
  const res = await fetch(`${RAISE_ADMIN}/members/${memberId}`, {
    method: 'DELETE', headers: getHeaders(),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function raiseSendNow(payload) {
  const res = await fetch(`${RAISE_ADMIN}/send-now`, {
    method: 'POST', headers: getHeaders(), body: JSON.stringify(payload || {}),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function getRaiseRounds() {
  const res = await fetch(`${RAISE_ADMIN}/rounds`, { headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function getRaiseRoundResults(id) {
  const res = await fetch(`${RAISE_ADMIN}/rounds/${id}/results`, { headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function closeRaiseRound(id) {
  const res = await fetch(`${RAISE_ADMIN}/rounds/${id}/close`, {
    method: 'POST', headers: getHeaders(),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

// ─── Driver Raise Approval — public (no auth, token-based) ───

export async function getRaisePublicInfo(token) {
  const res = await fetch(`${API_BASE}/raise/${token}`);
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function raiseRequestOtp(token, payload) {
  const res = await fetch(`${API_BASE}/raise/${token}/request-otp`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {}),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function raiseVerifyOtp(token, payload) {
  const res = await fetch(`${API_BASE}/raise/${token}/verify-otp`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {}),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function raiseSubmit(token, payload) {
  const res = await fetch(`${API_BASE}/raise/${token}/submit`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {}),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

