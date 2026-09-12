/**
 * Dispatcher Board connection — admin API client.
 *
 * The Board's token is write-only from this side: the read returns a masked
 * last-4 and the test proves a candidate WITHOUT the server ever sending it
 * back. Nothing here ever holds a token beyond the one form submission.
 */

import { API_BASE, getHeaders, handleApiError } from './http';

/** Masked Dispatcher Board settings (never returns the raw token). */
export async function getDispatchBoardSettings() {
  const res = await fetch(`${API_BASE}/settings/dispatch-board`, { headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  const data = await res.json();
  return data.settings;
}

/** Update the connection. Omit the token to leave it unchanged. */
export async function updateDispatchBoardSettings(payload) {
  const res = await fetch(`${API_BASE}/settings/dispatch-board`, {
    method: 'PUT', headers: getHeaders(), body: JSON.stringify(payload || {}),
  });
  if (!res.ok) { await handleApiError(res); }
  const data = await res.json();
  return data.settings;
}

/**
 * Test the connection, optionally with a candidate URL and token so it can be
 * proven before it is saved. Answers with counts and histograms only.
 */
export async function testDispatchBoardConnection({ baseUrl, token } = {}) {
  const body = {};
  if (baseUrl) body.baseUrl = baseUrl;
  if (token) body.token = token;
  const res = await fetch(`${API_BASE}/settings/dispatch-board/test`, {
    method: 'POST', headers: getHeaders(), body: JSON.stringify(body),
  });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}

/**
 * What the poller last stored — counts only, read from Wenze's own snapshot
 * rather than from the board.
 */
export async function getDispatchBoardFeed() {
  const res = await fetch(`${API_BASE}/settings/dispatch-board/feed`, { headers: getHeaders() });
  if (!res.ok) { await handleApiError(res); }
  return res.json();
}
