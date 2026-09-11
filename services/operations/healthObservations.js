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
 */
const { CATALOG, getServiceEntry } = require('../../lib/operations/backgroundServiceCatalog');
const { classifyRun, RUN_STATES } = require('../../lib/operations/runHealth');
const { afterHoursReadiness } = require('../../lib/recruiting/readiness');

/** When this process started, so a first pass that is not due yet is not "stopped". */
const BOOTED_AT = Date.now();

/** How stale a fleet position may be before the ELD feed is not answering. */
const ELD_STALE_MINUTES = 180;
/** A notice sitting undelivered this long means Telegram is not taking them. */
const NOTICE_STUCK_MINUTES = 90;

function defaultDeps() {
  /* eslint-disable global-require */
  return {
    runs: require('../../database/backgroundRuns'),
    rc: require('../../database/ringcentral'),
    ai: require('../../database/aiProviders'),
    notifications: require('../../database/operationalNotifications'),
    fuelReadings: require('../../database/truckFuelReadings'),
    notificationSettings: require('../../database/operationalNotificationSettings'),
    recruitingHours: require('../../database/recruitingHours'),
    recruitingKnowledge: require('../../database/recruitingKnowledge'),
    capabilityGate: require('../ai/capabilityGate'),
  };
  /* eslint-enable global-require */
}

