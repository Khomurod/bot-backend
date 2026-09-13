'use strict';

/**
 * The SHAPE every observation takes, and the constants that decide it.
 *
 * Split out of `healthObservations.js` when that file passed the 500-line cap:
 * the worker half reads the run ledger, the integration half reads the evidence
 * each integration already stores, and both answer in this one shape. Keeping
 * the shape in one module is what stops a component answering two different
 * things in one payload, which is a mistake this file's own comments record
 * having made once already.
 */
const { getServiceEntry } = require('../../../lib/operations/backgroundServiceCatalog');
const { RUN_STATES } = require('../../../lib/operations/runHealth');

/**
 * Integrations answered by `integrationObservations` from richer evidence than
 * "did a timer fire". Everything else in the catalogue — including integrations
 * — is answered from the run ledger.
 *
 * KEEPING THIS LIST HONEST IS THE POINT. It used to be the whole
 * `group === 'integration'` predicate, which silently dropped every integration
 * without a hand-written branch. `tests/backgroundServiceCatalog.test.js`
 * asserts every entry is observable one way or the other.
 */
const CUSTOM_INTEGRATIONS = new Set([
  'recruiter_logins', 'ai_providers', 'eld_location_freshness', 'telegram_delivery',
  'notifications', 'notification_destination', 'samsara_safety_pipeline',
  'recruiting_after_hours', 'retention_chat_signals',
]);

/** When this process started, so a first pass that is not due yet is not "stopped". */
const BOOTED_AT = Date.now();

/** How stale a fleet position may be before the ELD feed is not answering. */
const ELD_STALE_MINUTES = 180;
/** A notice sitting undelivered this long means Telegram is not taking them. */
const NOTICE_STUCK_MINUTES = 90;

function minutesSince(value, nowMs) {
  const t = value ? new Date(value).getTime() : NaN;
  if (!Number.isFinite(t)) return null;
  return (nowMs - t) / 60000;
}

/**
 * Shape an integration answer the same way a worker answer is shaped.
 *
 * `blocked` USED TO BE HARDCODED FALSE HERE, and that made a component answer
 * two different things in one payload. A custom integration that is merely
 * UNCONFIGURED — no recruiter has connected a login, no AI provider is enabled,
 * nobody has finished the after-hours setup — was pushed with `ok: true` and a
 * `needs_human_attention` state, so it appeared in the workers attention list
 * and was counted as a WORKING SYSTEM at the same time. The nine custom
 * integrations are exactly the ones most likely to be half-configured, and they
 * were the only ones that could not say so.
 *
 * A blocked component is still `ok` — nothing is broken — but it is recorded as
 * `blocked` rather than `ok`, so `systems` names it under `waiting` instead of
 * counting it among the healthy.
 */
function integration(key, { ok, detail = null, state = null, reason = null, blocked = false }) {
  const entry = getServiceEntry(key);
  return {
    component: key,
    label: entry?.label || key,
    group: 'integration',
    critical: entry?.critical === true,
    unknown: state === RUN_STATES.UNKNOWN,
    blocked: blocked === true,
    ok,
    state: state || (ok ? RUN_STATES.HEALTHY : RUN_STATES.FAILING),
    detail,
    reason: reason || detail,
    lastRunAt: null,
    consecutiveFailures: 0,
  };
}


module.exports = {
  CUSTOM_INTEGRATIONS, BOOTED_AT, ELD_STALE_MINUTES, NOTICE_STUCK_MINUTES,
  minutesSince, integration,
};
