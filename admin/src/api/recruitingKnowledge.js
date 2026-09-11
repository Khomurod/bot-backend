import { API_BASE, getHeaders, handleApiError } from './http';

/** Everything Wenze knows, plus what is waiting for a decision. */
export async function getRecruitingKnowledge(status = null) {
  const qs = status ? `?status=${encodeURIComponent(status)}` : '';
  const res = await fetch(`${API_BASE}/recruiting-knowledge${qs}`, { headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

/**
 * Say something in plain language. Answers with Wenze's reading and a proposal.
 * NOTHING is in use until `confirmRecruitingKnowledge` is called.
 */
export async function teachWenze(statement) {
  const res = await fetch(`${API_BASE}/recruiting-knowledge`, {
    method: 'POST', headers: getHeaders(), body: JSON.stringify({ statement }),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

/** Agree with the reading. The only call that puts a fact into use. */
export async function confirmRecruitingKnowledge(id) {
  const res = await fetch(`${API_BASE}/recruiting-knowledge/${id}/confirm`, {
    method: 'POST', headers: getHeaders(),
  });
  if (!res.ok) { await handleApiError(res); }
  return (await res.json()).entry;
}

export async function rejectRecruitingKnowledge(id, reason) {
  const res = await fetch(`${API_BASE}/recruiting-knowledge/${id}/reject`, {
    method: 'POST', headers: getHeaders(), body: JSON.stringify({ reason }),
  });
  if (!res.ok) { await handleApiError(res); }
  return (await res.json()).entry;
}

/** Take something out of use. Nothing is ever deleted. */
export async function retireRecruitingKnowledge(id) {
  const res = await fetch(`${API_BASE}/recruiting-knowledge/${id}/retire`, {
    method: 'POST', headers: getHeaders(),
  });
  if (!res.ok) { await handleApiError(res); }
  return (await res.json()).entry;
}

/** What a fact used to say, all the way back. */
export async function getRecruitingKnowledgeHistory(id) {
  const res = await fetch(`${API_BASE}/recruiting-knowledge/${id}/history`, { headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  return (await res.json()).history;
}
