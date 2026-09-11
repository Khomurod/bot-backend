'use strict';

/**
 * Noticing when a part of Wenze breaks, and when it puts itself right.
 *
 * THIS ADDS NO RECOVERY. Every recovery it reports already existed and has been
 * running silently for months: RingCentral refresh tokens rotate daily and at
 * boot, an AI provider in cooldown returns on its own timer, a retired model is
 * dropped and the next promoted, the durable outboxes back off and retry.
 *
 * What was missing is that all of it is invisible. "Wenze fixed itself" and
 * "Wenze has been broken for three days" look identical from outside, and the
 * second is the reason the first is worth saying.
 *
 * THE DIFFICULTY IS SAYING IT RARELY ENOUGH TO BE READ, which is entirely in
 * `lib/operations/healthTransitions.js` — pure, and the only place the rules
 * live. This file supplies observations and posts what it is told to. In
 * particular: a blip that self-corrects inside the failure threshold produces
 * ZERO messages, not one. Get that backwards and the "Wenze fixed itself"
 * channel fills with recoveries from failures nobody knew about.
 *
 * OBSERVATIONS ARE CHEAP AND ALREADY RECORDED. Nothing here probes an external
 * service — a health check that makes its own requests is a new way to be rate
 * limited. It reads what the application already stores about its last
 * attempts.
 */
const { observe, describeDuration } = require('../../lib/operations/healthTransitions');

const POLL_MS = 30 * 60 * 1000;
const FIRST_TICK_DELAY_MS = 10 * 60 * 1000;

function defaultDeps() {
  /* eslint-disable global-require */
  return {
    store: require('../../database/systemHealth'),
    notify: require('../notifications/send').notify,
    rc: require('../../database/ringcentral'),
    ai: require('../../database/aiProviders'),
    notifications: require('../../database/operationalNotifications'),
  };
  /* eslint-enable global-require */
}

/** What an operator should call each component, in a sentence. */
const LABELS = {
  recruiter_logins: 'recruiters\' RingCentral logins',
  ai_providers: 'the AI providers',
  notifications: 'the notification queue',
};

/**
 * What each component's health is, read from what the application already
 * recorded. Every one returns `{ ok, detail }` and none of them throws: a
 * component whose state cannot be read is reported as unknown and skipped,
 * never as failed, because "I could not check" is not "it is broken".
 */
async function gatherObservations(deps) {
  const out = [];

  // Recruiter logins. A refresh token expires in 7 days and the daily job
  // rotates it; `rc_auth_error` is what the panel renders as "needs to connect
  // again". ALL of them broken is an outage; one is a person's problem.
  try {
    const recruiters = await deps.rc.listRecruiters();
    const withCreds = (recruiters || []).filter((r) => deps.rc.recruiterCanSendSms(r));
    const broken = withCreds.filter((r) => r.rc_auth_error);
    if (withCreds.length > 0) {
      out.push({
        component: 'recruiter_logins',
        ok: broken.length < withCreds.length,
        detail: broken.length
          ? `${broken.length} of ${withCreds.length} recruiter logins need reconnecting`
          : null,
      });
    }
  } catch (_) { /* unknown, not failed */ }

  // AI. Every enabled provider in cooldown at once is an outage; one is the
  // router doing its job.
  try {
    const providers = await deps.ai.getProvidersForRouter();
    const enabled = (providers || []).filter((p) => p.enabled);
    if (enabled.length > 0) {
      const cooled = enabled.filter((p) => p.cooledUntil && new Date(p.cooledUntil) > new Date());
      out.push({
        component: 'ai_providers',
        ok: cooled.length < enabled.length,
        detail: cooled.length ? `all ${enabled.length} providers are in cooldown` : null,
      });
    }
  } catch (_) { /* unknown */ }

  // The notification queue. Something that has given up is the one failure that
  // silences every other feature's alarm, which is exactly how 101 staff alerts
  // were lost once already.
  try {
    const summary = await deps.notifications.summariseNotifications();
    out.push({
      component: 'notifications',
      ok: Number(summary?.abandoned || 0) === 0,
      detail: summary?.abandoned ? `${summary.abandoned} notices gave up undelivered` : null,
    });
  } catch (_) { /* unknown */ }

  return out;
}

