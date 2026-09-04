/**
 * Driver groups and the driver profiles derived from them.
 *
 * Includes the AI-assisted profile parsing and group-status sweeps, which act
 * on the same records.
 */

import { API_BASE, appendTargetActiveFilter, getHeaders, handleApiError } from './http';

export async function getGroups() {
  const res = await fetch(`${API_BASE}/groups`, { headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  const data = await res.json();
  return Array.isArray(data) ? data : (data?.groups ?? []);
}

/** All driver groups (active + inactive) for Groups page and broadcast driver picker. */
export async function getGroupsManage() {
  const res = await fetch(`${API_BASE}/groups/manage`, { headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

export async function getBroadcastPlaceholders() {
  const res = await fetch(`${API_BASE}/broadcast/placeholders`, { headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  const data = await res.json();
  return Array.isArray(data?.placeholders) ? data.placeholders : [];
}

export async function getDriverProfiles({ includeInactive = true, needsReviewOnly = false } = {}) {
  const params = new URLSearchParams();
  params.set('include_inactive', includeInactive ? 'true' : 'false');
  if (needsReviewOnly) params.set('needs_review_only', 'true');
  const res = await fetch(`${API_BASE}/driver-profiles?${params.toString()}`, { headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

export async function updateDriverProfile(profileId, payload) {
  const res = await fetch(`${API_BASE}/driver-profiles/${profileId}`, {
    method: 'PUT',
    headers: getHeaders(),
    body: JSON.stringify(payload || {}),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function aiParseDriverProfiles(apply = false) {
  const res = await fetch(`${API_BASE}/driver-profiles/ai-parse?apply=${apply ? 'true' : 'false'}`, {
    method: 'POST',
    headers: getHeaders(),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function runDriverProfilesAiSync(apply = true) {
  const res = await fetch(`${API_BASE}/driver-profiles/ai-sync?apply=${apply ? 'true' : 'false'}`, {
    method: 'POST',
    headers: getHeaders(),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function setGroupLanguage(groupId, language) {
  const res = await fetch(`${API_BASE}/groups/${groupId}/language`, {
    method: 'PUT',
    headers: getHeaders(),
    body: JSON.stringify({ language }),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function setGroupBirthday(groupId, birthday) {
  const res = await fetch(`${API_BASE}/groups/${groupId}/birthday`, {
    method: 'PUT',
    headers: getHeaders(),
    body: JSON.stringify({ birthday: birthday || null }),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function setGroupStatus(groupId, active) {
  const res = await fetch(`${API_BASE}/groups/${groupId}/status`, {
    method: 'PUT',
    headers: getHeaders(),
    body: JSON.stringify({ active }),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function runGroupStatusAi() {
  const res = await fetch(`${API_BASE}/groups/status/run-now`, {
    method: 'POST',
    headers: getHeaders(),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

