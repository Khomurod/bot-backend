/**
 * Live Locations: the map snapshot and a single unit's route.
 */

import { API_BASE, getHeaders, handleApiError } from './http';

// ─── Live Locations (map of all active units) ───

/** Map tile provider config (tile URL/attribution live server-side, admin-only). */
export async function getLiveLocationsConfig() {
  const res = await fetch(`${API_BASE}/live-locations/config`, { headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

/** Normalized, map-ready snapshot of all active units (location + load + ETA). */
export async function getLiveLocationsSnapshot({ force = false } = {}) {
  const qs = force ? '?force=1' : '';
  const res = await fetch(`${API_BASE}/live-locations/snapshot${qs}`, { headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

/** Precise routed ETA + route line for one selected unit. */
export async function getLiveLocationRoute(unit) {
  const res = await fetch(`${API_BASE}/live-locations/route?unit=${encodeURIComponent(unit)}`, {
    headers: getHeaders(),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

