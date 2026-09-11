import { API_BASE, getHeaders, handleApiError } from './http';

/**
 * When the recruiting team works, whether Wenze may answer when they do not,
 * and what it is currently carrying.
 *
 * `now` comes back from the server rather than being computed here, because the
 * browser's clock and timezone are not the ones the feature runs on. A screen
 * that worked out "the office is shut" from the operator's laptop would tell an
 * administrator in another country something untrue about their own company.
 */
export async function getRecruitingHours() {
  const res = await fetch(`${API_BASE}/settings/recruiting-hours`, { headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

/** Omitted keys are left alone. `windows` replaces the list whole. */
export async function saveRecruitingHours(patch) {
  const res = await fetch(`${API_BASE}/settings/recruiting-hours`, {
    method: 'PUT', headers: getHeaders(), body: JSON.stringify(patch),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

/** Hand one conversation back to a person, or let Wenze resume it. */
export async function setRecruitingConversationStatus(phone, status, reason = null) {
  const res = await fetch(
    `${API_BASE}/settings/recruiting-hours/conversations/${encodeURIComponent(phone)}`,
    { method: 'PATCH', headers: getHeaders(), body: JSON.stringify({ status, reason }) },
  );
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}
