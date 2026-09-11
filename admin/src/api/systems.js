import { API_BASE, getHeaders, handleApiError } from './http';

/**
 * Whether each part of Wenze is actually running.
 *
 * READ ONLY, and that is a decision rather than an omission. There is no
 * endpoint to restart a worker or clear a state, because a button like that is
 * one somebody presses instead of finding out why — and every recovery this
 * system performs is already automatic and already announced. What an operator
 * does with a row that needs attention is go and configure the thing it names.
 */
export async function getSystems() {
  const res = await fetch(`${API_BASE}/operations/systems`, { headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}
