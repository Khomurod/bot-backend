/**
 * Bot group access: what the bot can see, and asking for admin rights.
 */

import { API_BASE, getHeaders, handleApiError } from './http';

export async function getGroupAccess() {
  const res = await fetch(`${API_BASE}/home-time/group-access`, { headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function recheckGroupAccess() {
  const res = await fetch(`${API_BASE}/home-time/group-access/recheck`, {
    method: 'POST', headers: getHeaders(),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function getBotAccessSettings() {
  const res = await fetch(`${API_BASE}/home-time/access-settings`, { headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function updateBotAccessSettings(payload) {
  const res = await fetch(`${API_BASE}/home-time/access-settings`, {
    method: 'PUT', headers: getHeaders(), body: JSON.stringify(payload || {}),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function requestGroupAdmin(groupId) {
  const res = await fetch(`${API_BASE}/home-time/group-access/request-admin/${groupId}`, {
    method: 'POST', headers: getHeaders(),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

