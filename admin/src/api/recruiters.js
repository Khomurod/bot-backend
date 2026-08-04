/**
 * Recruiters and their call KPIs, including the public leaderboard feed.
 */

import { API_BASE, getHeaders, handleApiError } from './http';

// ─── Recruiters + call KPIs ───

export async function getRecruiters() {
  const res = await fetch(`${API_BASE}/recruiters`, { headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  const data = await res.json();
  return Array.isArray(data.recruiters) ? data.recruiters : [];
}

export async function createRecruiter(payload) {
  const res = await fetch(`${API_BASE}/recruiters`, {
    method: 'POST', headers: getHeaders(), body: JSON.stringify(payload || {}),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function updateRecruiter(id, payload) {
  const res = await fetch(`${API_BASE}/recruiters/${id}`, {
    method: 'PUT', headers: getHeaders(), body: JSON.stringify(payload || {}),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function deleteRecruiter(id) {
  const res = await fetch(`${API_BASE}/recruiters/${id}`, {
    method: 'DELETE', headers: getHeaders(),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function syncRecruiterCalls(full = false) {
  const res = await fetch(`${API_BASE}/recruiters/sync${full ? '?full=1' : ''}`, {
    method: 'POST', headers: getHeaders(),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function getRecruiterStats(date) {
  const qs = date ? `?date=${encodeURIComponent(date)}` : '';
  const res = await fetch(`${API_BASE}/recruiters/stats${qs}`, { headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

/** Quick per-number connectivity test (auth + own call-log read). */
export async function testRecruiterConnection(id, payload) {
  const res = await fetch(`${API_BASE}/recruiters/${id}/test`, {
    method: 'POST', headers: getHeaders(), body: JSON.stringify(payload || {}),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

/** Stepwise per-number diagnostic (creds → auth → identity → call log). */
export async function diagnoseRecruiter(id, payload) {
  const res = await fetch(`${API_BASE}/recruiters/${id}/diagnose`, {
    method: 'POST', headers: getHeaders(), body: JSON.stringify(payload || {}),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

/**
 * Public (no-auth) recruiter stats for the /recruiters leaderboard.
 * No params = today (live); { date } = one historical day;
 * { start, end } = inclusive date range (max 31 days).
 */
export async function getPublicRecruiterStats(params = {}) {
  const qs = new URLSearchParams();
  if (params.start && params.end) {
    qs.set('start', params.start);
    qs.set('end', params.end);
  } else if (params.date) {
    qs.set('date', params.date);
  }
  const suffix = qs.toString() ? `?${qs.toString()}` : '';
  const res = await fetch(`${API_BASE}/recruiters/public-stats${suffix}`);
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

