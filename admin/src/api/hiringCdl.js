/**
 * Where a candidate's CDL values go in Bitrix — admin API client (Settings →
 * Safety Approvals → 6). See docs/architecture/hiring-cdl-reading.md.
 *
 * Reading the Bitrix fields answers `{ ok: false, error }` rather than an HTTP
 * error when Bitrix cannot be read, so the card can say why.
 */

import { API_BASE, getHeaders, handleApiError } from './http';

const BASE = `${API_BASE}/settings/hiring-cdl`;
const JSON_HEADERS = () => ({ ...getHeaders(), 'Content-Type': 'application/json' });

/** { items, mapping, recent } — the CDL items, the saved mapping, how the latest reads ended. */
export async function getHiringCdl() {
  const res = await fetch(BASE, { headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

/** The live Bitrix field lists, read now: { ok, contact: [...], deal: [...] } or { ok: false, error }. */
export async function readHiringCdlBitrixFields() {
  const res = await fetch(`${BASE}/bitrix-fields`, { method: 'POST', headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

/** Save the whole mapping: [{ item, entity, fieldCode, fieldLabel, fieldType }]. */
export async function saveHiringCdlMapping(mapping) {
  const res = await fetch(BASE, { method: 'PUT', headers: JSON_HEADERS(), body: JSON.stringify({ mapping }) });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}
