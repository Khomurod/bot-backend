/**
 * Truck Photos — admin API client (Settings → Truck Photos).
 *
 * The test message answers `{ ok: false, message }` with HTTP 200 when
 * Telegram refused it (the person never pressed Start, say), so the screen can
 * say why in words; a bad value is an HTTP error carrying `error`.
 */

import { API_BASE, getHeaders, handleApiError } from './http';

const BASE = `${API_BASE}/settings/truck-photos`;
const JSON_HEADERS = () => ({ ...getHeaders(), 'Content-Type': 'application/json' });

/** The settings and the latest reports. */
export async function getTruckPhotos() {
  const res = await fetch(BASE, { headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

/** Save. Omitted fields keep their stored value. */
export async function updateTruckPhotos(payload) {
  const res = await fetch(BASE, { method: 'PUT', headers: JSON_HEADERS(), body: JSON.stringify(payload) });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

/** Message the saved recipient, to prove the bot can reach them. */
export async function sendTruckPhotoTestMessage() {
  const res = await fetch(`${BASE}/test-message`, { method: 'POST', headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}