function minutesSince(value, nowMs) {
  const t = value ? new Date(value).getTime() : NaN;
  if (!Number.isFinite(t)) return null;
  return (nowMs - t) / 60000;
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
  } catch (_) {
    return [];
  }

  const out = [];
  for (const entry of CATALOG) {
    // Only the workers; the integrations below answer for themselves from
    // richer evidence than "did a timer fire".
    if (entry.group === 'integration') continue;
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

/** Shape an integration answer the same way a worker answer is shaped. */
function integration(key, { ok, detail = null, state = null, reason = null }) {
  const entry = getServiceEntry(key);
  return {
    component: key,
    label: entry?.label || key,
    group: 'integration',
    critical: entry?.critical === true,
    unknown: state === RUN_STATES.UNKNOWN,
    ok,
    state: state || (ok ? RUN_STATES.HEALTHY : RUN_STATES.FAILING),
    detail,
    reason: reason || detail,
    lastRunAt: null,
    consecutiveFailures: 0,
  };
}

/**
 * The integrations, each from evidence the application already stores.
 *
 * Every one is wrapped on its own, so a table that does not exist yet costs
 * that single answer rather than the whole pass.
 */
async function integrationObservations(deps, nowMs) {
  const out = [];

  // Recruiter logins. A refresh token expires in 7 days and the daily job
  // rotates it; `rc_auth_error` is what the panel renders as "needs to connect
  // again". ALL of them broken is an outage; one is a person's problem.
  try {
    const recruiters = await deps.rc.listRecruiters();
    const withCreds = (recruiters || []).filter((r) => deps.rc.recruiterCanSendSms(r));
    const broken = withCreds.filter((r) => r.rc_auth_error);
    if (withCreds.length === 0) {
      out.push(integration('recruiter_logins', {
        ok: true, state: RUN_STATES.NEEDS_ATTENTION,
        reason: 'no recruiter has connected a RingCentral login yet',
      }));
    } else {
      out.push(integration('recruiter_logins', {
        ok: broken.length < withCreds.length,
        detail: broken.length
          ? `${broken.length} of ${withCreds.length} recruiter logins need reconnecting`
          : null,
      }));
    }
  } catch (_) {
    out.push(integration('recruiter_logins', { ok: true, state: RUN_STATES.UNKNOWN, reason: 'could not read' }));
  }

  // AI. Every enabled provider in cooldown at once is an outage; one is the
  // router doing its job.
  try {
    const providers = await deps.ai.getProvidersForRouter();
    const enabled = (providers || []).filter((p) => p.enabled);
    if (enabled.length === 0) {
      out.push(integration('ai_providers', {
        ok: true, state: RUN_STATES.NEEDS_ATTENTION,
        reason: 'no AI provider is enabled — every AI feature is on its deterministic fallback',
      }));
    } else {
      const cooled = enabled.filter((p) => p.cooledUntil && new Date(p.cooledUntil) > new Date());
      out.push(integration('ai_providers', {
        ok: cooled.length < enabled.length,
        detail: cooled.length === enabled.length ? `all ${enabled.length} providers are in cooldown` : null,
      }));
    }
  } catch (_) {
    out.push(integration('ai_providers', { ok: true, state: RUN_STATES.UNKNOWN, reason: 'could not read' }));
  }

  // THE ELD FEED, answered by the fuel watch's own readings. Every pass writes
  // one row per truck it could locate, so the age of the newest row is the age
  // of the fleet's freshest position — and a feed that stopped answering shows
  // up here rather than as silence from four separate features.
  try {
    const fuel = await deps.fuelReadings.summariseFuelReadings();
    const age = minutesSince(fuel?.newestReading, nowMs);
    if (!fuel || fuel.trucks === 0 || age === null) {
      out.push(integration('eld_location_freshness', {
        ok: true, state: RUN_STATES.UNKNOWN,
        reason: 'no position has been recorded yet',
      }));
    } else {
      out.push(integration('eld_location_freshness', {
        ok: age <= ELD_STALE_MINUTES,
        detail: age > ELD_STALE_MINUTES
          ? `the newest truck position is ${Math.round(age / 60)} hours old`
          : null,
      }));
    }
  } catch (_) {
    out.push(integration('eld_location_freshness', { ok: true, state: RUN_STATES.UNKNOWN, reason: 'could not read' }));
  }

  // TELEGRAM, answered by the outbox. A notice that has been pending for an
  // hour and a half is not a slow queue, it is a queue nothing is taking from —
  // which is the exact failure that lost 101 staff alerts, seen from the one
  // place that can see it.
  try {
    const n = await deps.notifications.summariseNotifications();
    const stuck = minutesSince(n?.oldestPendingAt, nowMs);
    out.push(integration('telegram_delivery', {
      ok: !(stuck !== null && stuck > NOTICE_STUCK_MINUTES),
      detail: stuck !== null && stuck > NOTICE_STUCK_MINUTES
        ? `a notice has been waiting ${Math.round(stuck / 60)} hours to be delivered`
        : null,
    }));
    out.push(integration('notifications', {
      ok: Number(n?.abandoned || 0) === 0,
      detail: n?.abandoned ? `${n.abandoned} notices gave up undelivered` : null,
    }));
  } catch (_) {
    out.push(integration('telegram_delivery', { ok: true, state: RUN_STATES.UNKNOWN, reason: 'could not read' }));
    out.push(integration('notifications', { ok: true, state: RUN_STATES.UNKNOWN, reason: 'could not read' }));
  }

  // WHERE ANYTHING GOES AT ALL. With no destination configured every notice is
  // discarded at the door — correctly, because enqueuing them would flood a
  // staff chat with months of stale alerts the day somebody finally sets one.
  // The cost of that decision is what was invisible: features running, working,
  // and silent. The DISCARD COUNT makes it a number rather than a grey note.
  try {
    const config = await deps.notificationSettings.getNotificationSettings();
    const overrides = Object.values(config?.categoryChatIds || {})
      .filter((v) => String(v || '').trim()).length;
    const hasDefault = Boolean(String(config?.defaultChatId || '').trim());
    const reachable = config?.enabled !== false && (hasDefault || overrides > 0);

    if (reachable) {
      out.push(integration('notification_destination', { ok: true, reason: 'a destination is set' }));
    } else {
      const discards = await deps.notifications.summariseDiscards().catch(() => null);
      const n = discards?.total || 0;
      out.push(integration('notification_destination', {
        ok: true,
        state: RUN_STATES.NEEDS_ATTENTION,
        reason: config?.enabled === false
          ? `notifications are switched off${n ? ` — ${n} notices discarded so far` : ''}`
          : 'no Telegram group is configured, so every alert is discarded'
            + `${n ? ` — ${n} so far` : ''}. Set one in Settings → Notifications.`,
      }));
    }
  } catch (_) {
    out.push(integration('notification_destination', { ok: true, state: RUN_STATES.UNKNOWN, reason: 'could not read' }));
  }

  // ANSWERING A CANDIDATE AFTER HOURS. Five independent preconditions, every
  // one of them somebody's decision rather than a fault — and missing any of
  // them makes the feature silently inert: a candidate texts at 9pm on a Friday
  // and hears nothing until Monday, which is what it was built to prevent.
  // `afterHoursReply` names its exits, which is right for a log and wrong for a
  // screen: by the time it has a reason there is already a candidate waiting.
  try {
    const [hours, knowledge, recruiters, providers] = await Promise.all([
      deps.recruitingHours.getRecruitingHours().catch(() => null),
      deps.recruitingKnowledge.summariseKnowledge().catch(() => null),
      deps.rc.listRecruiters().catch(() => []),
      deps.ai.getProvidersForRouter().catch(() => []),
    ]);
    const capabilityEnabled = await deps.capabilityGate
      .isCapabilityEnabled('recruiting_after_hours_reply').catch(() => false);

    const verdict = afterHoursReadiness({
      afterHoursEnabled: hours?.aiAfterHoursEnabled === true,
      hoursConfigured: Array.isArray(hours?.windows) && hours.windows.length > 0,
      approvedStatements: knowledge?.active || 0,
      capabilityEnabled,
      aiProviderEnabled: (providers || []).some((p) => p.enabled),
      recruitersWithSms: (recruiters || []).filter((r) => deps.rc.recruiterCanSendSms(r)).length,
    });

    out.push(integration('recruiting_after_hours', {
      ok: true,
      state: verdict.ready ? RUN_STATES.HEALTHY : RUN_STATES.NEEDS_ATTENTION,
      // The blockers NAMED, and where to fix each. A count on its own sends
      // somebody hunting through six settings screens.
      reason: verdict.ready
        ? verdict.summary
        : `${verdict.summary} ${verdict.blockers.map((b) => `${b.what} (${b.where})`).join(' ')}`,
    }));
  } catch (_) {
    out.push(integration('recruiting_after_hours', { ok: true, state: RUN_STATES.UNKNOWN, reason: 'could not read' }));
  }

  // THE SAMSARA POLLER, which is a SEPARATE RENDER SERVICE and shares only this
  // database. It writes its own heartbeat into the same ledger, so a poller
  // that stopped is visible from here — and until this existed, the only
  // evidence was an empty safety table, which a quiet fleet also produces.
  try {
    const row = await deps.runs.getRun('samsara_safety_pipeline');
    const entry = getServiceEntry('samsara_safety_pipeline');
    const verdict = classifyRun(row, {
      now: nowMs, expectedIntervalSeconds: entry.expectedIntervalSeconds,
    });
    out.push(integration('samsara_safety_pipeline', {
      ok: !verdict.actionable,
      state: verdict.state,
      detail: verdict.actionable ? verdict.reason : null,
      reason: verdict.reason,
    }));
  } catch (_) {
    out.push(integration('samsara_safety_pipeline', { ok: true, state: RUN_STATES.UNKNOWN, reason: 'could not read' }));
  }

  return out;
}

/** Everything, workers and integrations together. Never throws. */
async function gatherAllObservations(deps = defaultDeps(), { now = Date.now() } = {}) {
  const [workers, integrations] = await Promise.all([
    workerObservations(deps, now).catch(() => []),
    integrationObservations(deps, now).catch(() => []),
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
