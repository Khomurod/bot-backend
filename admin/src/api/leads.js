/**
 * Driver leads feed.
 */

import { API_BASE, getHeaders, handleApiError } from './http';

export async function getLeads(source = '') {
  const params = new URLSearchParams({ t: String(Date.now()) });
  if (source) params.set('source', source);
  const res = await fetch(`${API_BASE}/leads?${params.toString()}`, {
    headers: getHeaders(),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

