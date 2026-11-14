/**
 * Monitoring → Logs: who changed what in Bitrix, and why — every change the
 * app made and every attempt that was refused or failed. Super administrators
 * only (the server refuses anyone else). Read-only.
 */
import { API_BASE, getHeaders, handleApiError } from './http';

/**
 * One page of 50, newest first.
 * @param {{from?: string, to?: string, trigger?: string, result?: string,
 *   search?: string, before?: string}} filters  dates as ISO strings
 */
export async function getActivityLog(filters = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value != null && String(value).trim() !== '') params.set(key, String(value).trim());
  }
  const query = params.toString();
  const res = await fetch(`${API_BASE}/activity-log${query ? `?${query}` : ''}`, { headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}
