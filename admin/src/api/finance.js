/**
 * Finance Monitor — admin API client.
 *
 * The status read returns COUNTS ONLY, never message text, never a code and
 * never a sender. What the group actually said is payment data and lives in one
 * auditable place; a settings screen is asking "is this capturing, and does it
 * look right", which counts answer.
 */

import { API_BASE, getHeaders, handleApiError } from './http';

export async function getFinanceSettings() {
  const res = await fetch(`${API_BASE}/settings/finance`, { headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

/** Settings plus capture counts by parse status. */
export async function getFinanceStatus() {
  const res = await fetch(`${API_BASE}/settings/finance/status`, { headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

/**
 * Prove a candidate chat BEFORE saving it.
 *
 * A 400 here is a real answer — "that is not a group the bot can see" — so it
 * is returned rather than thrown, and the form shows the reason.
 */
export async function validateFinanceChat(chatId) {
  const res = await fetch(`${API_BASE}/settings/finance/validate-chat`, {
    method: 'POST',
    headers: { ...getHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ chatId }),
  });
  if (res.status === 400) return res.json();
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

/** Save. Omitted fields keep their stored value. */
export async function updateFinanceSettings(payload) {
  const res = await fetch(`${API_BASE}/settings/finance`, {
    method: 'PUT',
    headers: { ...getHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}
