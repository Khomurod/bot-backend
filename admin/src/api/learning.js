import { API_BASE, getHeaders, handleApiError } from './http';

/**
 * What Wenze has suggested about its OWN rules, and a person's decision.
 *
 * Accepting records agreement. It does not apply anything — whatever the
 * suggestion proposed is still done by hand, on purpose, because the
 * alternative is a machine changing a business rule because it convinced
 * itself.
 */
export async function getLearningSuggestions({ status = null, limit = 50 } = {}) {
  const params = new URLSearchParams();
  if (status) params.set('status', status);
  if (limit) params.set('limit', String(limit));
  const res = await fetch(`${API_BASE}/operations/learning?${params}`, { headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function decideLearningSuggestion(id, status, note = null) {
  const res = await fetch(`${API_BASE}/operations/learning/${id}/decide`, {
    method: 'POST', headers: getHeaders(), body: JSON.stringify({ status, note }),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}
