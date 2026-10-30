/**
 * Driver groups and the driver profiles derived from them.
 *
 * A driver's language, birthday and status are edited through the profile
 * (`updateDriverProfile`), which the server copies onto the group.
 */

import { API_BASE, getHeaders, handleApiError } from './http';

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

/**
 * The Telegram users the bot has seen in one driver group — the "Driver
 * Username" picker on the driver popup. Telegram cannot list a group's
 * members, so a silent member is absent until their first message.
 */
export async function getGroupMembers(groupId) {
  const res = await fetch(`${API_BASE}/groups/${groupId}/members`, { headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  const data = await res.json();
  return Array.isArray(data?.members) ? data.members : [];
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

export async function runDriverProfilesAiSync(apply = true) {
  const res = await fetch(`${API_BASE}/driver-profiles/ai-sync?apply=${apply ? 'true' : 'false'}`, {
    method: 'POST',
    headers: getHeaders(),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}
