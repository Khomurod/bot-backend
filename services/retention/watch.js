'use strict';

/**
 * Noticing that the company is about to lose a driver, and saying so in time
 * for somebody to do something about it.
 *
 * THE DECISION IS ARITHMETIC AND HAS NO MODEL IN IT. `lib/retention/signals.js`
 * is pure, scores facts that other features already recorded, and decides who
 * is flagged. With every AI provider switched off, exactly the same drivers are
 * flagged with exactly the same reasons; the only thing that changes is the
 * wording of one sentence.
 *
 * WHERE THE NOTICE GOES, AND WHERE IT DOES NOT. To the operations notification
 * group, and nowhere else — never to the driver's own chat. A driver who
 * received "we think you might be about to quit" would be reading a message
 * about a file they did not know existed. The owner asked for the notification
 * group only; this is the code that keeps it that way, since
 * `services/notifications/send.js` is the only send path here and it cannot
 * reach a driver group.
 *
 * NOTHING HERE DECIDES ANYTHING ABOUT A PERSON'S JOB. Not a recommendation, not
 * a ranking, not a suggestion to replace anybody. `refuseEmploymentLanguage`
 * below is the enforcement, and it runs on the finished notice — after the
 * signals, after the actions, after any AI wording — because that is the last
 * point at which anything can be stopped.
 */
const { assess } = require('../../lib/retention/signals');

const CAPABILITY = 'retention_summary';
const POLL_MS = 4 * 60 * 60 * 1000;
const FIRST_TICK_DELAY_MS = 15 * 60 * 1000;

/**
 * Language a retention notice must never contain.
 *
 * Narrower than the safety coach's list and for a different reason: that one
 * protects a driver from being told off by a machine, this one protects them
 * from being *discussed* by one. The words below are all decisions about
 * somebody's employment, and the point of this feature is the opposite — it
 * exists to get a driver home, paid, and loaded.
 */
const EMPLOYMENT_LANGUAGE = [
  /\bterminat/i, /\bfir(e|ed|ing)\b/i, /\bdismiss/i, /\blet\s+(them|him|her)\s+go\b/i,
  /\breplace(ment|d)?\b/i, /\bdiscipl/i, /\bprobation/i, /\bwrite[- ]?up\b/i,
  /\bwritten up\b/i, /\bperformance\s+(review|issue|problem|plan)\b/i,
  /\bnot\s+worth\b/i, /\bproblem\s+driver\b/i, /\bunreliable\b/i, /\battitude\b/i,
  /\bshould\s+(be\s+)?(let\s+go|removed|replaced)\b/i, /\bPIP\b/,
];

function refuseEmploymentLanguage(text) {
  const body = String(text || '');
  for (const pattern of EMPLOYMENT_LANGUAGE) {
    if (pattern.test(body)) {
      return { ok: false, reason: `mentions an employment decision, which is not Wenze's to raise` };
    }
  }
  return { ok: true };
}

function defaultDeps() {
  /* eslint-disable global-require */
  return {
    inputs: require('../../database/retention'),
    store: require('../../database/retentionAssessments'),
    notify: require('../notifications/send').notify,
    runCapability: require('../ai/router').runCapability,
    isCapabilityEnabled: require('../ai/capabilityGate').isCapabilityEnabled,
  };
  /* eslint-enable global-require */
}

/**
 * The sentence at the top of the notice, without a model.
 *
 * This is what actually ships whenever anything goes wrong, so it has to be
 * good on its own rather than a placeholder. It names the driver, the heaviest
 * reason and how many others there are, and stops.
 */
function buildFallbackSummary({ driverName, assessment }) {
  const others = assessment.signals.length - 1;
  const also = others > 0 ? `, and ${others} other thing${others === 1 ? '' : 's'}` : '';
  return `${driverName}: ${assessment.topReason}${also}.`;
}

