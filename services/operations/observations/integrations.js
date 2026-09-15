'use strict';

/**
 * The integrations, each answered from evidence the application already stores.
 *
 * Split out of `healthObservations.js` at the 500-line cap. This is the half
 * that does NOT read the run ledger: a recruiter's RingCentral login, the AI
 * providers, how fresh the ELD positions are, whether Telegram is taking
 * notices, whether the after-hours recruiting reply has a window it can speak
 * in. Each is wrapped on its own, so a table that does not exist yet costs that
 * single answer rather than the whole pass.
 */
const { getServiceEntry } = require('../../../lib/operations/backgroundServiceCatalog');
const { classifyRun, RUN_STATES } = require('../../../lib/operations/runHealth');
const { afterHoursReadiness } = require('../../../lib/recruiting/readiness');
const {
  ELD_STALE_MINUTES, NOTICE_STUCK_MINUTES, minutesSince, integration,
} = require('./shape');

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
        ok: true, state: RUN_STATES.NEEDS_ATTENTION, blocked: true,
        reason: 'no recruiter has connected a RingCentral login yet',
      }));
    } else if (broken.length >= withCreds.length) {
      out.push(integration('recruiter_logins', {
        ok: false,
        detail: `all ${withCreds.length} recruiter logins need reconnecting`,
      }));
    } else {
      // Credentials look fine — but the DAILY REFRESH is what keeps them that
      // way, and a refresh job that stopped shows no symptom here until a token
      // expires seven days later. So the ledger's verdict on that job is folded
      // in rather than reported separately: "the logins work" and "nothing is
      // renewing them" must not be two green rows.
      // Optional-chained: a caller with no ledger loses the REFRESH half of
      // this answer, not the credential half. Letting it throw would drop the
      // whole observation into "could not read" and hide a real outage behind a
      // missing dependency.
      const row = await Promise.resolve(deps.runs?.getRun?.('recruiter_logins')).catch(() => null);
      const refresh = classifyRun(row, {
        now: nowMs, expectedIntervalSeconds: getServiceEntry('recruiter_logins')?.expectedIntervalSeconds,
      });
      out.push(integration('recruiter_logins', {
        ok: !refresh.actionable,
        state: refresh.actionable ? refresh.state : RUN_STATES.HEALTHY,
        detail: refresh.actionable
          ? `the daily token refresh ${refresh.reason}`
          : (broken.length ? `${broken.length} of ${withCreds.length} need reconnecting` : null),
        reason: broken.length
          ? `${broken.length} of ${withCreds.length} recruiter logins need reconnecting`
          : refresh.reason,
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
        ok: true, state: RUN_STATES.NEEDS_ATTENTION, blocked: true,
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
        // Switched off, or never pointed anywhere: both are somebody's setting,
        // not a system that broke.
        blocked: true,
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

  // CAN RETENTION HEAR THE DRIVERS AT ALL? Four of its signals — complaints,
  // quit signals, sentiment, gone-quiet — read `chat_logs`, and that table's
  // only writer has no caller because the bot deliberately stopped persisting
  // every group message. So they come back as reassuring ZEROS from a source
  // that is not listening, which is the worst answer a retention check can
  // give. Whether to record driver messages is the owner's privacy decision;
  // saying out loud that nobody is listening is not.
  try {
    const chat = await deps.retention.chatSignalsAvailable();
    out.push(integration('retention_chat_signals', {
      ok: true,
      // Whether to record driver messages is the owner's privacy decision, so
      // "nobody is listening" is a setting rather than a fault.
      blocked: !chat.available,
      state: chat.available ? RUN_STATES.HEALTHY : RUN_STATES.NEEDS_ATTENTION,
      reason: chat.available
        ? chat.reason
        : `${chat.reason}. The other retention signals — weeks on the road, a home `
          + 'window agreed and not honoured, unpaid bonuses — are unaffected.',
    }));
  } catch (_) {
    out.push(integration('retention_chat_signals', { ok: true, state: RUN_STATES.UNKNOWN, reason: 'could not read' }));
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
      // THE SETTINGS AS THEY INTERACT, not merely as they exist. A reply needs
      // the office closed AND not quiet hours; a schedule whose two halves cover
      // the week reported READY here with no moment any candidate could ever be
      // answered in. `hoursConfigured` above cannot see that — it is a boolean
      // about whether a row was saved.
      schedule: hours ? {
        timezone: hours.timezone,
        windows: hours.windows,
        quietStartLocal: hours.quietStartLocal,
        quietEndLocal: hours.quietEndLocal,
      } : null,
    });

    // READY IS NOT THE SAME AS REACHABLE, and that gap is this feature's
    // quietest failure. Every check above is a SETTING; none of them proves a
    // candidate's text can still arrive. Inbound SMS reaches this application
    // through a RingCentral webhook subscription created by the Python leads
    // engine, which sheds filters when a tenant refuses one and can lose the
    // subscription entirely — after which the feature reads "ready" and
    // answers nobody, forever, with no screen able to say why.
    //
    // Every inbound message already writes a mirror row, so the last one is
    // free to read and is the only honest evidence the path is alive.
    // Optional-chained: a caller that has not wired this dep must lose the
    // inbound EVIDENCE, never the readiness answer beside it.
    const inbound = await Promise.resolve(deps.smsMirrors?.summariseInboundSms?.())
      .catch(() => null);
    const neverInbound = inbound?.available === true && !inbound.everAt;

    out.push(integration('recruiting_after_hours', {
      ok: true,
      // Every blocker this check can report is somebody's decision, never a
      // fault — so an unready feature is `blocked`, not a failed system.
      blocked: !verdict.ready || neverInbound,
      state: (verdict.ready && !neverInbound)
        ? RUN_STATES.HEALTHY : RUN_STATES.NEEDS_ATTENTION,
      // The blockers NAMED, and where to fix each. A count on its own sends
      // somebody hunting through six settings screens.
      reason: verdict.ready
        ? (neverInbound
          ? 'Everything is configured, but no candidate SMS has ever reached this '
            + 'application — so the RingCentral inbound subscription may not be live. '
            + 'Check the leads engine log (Settings → RingCentral).'
          // READY, AND STILL WORTH A SENTENCE. A schedule can leave every
          // weekday evening unreachable and still be "working" because the
          // weekends are open. Nothing is broken, so this does not block — but
          // a candidate texting at 22:00 on a Tuesday is never answered, and
          // that is not something to find out from a complaint.
          : `${verdict.summary}`
            + `${verdict.unreachableDays?.length
              ? ` No candidate can be answered on ${verdict.unreachableDays.join(', ')} `
                + '— working hours and quiet hours meet on those days.' : ''}`
            + `${inbound?.lastAt ? ` Last candidate SMS ${inbound.lastAt}.` : ''}`)
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
      // The poller beats `blocked` when Samsara is switched off in the admin.
      // That verdict was being computed and then thrown away here.
      blocked: verdict.blocked === true,
      state: verdict.state,
      detail: verdict.actionable ? verdict.reason : null,
      reason: verdict.reason,
    }));
  } catch (_) {
    out.push(integration('samsara_safety_pipeline', { ok: true, state: RUN_STATES.UNKNOWN, reason: 'could not read' }));
  }

  return out;
}
module.exports = { integrationObservations };
