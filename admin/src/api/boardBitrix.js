/**
 * Settings → Dispatcher Board → Board ↔ Bitrix check: the switch, the counts,
 * and "check now". Counts only — the questions themselves go to the
 * Needs-attention group.
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

/** One pass now. → { summary, settings } */
export async function runBoardBitrixCheck() {
  const res = await fetch(`${API_BASE}/settings/board-bitrix/run`, { method: 'POST', headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}