/** Counts and reason keys only — never a driver's name, never their words. */
function buildPrompt({ assessment }) {
  return [
    'Write ONE plain sentence for a trucking company operations chat, summarising why',
    'a driver may be at risk of leaving. It is read by a dispatcher who will act on it.',
    '',
    'The reasons, already established from company records:',
    ...assessment.signals.map((s) => `- ${s.detail}`),
    '',
    'Rules:',
    '- One sentence. Plain text. No name, no emoji, no markdown.',
    '- Say WHAT THE COMPANY HAS DONE OR NOT DONE. Never characterise the driver.',
    '- Do NOT mention discipline, replacement, termination, performance or attitude.',
    '- Do NOT invent any number or fact that is not listed above.',
    '- Do NOT suggest anything about their employment.',
  ].join('\n');
}

/** Compose the one sentence, refusing anything that strays. */
async function summarise({ driverName, assessment }, deps) {
  const fallback = buildFallbackSummary({ driverName, assessment });
  try {
    if (!(await deps.isCapabilityEnabled(CAPABILITY))) return { text: fallback, aiAssisted: false };
    const { text } = await deps.runCapability({
      capability: CAPABILITY,
      userText: buildPrompt({ assessment }),
      maxOutputTokens: 120,
      validate: (raw) => {
        const clean = String(raw || '').trim();
        if (clean.length < 20 || clean.length > 300) return { message: 'wrong length for one sentence' };
        const verdict = refuseEmploymentLanguage(clean);
        return verdict.ok ? true : { message: verdict.reason };
      },
    });
    const clean = String(text || '').trim();
    // Checked AGAIN here rather than trusted from the validator: the router
    // only reaches a validator on the path where a provider answered, and a
    // wording that must never ship is not something to check in one place.
    if (clean && refuseEmploymentLanguage(clean).ok && clean.length <= 300) {
      return { text: `${driverName}: ${clean}`, aiAssisted: true };
    }
    return { text: fallback, aiAssisted: false };
  } catch (_) {
    return { text: fallback, aiAssisted: false };
  }
}

/** One driver: score, record, and say something if it is worth saying. */
async function considerDriver(driver, { nowIso, deps, options }) {
  const assessment = assess(driver, { ...options, now: nowIso });

  const previous = await deps.store.getAssessment({
    personId: driver.personId, groupId: driver.groupId,
  }).catch(() => null);

  const row = await deps.store.recordAssessment({
    personId: driver.personId,
    groupId: driver.groupId,
    driverName: driver.driverName,
    score: assessment.score,
    level: assessment.level,
    signals: assessment.signals,
    actions: assessment.actions,
  });

  const verdict = deps.store.shouldNotify(previous, assessment, { now: nowIso });
  if (!verdict.notify) return { driver: driver.driverName, level: assessment.level, sent: false, reason: verdict.reason };

  const { text, aiAssisted } = await summarise(
    { driverName: driver.driverName, assessment }, deps
  );

  // The last gate, on the finished body. Everything above could have been
  // right and this still catches a stray action or a reason that reads wrong.
  const whole = [text, ...assessment.signals.map((s) => s.detail), ...assessment.actions].join(' | ');
  const guard = refuseEmploymentLanguage(whole);
  if (!guard.ok) {
    console.warn(`[RETENTION] notice for ${driver.driverName} refused: ${guard.reason}`);
    return { driver: driver.driverName, level: assessment.level, sent: false, reason: 'refused_by_guard' };
  }

  const out = await deps.notify({
    category: 'retention',
    title: text,
    lines: assessment.signals.map((s) => s.detail),
    reason: assessment.level === 'urgent' ? 'Several things at once' : null,
    action: assessment.actions[0] || 'Worth a phone call',
    subjectType: driver.personId ? 'person' : 'group',
    subjectId: driver.personId || driver.groupId,
    // Re-announced only when the score moves, so the key carries the score.
    discriminator: `${assessment.level}:${assessment.score}`,
    personId: driver.personId,
    groupId: driver.groupId,
    evidence: { score: assessment.score, signals: assessment.signals, aiAssisted },
  });

  if (out.recorded && row?.id) await deps.store.markNotified(row.id, assessment.score);

  return {
    driver: driver.driverName, level: assessment.level,
    sent: out.recorded === true, reason: verdict.reason, score: assessment.score,
  };
}

