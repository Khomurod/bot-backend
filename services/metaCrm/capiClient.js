'use strict';

/**
 * Meta Conversions API — the one call the stage sync makes:
 * POST https://graph.facebook.com/<version>/<dataset id>/events
 * — plus the two reads Settings → Facebook ↔ Bitrix uses to prove a token before
 * it is saved: `readTokenOwner` (GET /me — is the token alive) and
 * `readDatasetQuality` (GET /dataset_quality — can it see this dataset).
 *
 * WHY THOSE TWO AND NOT GET /<dataset id>. Checked against Meta on 27 October
 * 2026 with the owner's token: an Events Manager Conversions API token holds
 * one permission, `read_ads_dataset_quality`, so reading the dataset node
 * answers "(#100) Missing Permission" for a perfectly good token. The Dataset
 * Quality API answers 200 for the token's own dataset and code 24 for an id it
 * cannot see — and also for a dataset with no events in the last 48 hours.
 *
 * THE TOKEN IS A SECRET. It travels in the request BODY (or, for the reads, the
 * Authorization header), never the URL, so it cannot end up in an access log,
 * a proxy log or an error message that quotes the address. An error returned
 * from here carries Meta's own words and an HTTP status, with the token taken
 * out of them in case Meta ever echoes it (lib/security/redactSecret.js).
 *
 * `testEventCode` (Events Manager → Test events) marks a send as a TEST so it
 * shows under Test events. META DOES NOT DROP TEST EVENTS: they still reach the
 * dataset and may be used for targeting and measurement (Meta's Conversions API
 * docs). The stage sync never passes one; the settings Test only ever repeats
 * an event already sent (services/metaCrm/settingsTest.js).
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

/** A Graph GET with the token in the Authorization header. Never throws. */
async function graphGet(path, { token, graphVersion, fetchImpl = fetch, timeoutMs = TIMEOUT_MS }) {
  let response;
  try {
    response = await fetchImpl(`https://graph.facebook.com/${graphVersion}/${path}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    return networkFailure(err, timeoutMs);
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body?.error) return graphFailure(response, body, token);
  return { ok: true, body };
}

/** Is the token alive? GET /me → `{ ok: true, id }` (the system user it belongs to). */
async function readTokenOwner({ token, graphVersion, fetchImpl, timeoutMs }) {
  const res = await graphGet('me?fields=id', { token, graphVersion, fetchImpl, timeoutMs });
  return res.ok ? { ok: true, id: String(res.body?.id || '') } : res;
}

/**
 * Can this token see this dataset? GET /dataset_quality?dataset_id=… — a read
 * the Events Manager token is permitted. `{ ok: true }` or the failure shape
 * (code 24 = not visible to this token, OR no events in 48 hours).
 */
async function readDatasetQuality({ datasetId, token, graphVersion, fetchImpl, timeoutMs }) {
  const res = await graphGet(`dataset_quality?dataset_id=${encodeURIComponent(String(datasetId))}`, {
    token, graphVersion, fetchImpl, timeoutMs,
  });
  return res.ok ? { ok: true } : res;
}

module.exports = { sendEvents, readTokenOwner, readDatasetQuality, TIMEOUT_MS };
