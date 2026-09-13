'use strict';

/**
 * What every part of Wenze looks like right now, read from what it already
 * wrote down.
 *
 * WHAT THIS REPLACED. Self-healing watched THREE things — recruiter logins, AI
 * providers and the notification queue — while twenty-five background workers
 * and nine integrations ran beside them unobserved. A worker whose timer was
 * never armed produced exactly the same evidence as one that ran and found
 * nothing: an empty table and a silent channel.
 *
 * TWO KINDS OF OBSERVATION, and the distinction is the whole design.
 *
 *   FROM THE RUN LEDGER — "did this worker run?" Answerable for anything that
 *   calls `withRunRecord`, and answerable ACROSS A RESTART, which the three
 *   in-memory `lastRun` fields were not: a Render restart made them read null,
 *   indistinguishable from "this has never worked in its life".
 *
 *   FROM THE APPLICATION'S OWN RECORDS — "is this integration healthy?" Nothing
 *   here probes an external service. A health check that makes its own requests
 *   is a new way to be rate limited, and it measures the check's luck rather
 *   than the feature's.
 *
 * NOTHING HERE THROWS, and a component that cannot be read is reported as
 * `cannot_determine` rather than as healthy OR as failed. "I could not check"
 * is not "it is fine" — that conflation is the failure this file exists to
 * remove, and reintroducing it here would be the whole exercise wasted.
 *
 * WHERE THE REST OF IT LIVES. This file passed the 500-line cap and split along
 * the seam it already had: `observations/shape.js` holds the shape every
 * observation takes and the constants that decide it, `observations/integrations.js`
 * the nine hand-written integration checks. What is left here is the half that
 * reads the run ledger, and the gatherer that puts both together.
 */
const { CATALOG } = require('../../lib/operations/backgroundServiceCatalog');
const { classifyRun, RUN_STATES } = require('../../lib/operations/runHealth');
const {
  CUSTOM_INTEGRATIONS, BOOTED_AT, ELD_STALE_MINUTES, NOTICE_STUCK_MINUTES, integration,
} = require('./observations/shape');
const { integrationObservations } = require('./observations/integrations');

function defaultDeps() {
  /* eslint-disable global-require */
  return {
    runs: require('../../database/backgroundRuns'),
    rc: require('../../database/ringcentral'),
    ai: require('../../database/aiProviders'),
    notifications: require('../../database/operationalNotifications'),
    fuelReadings: require('../../database/truckFuelReadings'),
    notificationSettings: require('../../database/operationalNotificationSettings'),
    retention: require('../../database/retention'),
    recruitingHours: require('../../database/recruitingHours'),
    recruitingKnowledge: require('../../database/recruitingKnowledge'),
    smsMirrors: require('../../database/facebookLeads/smsMirrors'),
    capabilityGate: require('../ai/capabilityGate'),
  };
  /* eslint-enable global-require */
}

/**
 * Every catalogued worker, saying "I could not be read".
 *
 * A LEDGER READ THAT FAILED USED TO ANSWER WITH AN EMPTY LIST, and that is the
 * one answer it must never give. Every catalogued worker simply VANISHED:
 * `/api/health` showed a `workers` block with thirty fewer rows and nothing
 * wrong in any of them, the Systems tab showed the same, and the self-healing
 * pass recorded a clean run — it counts what it DROPPED for exactly this
 * reason, but a worker that produced no observation at all was never dropped,
 * it was never there.
 *
 * `cannot_determine` with `unknown: true` is the honest answer and it costs
 * nothing: the announcer skips unknowns, so no failure count starts for a
 * component nobody could check — the rule this file has always held — while the
 * pass's `unreadable` counter and the health endpoint both see the full list
 * and can say how much of the picture is missing.
 */
