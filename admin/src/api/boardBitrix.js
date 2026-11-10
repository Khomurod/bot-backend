/**
 * Settings → Dispatcher Board → Board ↔ Bitrix check: its switch, guarded
 * status-sync mode, counts, and "check now". Counts only — the questions
 * themselves go to the Needs-attention group.
 */
import { API_BASE, getHeaders, handleApiError } from './http';

export async function getBoardBitrixCheck() {
  const res = await fetch(`${API_BASE}/settings/board-bitrix`, { headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  const data = await res.json();
  return data.settings;
}

export async function setBoardBitrixCheckEnabled(enabled) {
  const res = await fetch(`${API_BASE}/settings/board-bitrix/enabled`, {
    method: 'PUT',
    headers: getHeaders(),
    body: JSON.stringify({ enabled }),
  });
  if (!res.ok) { await handleApiError(res); }
  const data = await res.json();
  return data.settings;
}

export async function setBoardBitrixSync({ syncMode, maxUpdatesPerPass, confirmLive = false }) {
  const res = await fetch(`${API_BASE}/settings/board-bitrix/sync`, {
    method: 'PUT',
    headers: getHeaders(),
    body: JSON.stringify({ syncMode, maxUpdatesPerPass, confirmLive }),
  });
  if (!res.ok) { await handleApiError(res); }
  const data = await res.json();
  return data.settings;
}

export async function approveBoardBitrixSchema() {
  const res = await fetch(`${API_BASE}/settings/board-bitrix/schema/approve`, {
    method: 'POST', headers: getHeaders(), body: JSON.stringify({ confirm: true }),
  });
  if (!res.ok) { await handleApiError(res); }
  const data = await res.json();
  return data.settings;
}

/** One pass now. → { summary, settings } */
export async function runBoardBitrixCheck() {
  const res = await fetch(`${API_BASE}/settings/board-bitrix/run`, { method: 'POST', headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}
