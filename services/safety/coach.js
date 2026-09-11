/**
 * Saying something useful to a driver about a habit, once.
 *
 * THE HARD LINE, stated here and enforced below: AI NEVER DECIDES WHETHER A
 * DRIVER IS COACHED, ONLY HOW THE SENTENCE READS. The decision is arithmetic —
 * this many events of this kind in this window, and not said recently — and it
 * happens in `lib/safety/patterns.js`, which is pure and has no model in it.
 * With no AI at all every driver who should be coached still is, in a fixed
 * sentence. The model makes the wording less robotic and nothing else.
 *
 * AND: NOTHING HERE DECIDES ANYTHING ABOUT A PERSON'S JOB. No score, no
 * ranking, no fine, no recommendation about employment. The message says what
 * happened and what to do differently. What that MEANS about a driver is a
 * human judgement, and the prompt is written to keep a model from straying into
 * it — `docs/architecture/ai-decisions.md` records the verdict.
 *
 * The tone is deliberate. A driver who feels accused stops reading, and the one
 * message that mattered is the one they skipped.
 */
const { findPatterns, COACHING_POINT } = require('../../lib/safety/patterns');
const { withRunRecord } = require('../operations/runLedger');

const CAPABILITY = 'safety_coaching_message';
const POLL_MS = 6 * 60 * 60 * 1000;
const FIRST_TICK_DELAY_MS = 20 * 60 * 1000;

function defaultDeps() {
  /* eslint-disable global-require */
  return {
    store: require('../../database/driverSafety'),
    groups: require('../../database/groups'),
    runCapability: require('../ai/router').runCapability,
    isCapabilityEnabled: require('../ai/capabilityGate').isCapabilityEnabled,
    notify: require('../notifications/send').notify,
    driverChannel: require('../homeTimeDriverChannel'),
    get telegram() {
      try {
        // eslint-disable-next-line global-require
        return require('../../bot/bot').bot?.telegram || null;
      } catch (_) { return null; }
    },
  };
  /* eslint-enable global-require */
}

/**
 * The message, without a model.
 *
 * This is the one that actually ships when anything goes wrong, so it has to be
 * good on its own rather than a placeholder. It names the habit, the count and
 * the window, gives the one thing to do differently, and stops.
 */
function buildFallbackMessage({ driverName, pattern }) {
  const first = String(driverName || '').trim().split(/\s+/)[0] || 'Hi';
  const what = pattern.behavior.replace(/_/g, ' ');
  const advice = COACHING_POINT[pattern.behavior] || 'easing off a little';
  return `Hi ${first} — the truck logged ${pattern.count} ${what} events in the last `
    + `${pattern.windowDays} days. Nothing to worry about, just worth ${advice}. `
    + `Thanks for keeping it safe out there.`;
}

/** What the model is given: counts and a behaviour name. No names, no locations. */
function buildPrompt({ pattern, firstName }) {
  return [
    'You write one short, friendly message from a trucking company to one of its drivers.',
    'It is a gentle nudge about a driving habit, not a warning and not a reprimand.',
    '',
    `Driver first name: ${firstName || '(unknown)'}`,
    `Habit: ${pattern.behavior.replace(/_/g, ' ')}`,
    `How many times in the last ${pattern.windowDays} days: ${pattern.count}`,
    `The one thing that helps: ${pattern.coachingPoint || 'easing off a little'}`,
    '',
    'Rules:',
    '- Two sentences. Plain text. No markdown, no emoji, no hashtags.',
    '- Warm and matter-of-fact. Never accusing, never alarming.',
    '- Say the number and the habit, then the one thing that helps.',
    '- Do NOT mention discipline, pay, points, scores, fines, warnings, or their job.',
    '- Do NOT invent any detail that is not above — no dates, no places, no speeds.',
    '- Do NOT ask them to reply.',
  ].join('\n');
}

