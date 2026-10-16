/**
 * Safety Approvals — admin API client (Settings → Safety Approvals).
 *
 * Validation and the test post answer with `{ ok: false, message }` rather
 * than an HTTP error, so the tab can show the reason.
 */

import { API_BASE, getHeaders, handleApiError } from './http';

const BASE = `${API_BASE}/settings/safety-approvals`;
const JSON_HEADERS = () => ({ ...getHeaders(), 'Content-Type': 'application/json' });

/** Settings, the people seen in the group, and the latest reviews. */
export async function getSafetyApprovals() {
  const res = await fetch(BASE, { headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function validateSafetyApprovalChat(chatId) {
  const res = await fetch(`${BASE}/validate-chat`, {
    method: 'POST', headers: JSON_HEADERS(), body: JSON.stringify({ chatId }),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

/** Save. Omitted fields keep their stored value. */
export async function updateSafetyApprovals(payload) {
  const res = await fetch(BASE, { method: 'PUT', headers: JSON_HEADERS(), body: JSON.stringify(payload) });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

export async function sendSafetyApprovalTestPost() {
  const res = await fetch(`${BASE}/test-post`, { method: 'POST', headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}
