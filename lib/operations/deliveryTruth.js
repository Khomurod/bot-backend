/**
 * Is something that should be ARRIVING actually arriving? PURE — no I/O.
 *
 * WHY THIS EXISTS. On 2026-10-02 /api/health answered `systems.failed: 0`
 * while two features were dead:
 *
 *   - the Samsara poller had picked up 8 safety events and 0 had been stored —
 *     the reconciliation beside it SAID "events_lost", and nothing read it;
 *   - none of the 29 home-time notices of the past week had reached the three
 *     managers — the outbox counted 26 failures, and nothing read that either.
 *
 * Both workers RAN on schedule, so a "did the pass finish" check called them
 * healthy. The question here is the other one: did the thing the pass exists
 * to produce actually get produced. Each answer is a fact counted from the
 * system's own rows, never an inference, and "I cannot tell" is never "fine".
 */

/**
 * Do the poller's count and the stored rows agree?
 *
 * Moved here unchanged in its states from services/operations/healthSummary.js
 * so the health page and the self-healing watch read ONE definition.
 */
function reconcileSafetyCounts(seen, recorded) {
  if (seen == null) return { state: 'cannot_determine', reason: 'the poller reports no running total yet' };
  if (recorded == null) return { state: 'cannot_determine', reason: 'the recorded rows could not be counted' };
  if (seen === 0 && recorded === 0) {
    return { state: 'reconciled', reason: 'the poller has picked up nothing, and nothing was recorded' };
  }
  if (recorded >= seen) {
    return { state: 'reconciled', reason: `${seen} event(s) picked up, ${recorded} row(s) recorded` };
  }
  return {
    state: 'events_lost',
    reason: `the poller picked up ${seen} event(s) since it booted and only ${recorded} `
      + 'row(s) were recorded — events are arriving and not being stored',
  };
}

/**
 * Lost ENOUGH that a person must look?
 *
 * Not every gap is a fault. An event is counted when the poller sees it and
 * stored a moment later when delivery starts, so a single in-flight event reads
 * as one lost; an event already stored in a previous boot and seen again stores
 * nothing new. Three or more missing AND fewer than half kept is past both of
 * those, and is exactly the production shape (8 seen, 0 kept).
 */
const SAFETY_MIN_LOST = 3;

function safetyLossNeedsAPerson(seen, recorded) {
  if (!Number.isFinite(seen) || !Number.isFinite(recorded)) return false;
  const lost = seen - recorded;
  return lost >= SAFETY_MIN_LOST && recorded * 2 < seen;
}

/**
 * The managers' home-time notices: are they reaching anyone?
 *
 * `byEvent` is the seven-day summary from database/homeTime/observability.js.
 * Broken means at least three settled as failed and MORE failed than were
 * delivered. A Telegram hiccup that failed one and delivered the rest is not
 * this; "29 recorded, 0 delivered" is.
 */
const NOTICE_MIN_FAILED = 3;

function assessNoticeOutbox(byEvent) {
  if (!byEvent || typeof byEvent !== 'object') {
    return { ok: true, known: false, reason: 'the notice outbox could not be read' };
  }
  const totals = { rows: 0, delivered: 0, failed: 0, pending: 0 };
  for (const v of Object.values(byEvent)) {
    totals.rows += Number(v?.rows) || 0;
    totals.delivered += Number(v?.delivered) || 0;
    totals.failed += Number(v?.failed) || 0;
    totals.pending += Number(v?.pending) || 0;
  }
  if (totals.failed >= NOTICE_MIN_FAILED && totals.failed > totals.delivered) {
    const head = totals.delivered === 0
      ? `none of the ${totals.rows} home-time notice(s) of the past week reached the managers`
      : `${totals.failed} of the ${totals.rows} home-time notice(s) of the past week failed to reach the managers`;
    return { ok: false, known: true, totals, reason: `${head} (${totals.failed} failed, ${totals.delivered} delivered)` };
  }
  return {
    ok: true,
    known: true,
    totals,
    reason: totals.rows === 0
      ? 'no home-time notice in the past week'
      : `${totals.delivered} of ${totals.rows} delivered in the past week`,
  };
}

/**
 * A Telegram error, fit for a PUBLIC health endpoint.
 *
 * Telegram's own texts ("Bad Request: chat not found") are what a person needs
 * to fix the cause, so they are kept. Anything that could be an id or a token
 * — a run of six or more digits, a bot token, a URL — is removed.
 */
function publicTelegramError(text) {
  if (!text) return null;
  return String(text)
    .replace(/https?:\/\/\S+/g, '[url]')
    .replace(/\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g, '[token]')
    .replace(/-?\d{6,}/g, '[id]')
    .slice(0, 160);
}

module.exports = {
  SAFETY_MIN_LOST,
  NOTICE_MIN_FAILED,
  reconcileSafetyCounts,
  safetyLossNeedsAPerson,
  assessNoticeOutbox,
  publicTelegramError,
};
