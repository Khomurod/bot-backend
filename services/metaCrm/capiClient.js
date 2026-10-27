'use strict';

/**
 * Meta Conversions API — the one call the stage sync makes:
 * POST https://graph.facebook.com/<version>/<dataset id>/events
 *
 * THE TOKEN IS A SECRET. It travels in the request BODY, never the URL, so it
 * cannot end up in an access log, a proxy log or an error message that quotes
 * the address. An error returned from here carries Meta's own words and an
 * HTTP status — nothing this module was given.
 *
 * Bounded by a timeout: a Graph API that hangs must not hold the pass open.
 * Never throws; the caller decides what a failure means.
 */

const TIMEOUT_MS = 15_000;

/**
 * Send events to a dataset. Returns `{ ok: true, received }` or
 * `{ ok: false, error, retryable }`.
 */
async function sendEvents({
  datasetId, token, events, graphVersion, fetchImpl = fetch, timeoutMs = TIMEOUT_MS,
}) {
  const url = `https://graph.facebook.com/${graphVersion}/${encodeURIComponent(String(datasetId))}/events`;
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: events, access_token: token }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return { ok: false, retryable: true, error: timedOut ? `Meta did not answer in ${timeoutMs}ms` : 'Meta unreachable' };
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body?.error) {
    const e = body?.error || {};
    const words = String(e.error_user_msg || e.message || `HTTP ${response.status}`).slice(0, 200);
    return {
      ok: false,
      retryable: response.status >= 500 || response.status === 429,
      error: `Meta ${response.status}${e.code ? ` (code ${e.code})` : ''}: ${words}`,
    };
  }
  return { ok: true, received: Number(body?.events_received) || 0 };
}

module.exports = { sendEvents, TIMEOUT_MS };
