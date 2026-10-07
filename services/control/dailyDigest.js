'use strict';

/**
 * Sending the morning summary. Rides the consistency sweep.
 *
 * ONCE A DAY, AND THE OUTBOX IS WHAT GUARANTEES IT. Every fifteen minutes
 * between 08:00 and 20:00 Chicago time this composes the day's summary and
 * hands it to `notify()` with the local date as its discriminator. The notice
 * key is UNIQUE, so the first call that day is delivered and every later one
 * — including after a restart — comes back `already_sent`. No timer state,
 * no claim table: the same guarantee every other "say it once" in this
 * application rests on.
 *
 * IT COSTS ONE CHEAP READ before that: `noticeSentWithin` on the day's key, so
 * the remaining forty-seven passes of the day do not build a summary only to
 * have it refused.
 *
 * Off when the control channel is off — the summary exists to bring the
 * questions back, and a switched-off channel asks none.
 *
 * NEVER THROWS. A summary that could not be built is a skipped summary, and
 * the next pass tries again.
 */
const defaultSettings = require('../../database/controlSettings');
const defaultNotices = require('../../database/operationalNotifications');
const defaultDigest = require('../../database/controlDigest');
const defaultCorrections = require('../../database/operationalCorrections');
const defaultFindings = require('../../database/operationalFindings');
const defaultSystemHealth = require('../../database/systemHealth');
const defaultNotificationSettings = require('../../database/operationalNotificationSettings');
const { resolveDestination } = require('../../lib/notifications/categories');
const defaultSend = require('../notifications/send');
const { digestDayFor, composeDigest, MAX_WAITING_NAMED } = require('../../lib/control/digest');
const { serviceLabel } = require('../../lib/operations/backgroundServiceCatalog');
const {
  candidatesForToday, buildPrioritiesPrompt, validatePriorities,
  fallbackPriorities, prioritiesFromPicks,
} = require('../../lib/control/priorities');

const CATEGORY = 'needs_attention';
const SUBJECT_TYPE = 'control_digest';
const SUBJECT_ID = 'daily';
/** The AI responsibility that words "most important today". */
const PRIORITIES_CAPABILITY = 'daily_priorities';

function defaultDeps() {
  return {
    settings: defaultSettings,
    notices: defaultNotices,
    digest: defaultDigest,
    corrections: defaultCorrections,
    findings: defaultFindings,
    systemHealth: defaultSystemHealth,
    notificationSettings: defaultNotificationSettings,
    notify: defaultSend.notify,
    // Lazy: the router pulls in the whole AI stack, which a test of this
    // module's plumbing has no use for.
    runCapability: (...args) => require('../ai/router').runCapability(...args), // eslint-disable-line global-require
  };
}

/**
 * "Most important today": the first three open findings by rule, or the three
 * an AI picks from the first eight and says plainly. Never throws; a summary
 * with no priorities line is a summary, one that failed to send is not.
 *
 * @returns {Promise<string[]|null>}
 */
async function todaysPriorities(open, now, deps) {
  if (!Array.isArray(open)) return null;
  const candidates = candidatesForToday(open);
  if (!candidates.length) return [];
  try {
    const { parsed } = await deps.runCapability({
      capability: PRIORITIES_CAPABILITY,
      userText: buildPrioritiesPrompt(candidates, now),
      expects: 'json',
      validate: validatePriorities(candidates),
    });
    return prioritiesFromPicks(candidates, parsed);
  } catch (_) {
    return fallbackPriorities(candidates);
  }
}

/** The notice key `notify` writes for one day's summary. */
function digestKeyFor(day) {
  return `${CATEGORY}:${SUBJECT_TYPE}:${SUBJECT_ID}:${day}`;
}

/**
 * @param {object} [options]
 * @param {Date}   [options.now]
 * @returns {Promise<{sent:boolean, day?:string|null, reason?:string}>}
 */
async function runDailyDigest({ now = new Date() } = {}, deps = defaultDeps()) {
  const day = digestDayFor(now);
  if (!day) return { sent: false, day: null, reason: 'not_the_hour' };

  const settings = await deps.settings.getControlSettings().catch(() => ({ enabled: true }));
  if (settings.enabled === false) return { sent: false, day, reason: 'disabled' };

  // A read that failed is treated as "already sent": a second summary in one
  // day is the nuisance this is built to avoid, and tomorrow will come.
  const already = await deps.notices.noticeSentWithin(digestKeyFor(day), 24).catch(() => true);
  if (already) return { sent: false, day, reason: 'already_sent' };

  // WHERE IT IS GOING decides which questions it may name. A question keeps
  // the chat it was asked in; when the destination changes, naming the old
  // ones would show finding titles to a group that never received them. The
  // same resolution `notify` makes, so the two cannot disagree.
  const config = await Promise.resolve(deps.notificationSettings.getNotificationSettings())
    .catch(() => null);
  const chatId = config
    ? resolveDestination(CATEGORY, {
      defaultChatId: config.defaultChatId, overrides: config.categoryChatIds,
    }).chatId
    : null;
  if (!chatId) return { sent: false, day, reason: 'no_destination' };

  const since = new Date(new Date(now).getTime() - 24 * 3600_000).toISOString();
  const [waiting, changes, findings, health, open] = await Promise.all([
    deps.digest.listWaitingQuestions({ limit: MAX_WAITING_NAMED, chatId }).catch(() => null),
    deps.corrections.summariseCorrections({ sinceIso: since }).catch(() => null),
    deps.findings.summariseFindings().catch(() => null),
    deps.systemHealth.summariseHealthStates().catch(() => null),
    Promise.resolve(deps.findings.listFindings?.({ status: 'open', limit: 100 })).catch(() => null),
  ]);
  const priorities = await todaysPriorities(open, now, deps).catch(() => null);

  const body = composeDigest({
    waiting: waiting ? waiting.oldest : null,
    waitingTotal: waiting ? waiting.total : null,
    changes,
    findings,
    systemsDown: health ? (health.down || []).map(serviceLabel) : null,
    systemsWaiting: health ? (health.waiting || []).map(serviceLabel) : null,
    priorities,
    now,
  });

  const result = await Promise.resolve(deps.notify({
    category: CATEGORY,
    title: body.title,
    lines: body.lines,
    subjectType: SUBJECT_TYPE,
    subjectId: SUBJECT_ID,
    discriminator: day,
    severity: 'info',
  })).catch(() => null);

  return {
    sent: Boolean(result?.recorded),
    day,
    reason: result?.recorded ? null : (result?.reason || 'not_sent'),
    waiting: waiting ? waiting.total : null,
  };
}

module.exports = {
  SUBJECT_TYPE, SUBJECT_ID, PRIORITIES_CAPABILITY, digestKeyFor, runDailyDigest, defaultDeps,
  todaysPriorities,
};
