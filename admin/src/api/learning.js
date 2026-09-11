import { API_BASE, getHeaders, handleApiError } from './http';

/**
 * What Wenze has suggested about its OWN rules, and a person's decision.
 *
 * ACCEPTING MAY NOW CHANGE A SETTING, and that is the point rather than a
 * loosening. The guarantee is that AI cannot change a business rule BY ITSELF —
 * kept by requiring an administrator's confirmation, not by making the
 * confirmation inert. Accepting used to write a word in a table and change
 * nothing, while the screen said "accepted".
 *
 * `/accept` runs the suggestion's registered action when it has one, and
 * records agreement when it does not. The answer says which happened, and the
 * screen must show the difference — see LearningTab.jsx.
 */
export async function getLearningSuggestions({ status = null, limit = 50 } = {}) {
  const params = new URLSearchParams();
  if (status) params.set('status', status);
  if (limit) params.set('limit', String(limit));
  const res = await fetch(`${API_BASE}/operations/learning?${params}`, { headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

/** Dismiss, or put one back to `proposed`. Neither changes anything. */
export async function decideLearningSuggestion(id, status, note = null) {
  const res = await fetch(`${API_BASE}/operations/learning/${id}/decide`, {
    method: 'POST', headers: getHeaders(), body: JSON.stringify({ status, note }),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

/**
 * Accept. Returns `{ suggestion, applied, detail }` — `applied` says whether a
 * setting actually changed, and `detail` is the sentence to show either way.
 */
export async function acceptLearningSuggestion(id, note = null) {
  const res = await fetch(`${API_BASE}/operations/learning/${id}/accept`, {
    method: 'POST', headers: getHeaders(), body: JSON.stringify({ note }),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

/** Undo one that was applied, from the values recorded before it changed them. */
export async function revertLearningSuggestion(id, note = null) {
  const res = await fetch(`${API_BASE}/operations/learning/${id}/revert`, {
    method: 'POST', headers: getHeaders(), body: JSON.stringify({ note }),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}
