'use strict';

/**
 * Meta Conversions API — the one call the stage sync makes:
 * POST https://graph.facebook.com/<version>/<dataset id>/events
 * — plus the read Settings → Facebook ↔ Bitrix uses to prove a token can see a
 * dataset before it is saved (`readDataset`).
 *
 * THE TOKEN IS A SECRET. It travels in the request BODY (or, for the read, the
 * Authorization header), never the URL, so it cannot end up in an access log,
 * a proxy log or an error message that quotes the address. An error returned
 * from here carries Meta's own words and an HTTP status, with the token taken
 * out of them in case Meta ever echoes it (lib/security/redactSecret.js).
 *
 * `testEventCode` (Events Manager → Test events) marks a send as a TEST: it
 * shows in Test events and does not count for ad optimization. The stage sync
 * never passes one; the settings Test always does.
 *
 * Bounded by a timeout: a Graph API that hangs must not hold the pass open.
 * Never throws; the caller decides what a failure means.
 */

const { redactSecret } = require('../../lib/security/redactSecret');

const TIMEOUT_MS = 15_000;

function networkFailure(err, timeoutMs) {
  const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
  return { ok: false, retryable: true, timedOut, error: timedOut ? `Meta did not answer in ${timeoutMs}ms` : 'Meta unreachable' };
}

function graphFailure(response, body, token) {
  const e = body?.error || {};
  const words = redactSecret(String(e.error_user_msg || e.message || `HTTP ${response.status}`), token).slice(0, 200);
  return {
    ok: false,
    retryable: response.status >= 500 || response.status === 429,
    status: response.status,
    code: e.code ?? null,
    subcode: e.error_subcode ?? null,
    error: `Meta ${response.status}${e.code ? ` (code ${e.code})` : ''}: ${words}`,
  };
}

/**
 * Send events to a dataset. Returns `{ ok: true, received }` or
 * `{ ok: false, error, retryable }`.
 */
async function sendEvents({
  datasetId, token, events, graphVersion, testEventCode = '', fetchImpl = fetch, timeoutMs = TIMEOUT_MS,
}) {
  const url = `https://graph.facebook.com/${graphVersion}/${encodeURIComponent(String(datasetId))}/events`;
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        data: events,
        access_token: token,
        ...(testEventCode ? { test_event_code: String(testEventCode) } : {}),
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    return networkFailure(err, timeoutMs);
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body?.error) return graphFailure(response, body, token);
  return { ok: true, received: Number(body?.events_received) || 0 };
}

/**
 * Can this token see this dataset? GET /<dataset id>?fields=id,name with the
 * token in the Authorization header. Returns `{ ok: true, id, name }` or the
 * same failure shape as sendEvents (with Meta's `code` / `subcode`). Never
 * throws; reads only.
 */
async function readDataset({
  datasetId, token, graphVersion, fetchImpl = fetch, timeoutMs = TIMEOUT_MS,
}) {
  const url = `https://graph.facebook.com/${graphVersion}/${encodeURIComponent(String(datasetId))}?fields=id,name`;
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    return networkFailure(err, timeoutMs);
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body?.error) return graphFailure(response, body, token);
  return { ok: true, id: String(body?.id || ''), name: body?.name ? String(body.name).slice(0, 120) : null };
}

module.exports = { sendEvents, readDataset, TIMEOUT_MS };