/** One pass over the fleet. Never throws; a bad driver row costs that row only. */
async function runRetentionPass({ now = Date.now(), deps = defaultDeps(), options = {} } = {}) {
  const nowIso = new Date(now).toISOString();
  const summary = { checked: 0, flagged: 0, notified: 0, urgent: 0, errors: [] };

  let drivers;
  try {
    drivers = await deps.inputs.gatherRetentionInputs(options);
  } catch (err) {
    console.warn('[RETENTION] could not read the fleet:', err.message);
    return { ...summary, errors: [err.message] };
  }

  for (const driver of drivers) {
    summary.checked += 1;
    try {
      // eslint-disable-next-line no-await-in-loop
      const out = await considerDriver(driver, { nowIso, deps, options });
      if (out.level !== 'none') summary.flagged += 1;
      if (out.level === 'urgent') summary.urgent += 1;
      if (out.sent) summary.notified += 1;
    } catch (err) {
      summary.errors.push(`${driver.driverName}: ${err.message}`);
    }
  }

  return summary;
}

let timer = null;
let stopped = true;

/**
 * What the last pass did, for `/api/health`.
 *
 * NOT derivable from the rows the pass writes, which is why it is kept here.
 * "The watch ran and found nobody" and "the watch has never run, or crashed on
 * every driver" produce exactly the same empty table, and only one of those is
 * good news. A background job whose failure looks identical to its success is
 * the shape of problem this whole phase exists to remove, so it would be a poor
 * joke to ship another one.
 */
let lastRun = null;

async function tick() {
  const startedAt = new Date().toISOString();
  try {
    const summary = await runRetentionPass({});
    lastRun = { at: startedAt, ok: true, ...summary, errors: summary.errors.length };
    if (summary.flagged > 0 || summary.errors.length) {
      console.log(`[RETENTION] ${summary.checked} checked, ${summary.flagged} flagged `
        + `(${summary.urgent} urgent), ${summary.notified} announced`);
    }
  } catch (err) {
    // runRetentionPass does not throw, so reaching here means something under
    // it did. Recorded rather than only logged: Render's logs roll, and this is
    // the question somebody asks days later.
    lastRun = { at: startedAt, ok: false, error: err.message };
    console.warn('[RETENTION] pass failed:', err.message);
  }
}

/** Running, and what the last pass actually did. */
function getRetentionStatus() {
  return { running: Boolean(timer), lastRun };
}

/**
 * Four hours, and the first pass a quarter of an hour after boot.
 *
 * Deliberately slow. Nothing here is urgent in minutes — a driver five weeks
 * past the allowance will still be five weeks past it at teatime — and a slow
 * timer is the cheapest guard against the failure this feature is most likely
 * to have, which is saying too much.
 */
function startRetentionWatch() {
  stopped = false;
  console.log(`[RETENTION] Watch started — every ${POLL_MS / 3600000}h`);
  setTimeout(() => { if (!stopped) tick(); }, FIRST_TICK_DELAY_MS).unref?.();
  timer = setInterval(() => { if (!stopped) tick(); }, POLL_MS);
  timer.unref?.();
}

function stopRetentionWatch() {
  stopped = true;
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = {
  CAPABILITY,
  getRetentionStatus,
  startRetentionWatch,
  stopRetentionWatch,
  POLL_MS,
  FIRST_TICK_DELAY_MS,
  EMPLOYMENT_LANGUAGE,
  refuseEmploymentLanguage,
  buildFallbackSummary,
  buildPrompt,
  summarise,
  considerDriver,
  runRetentionPass,
  defaultDeps,
};