/** Reject anything a model returns that strays where it must not go. */
function validateCoachingText(raw) {
  const text = String(raw || '').trim();
  if (text.length < 40) return { message: 'too short to be a real message' };
  if (text.length > 400) return { message: 'too long for a driver group' };
  // THE BRIGHT LINE. A model that reaches for a consequence is not used.
  //
  // Deliberately broad, and deliberately including the bare word "warning": a
  // coaching note has no business carrying it in any sense, and "written
  // warning" walked straight past a list that only knew "warning letter". The
  // cost of a false positive is the fixed sentence, which is a good sentence.
  const FORBIDDEN = [
    /\bfine[ds]?\b/i, /\bpenalt/i, /\bdiscipl/i, /\bterminat/i, /\bfir(ed|ing)\b/i,
    /\bwarn(ing|ed)\b/i, /\bwritten up\b/i, /\bwrite[- ]?up\b/i, /\bprobation/i,
    /\bsuspend|suspension\b/i, /\bpoints?\b/i, /\bscore/i, /\bdeduct/i,
    /\bconsequence/i, /\bviolation/i, /\breprimand/i, /\bdismiss/i,
    /\byour (pay|job|record|file)\b/i, /\bfinal notice\b/i, /\bHR\b/,
  ];
  for (const pattern of FORBIDDEN) {
    if (pattern.test(text)) {
      return { message: 'mentions a consequence, which is a human decision' };
    }
  }
  return true;
}

/** Compose the message. Falls back the moment anything is off. */
async function composeCoachingMessage({ driverName, pattern }, deps = defaultDeps()) {
  const fallback = buildFallbackMessage({ driverName, pattern });
  try {
    if (!(await deps.isCapabilityEnabled(CAPABILITY))) return { text: fallback, aiAssisted: false };
    const firstName = String(driverName || '').trim().split(/\s+/)[0] || null;
    const { text } = await deps.runCapability({
      capability: CAPABILITY,
      userText: buildPrompt({ pattern, firstName }),
      maxOutputTokens: 160,
      validate: validateCoachingText,
    });
    const clean = String(text || '').trim();
    if (validateCoachingText(clean) === true) return { text: clean, aiAssisted: true };
    return { text: fallback, aiAssisted: false };
  } catch (_) {
    // No model, no problem: the driver still gets the message.
    return { text: fallback, aiAssisted: false };
  }
}

/**
 * One driver. Coaches at most ONE habit per pass — the commonest.
 *
 * A message listing three things a driver is doing wrong is a reprimand however
 * warmly it is worded, and nobody changes three habits at once.
 */
async function coachOneDriver(driver, { nowIso, deps, options }) {
  const coaching = await deps.store.listCoachingFor({
    personId: driver.personId, groupId: driver.groupId,
  }).catch(() => []);

  const { patterns, coachable, escalate, totals } = findPatterns({
    nowIso, events: driver.events, coaching, options,
  });
  if (!patterns.length) return { coached: null, escalated: [] };

  const escalated = [];
  // A heavy pattern goes to safety management whether or not the driver is
  // messaged, and it goes with its numbers so somebody can see WHY.
  for (const p of escalate) {
    // eslint-disable-next-line no-await-in-loop
    const out = await deps.notify({
      category: 'safety_escalation',
      title: `${driver.driverName || `Group ${driver.groupId}`}: ${p.count} ${p.behavior.replace(/_/g, ' ')} events`,
      lines: [
        `${p.count} in ${p.spanDays} days (window ${p.windowDays})`,
        p.worstGForce ? `Worst reading ${p.worstGForce} g` : null,
        `Other events in the window: ${totals.inWindow - p.count}`,
      ].filter(Boolean),
      action: 'Safety to review — no automatic action has been taken',
      subjectType: driver.personId ? 'person' : 'group',
      subjectId: driver.personId || driver.groupId,
      discriminator: `${p.behavior}:${nowIso.slice(0, 10)}`,
      personId: driver.personId,
      groupId: driver.groupId,
      evidence: { behavior: p.behavior, count: p.count, spanDays: p.spanDays, totals },
    });
    if (out.recorded) escalated.push(p.behavior);
  }

  const pattern = coachable[0];
  if (!pattern) return { coached: null, escalated };

  const { text, aiAssisted } = await composeCoachingMessage(
    { driverName: driver.driverName, pattern }, deps
  );

  // Reuse the ONE choke point for everything said to a driver group, so the
  // silent-mode switch and the message log apply here exactly as everywhere.
  let deliveredTo = 'operations';
  let messageId = null;
  if (options.messageDrivers !== false && driver.groupId && driver.telegramGroupId) {
    // The ONE choke point for everything said to a driver group. Going around
    // it would bypass the silent-mode switch, so a fleet that has muted driver
    // messaging would start getting safety notes anyway.
    const sent = await deps.driverChannel
      .sendToDriverGroup(deps.telegram, driver.telegramGroupId, text, { reason: 'safety_coaching' })
      .catch(() => null);
    if (sent) {
      deliveredTo = 'driver_group';
      messageId = sent.message_id || null;
    }
  }
  if (deliveredTo === 'operations') {
    await deps.notify({
      category: 'safety_escalation',
      title: `Coaching note for ${driver.driverName || `Group ${driver.groupId}`}`,
      lines: [text],
      reason: `${pattern.count} ${pattern.behavior.replace(/_/g, ' ')} events in ${pattern.windowDays} days`,
      subjectType: driver.personId ? 'person' : 'group',
      subjectId: driver.personId || driver.groupId,
      discriminator: `coach:${pattern.behavior}:${nowIso.slice(0, 10)}`,
      personId: driver.personId,
      groupId: driver.groupId,
      evidence: { behavior: pattern.behavior, count: pattern.count, aiAssisted },
    }).catch(() => {});
  }

  await deps.store.recordCoaching({
    personId: driver.personId, groupId: driver.groupId,
    behavior: pattern.behavior, eventCount: pattern.count, windowDays: pattern.windowDays,
    message: text, deliveredTo, telegramMessageId: messageId,
  }).catch((err) => console.warn('[SAFETY] could not record coaching:', err.message));

  return { coached: pattern.behavior, deliveredTo, aiAssisted, escalated };
}