/** The sentence for each kind of transition. Plain, and never alarming twice. */
function describeAnnouncement(announce) {
  const what = LABELS[announce.component] || announce.component;
  if (announce.kind === 'healed') {
    const how = describeDuration(announce.downForMs);
    return {
      category: 'self_healing',
      title: `${what} — working again${how ? ` after ${how}` : ''}`,
      lines: [announce.detail ? `It had been failing with: ${announce.detail}` : null].filter(Boolean),
      action: null,
      reason: 'Recovered without anybody doing anything. Nothing is needed.',
    };
  }
  if (announce.kind === 'flapping') {
    return {
      category: 'system_errors',
      title: `${what} — breaking and recovering repeatedly`,
      lines: [`${announce.transitions} changes of state in the last few hours.`],
      action: 'Worth looking at — it is recovering each time, so nothing has alarmed until now',
      reason: announce.detail,
    };
  }
  return {
    category: 'system_errors',
    title: `${what} — not working`,
    lines: [announce.detail].filter(Boolean),
    action: 'Needs a person; Wenze has not been able to recover from this one',
    reason: null,
  };
}

/** One observation: decide, store, and say something only if the rules say so. */
async function considerComponent(observation, { nowIso, deps, options }) {
  const previous = await deps.store.getHealthState(observation.component).catch(() => null);
  const { state, announce } = observe(previous, observation, { ...options, now: nowIso });

  await deps.store.saveHealthState(state);
  if (!announce) return { component: observation.component, announced: null };

  const notice = describeAnnouncement(announce);
  await deps.notify({
    ...notice,
    subjectType: 'system',
    subjectId: observation.component,
    // The kind and the day: a component that breaks, recovers and breaks again
    // tomorrow is two pieces of news, and the same day twice is one.
    discriminator: `${announce.kind}:${nowIso.slice(0, 13)}`,
    evidence: { component: observation.component, kind: announce.kind, detail: announce.detail },
  });

  return { component: observation.component, announced: announce.kind };
}

/** One pass. Never throws; a component that cannot be read costs that one only. */
async function runSelfHealingPass({ now = Date.now(), deps = defaultDeps(), options = {} } = {}) {
  const nowIso = new Date(now).toISOString();
  const summary = { checked: 0, announced: [], errors: [] };

  let observations;
  try {
    observations = await gatherObservations(deps);
  } catch (err) {
    return { ...summary, errors: [err.message] };
  }

  for (const observation of observations) {
    summary.checked += 1;
    try {
      // eslint-disable-next-line no-await-in-loop
      const out = await considerComponent(observation, { nowIso, deps, options });
      if (out.announced) summary.announced.push(`${out.component}:${out.announced}`);
    } catch (err) {
      summary.errors.push(`${observation.component}: ${err.message}`);
    }
  }

  return summary;
}

let timer = null;
let stopped = true;

async function tick() {
  try {
    const summary = await runSelfHealingPass({});
    if (summary.announced.length) {
      console.log(`[SELF-HEAL] ${summary.announced.join(', ')}`);
    }
  } catch (err) {
    console.warn('[SELF-HEAL] pass failed:', err.message);
  }
}

function startSelfHealingWatch() {
  stopped = false;
  console.log(`[SELF-HEAL] Watch started — every ${POLL_MS / 60000}min`);
  setTimeout(() => { if (!stopped) tick(); }, FIRST_TICK_DELAY_MS).unref?.();
  timer = setInterval(() => { if (!stopped) tick(); }, POLL_MS);
  timer.unref?.();
}

function stopSelfHealingWatch() {
  stopped = true;
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = {
  POLL_MS,
  FIRST_TICK_DELAY_MS,
  LABELS,
  defaultDeps,
  gatherObservations,
  describeAnnouncement,
  considerComponent,
  runSelfHealingPass,
  startSelfHealingWatch,
  stopSelfHealingWatch,
};
