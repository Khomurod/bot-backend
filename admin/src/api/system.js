/**
 * System diagnostics: the hosted database's monthly transfer usage.
 *
 * Read by the usage banner so an admin sees "you are at 90% of the monthly
 * database transfer allowance" while there is still time to act, instead of
 * discovering the ceiling when reads start failing.
 */
import { API_BASE, getHeaders, handleApiError } from './http';

export async function getDatabaseUsage() {
  const res = await fetch(`${API_BASE}/system/database-usage`, { headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}
