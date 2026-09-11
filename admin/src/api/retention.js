import { API_BASE, getHeaders, handleApiError } from './http';

/**
 * Who the company may be about to lose, and why.
 *
 * There is deliberately no write here beyond the acknowledgement. The reasons
 * are computed from company records and are not editable from a screen: a
 * retention list somebody can annotate stops being a list of things to fix and
 * becomes a file about people.
 */
export async function getRetention({ level = null, limit = 50 } = {}) {
  const params = new URLSearchParams();
  if (level) params.set('level', level);
  if (limit) params.set('limit', String(limit));
  const res = await fetch(`${API_BASE}/operations/retention?${params}`, { headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

/** "We know, we are on it." Pass false to undo. Never buys silence for good. */
export async function acknowledgeRetention(id, acknowledged = true) {
  const res = await fetch(`${API_BASE}/operations/retention/${id}/acknowledge`, {
    method: 'POST', headers: getHeaders(), body: JSON.stringify({ acknowledged }),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}
