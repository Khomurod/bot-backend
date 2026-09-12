import { API_BASE, getHeaders, handleApiError } from './http';

/**
 * The control channel: whether Wenze may ask questions in Telegram, and who it
 * obeys when somebody answers.
 */
export async function getControlSettings() {
  const res = await fetch(`${API_BASE}/settings/control`, { headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

/** Omitted fields keep their stored value. */
export async function updateControlSettings(payload) {
  const res = await fetch(`${API_BASE}/settings/control`, {
    method: 'PUT', headers: getHeaders(), body: JSON.stringify(payload),
  });
  if (!res.ok) { await handleApiError(res); }
  const data = await res.json();
  return data.settings;
}

/** A numeric Telegram user id — never a username. */
export async function addControlOperator({ telegramUserId, label }) {
  const res = await fetch(`${API_BASE}/settings/control/operators`, {
    method: 'POST', headers: getHeaders(), body: JSON.stringify({ telegramUserId, label }),
  });
  if (!res.ok) { await handleApiError(res); }
  const data = await res.json();
  return data.operator;
}

/** Refused by the server when it would leave nobody able to answer. */
export async function removeControlOperator(telegramUserId) {
  const res = await fetch(`${API_BASE}/settings/control/operators/${encodeURIComponent(telegramUserId)}`, {
    method: 'DELETE', headers: getHeaders(),
  });
  if (!res.ok) { await handleApiError(res); }
  const data = await res.json();
  return data.removed;
}