/** One pass. Never throws. */
async function runSafetyCoachPass({ now = Date.now(), deps = defaultDeps(), options = {} } = {}) {
  const summary = { drivers: 0, coached: 0, escalated: 0, toDrivers: 0, aiAssisted: 0 };
  const nowIso = new Date(now).toISOString();
  try {
    const drivers = await deps.store.listDriversWithRecentEvents({
      windowDays: options.windowDays, minEvents: options.minEvents,
    });
    summary.drivers = drivers.length;
    for (const driver of drivers) {
      // eslint-disable-next-line no-await-in-loop
      const out = await coachOneDriver(driver, { nowIso, deps, options }).catch((err) => {
        console.warn(`[SAFETY] ${driver.key}:`, err.message);
        return { coached: null, escalated: [] };
      });
      if (out.coached) summary.coached += 1;
      if (out.deliveredTo === 'driver_group') summary.toDrivers += 1;
      if (out.aiAssisted) summary.aiAssisted += 1;
      summary.escalated += out.escalated.length;
    }
    if (summary.coached || summary.escalated) {
      console.log(`[SAFETY] ${summary.drivers} drivers with events, ${summary.coached} coached `
        + `(${summary.toDrivers} to their group), ${summary.escalated} escalated.`);
    }
    return summary;
  } catch (err) {
    console.error('[SAFETY] coach pass failed:', err.message);
    summary.error = err.message;
    return summary;
  }
}

let timer = null;
let stopped = false;
let tickRunning = false;

async function tick() {
  if (tickRunning) return;
  tickRunning = true;
  try {
    await withRunRecord('safety_coach', () => runSafetyCoachPass({}));
  } catch (err) {
    console.error('[SAFETY] coach tick error:', err.message);
  } finally {
    tickRunning = false;
  }
}

function startSafetyCoach() {
  stopped = false;
  console.log(`[SAFETY] Coach started — every ${POLL_MS / 3600000}h`);
  setTimeout(() => { if (!stopped) tick(); }, FIRST_TICK_DELAY_MS).unref?.();
  timer = setInterval(() => { if (!stopped) tick(); }, POLL_MS);
  timer.unref?.();
}

function stopSafetyCoach() {
  stopped = true;
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = {
  CAPABILITY, POLL_MS, FIRST_TICK_DELAY_MS,
  buildFallbackMessage, buildPrompt, validateCoachingText, composeCoachingMessage,
  coachOneDriver, runSafetyCoachPass, startSafetyCoach, stopSafetyCoach,
};