function unreadableWorkers(reason) {
  return CATALOG
    .filter((entry) => !(entry.group === 'integration' && CUSTOM_INTEGRATIONS.has(entry.key)))
    .map((entry) => ({
      component: entry.key,
      label: entry.label,
      group: entry.group,
      critical: entry.critical === true,
      unknown: true,
      blocked: false,
      ok: true,
      state: RUN_STATES.UNKNOWN,
      detail: null,
      reason: `the run ledger could not be read (${reason})`,
      lastRunAt: null,
      consecutiveFailures: 0,
    }));
}

/**
 * One observation per catalogued worker, from the ledger.
 *
 * `ok` is what the announcement rules in `lib/operations/healthTransitions.js`
 * consume and it is deliberately coarse — a worker is "not ok" only when its
 * state is ACTIONABLE. A single failed pass is degraded, and announcing
 * degraded is how a channel becomes unread.
 *
 * `state` is the full seven-state answer, carried alongside for /api/health,
 * which has room for nuance a Telegram message does not.
 */
async function workerObservations(deps, nowMs) {
  let byKey;
  try {
    byKey = await deps.runs.getRunMap();
  } catch (err) {
    return unreadableWorkers(err.message);
  }

  const out = [];
  for (const entry of CATALOG) {
    // Skip only the integrations that ACTUALLY HAVE a richer observation
    // below. Blanket-skipping the whole group made `datatruck_documents`
    // invisible everywhere despite its writing ledger records — a critical
    // component that appeared in neither the Systems tab nor the public worker
    // summary, which is precisely the kind of silent gap this mechanism exists
    // to close. `leads_bot` went the same way. Anything the list below does not
    // answer for falls through to its ledger row, where "never reported" is at
    // least an honest answer.
    if (entry.group === 'integration' && CUSTOM_INTEGRATIONS.has(entry.key)) continue;
    const row = byKey.get(entry.key) || null;
    const verdict = classifyRun(row, {
      now: nowMs,
      expectedIntervalSeconds: entry.expectedIntervalSeconds,
      bootedAtMs: BOOTED_AT,
      firstRunDelaySeconds: 30 * 60,
    });

    out.push({
      component: entry.key,
      label: entry.label,
      group: entry.group,
      critical: entry.critical === true,
      // An unknown is NOT an observation of failure and must not start a
      // failure count. It is carried for the health endpoint and skipped by
      // the announcer.
      unknown: verdict.state === RUN_STATES.UNKNOWN,
      // SWITCHED OFF IS NOT BROKEN. It still wants a person, so `actionable`
      // stays true and the workers block still lists it — but a component
      // waiting on a setting must never be counted as a failed system or
      // announced as "not working".
      blocked: verdict.blocked === true,
      ok: !verdict.actionable,
      state: verdict.state,
      detail: verdict.actionable ? verdict.reason : null,
      reason: verdict.reason,
      lastRunAt: row?.lastFinishedAt || null,
      consecutiveFailures: verdict.consecutiveFailures,
    });
  }
  return out;
}


/**
 * Everything, workers and integrations together. Never throws.
 *
 * A half that fails wholesale answers `cannot_determine` for everything it
 * covers rather than `[]`. The difference is not cosmetic: an empty list is
 * indistinguishable from "there is nothing to watch", and a caller counting
 * what it could not read cannot count something that was never handed to it.
 */
async function gatherAllObservations(deps = defaultDeps(), { now = Date.now() } = {}) {
  const [workers, integrations] = await Promise.all([
    workerObservations(deps, now).catch((err) => unreadableWorkers(err.message)),
    integrationObservations(deps, now).catch((err) => [...CUSTOM_INTEGRATIONS].map(
      (key) => integration(key, {
        ok: true, state: RUN_STATES.UNKNOWN,
        reason: `could not be read (${err.message})`,
      }),
    )),
  ]);
  return [...workers, ...integrations];
}

module.exports = {
  BOOTED_AT,
  ELD_STALE_MINUTES,
  NOTICE_STUCK_MINUTES,
  defaultDeps,
  workerObservations,
  integrationObservations,
  gatherAllObservations,
};
