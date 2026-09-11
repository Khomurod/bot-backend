/**
 * Telling a human something, once, through one door.
 *
 * Every feature that needed to reach staff used to pick its own destination
 * column, its own outbox and its own message shape. This is the one door they
 * go through from now on: a caller says WHAT happened and WHICH CATEGORY it is,
 * and this decides where it goes, writes it down, and delivers it.
 *
 * Three promises, each of which is a bug this repository has actually shipped:
 *
 *   IT IS WRITTEN DOWN BEFORE IT IS SENT. A notice that cannot be delivered
 *   right now is a pending row, not a lost event.
 *
 *   IT IS SAID ONCE. Background checks re-derive the same condition every few
 *   minutes and Render restarts this process several times a day, so the
 *   guarantee is a UNIQUE column, not a set in memory.
 *
 *   A SEND FAILURE NEVER BREAKS THE CALLER. Detecting a fuel risk and telling
 *   somebody about it are different jobs; the second failing must not undo the
 *   first. Every function here returns a result object and none of them throws.
 */
const { resolveDestination, isKnownCategory, getCategory } = require('../../lib/notifications/categories');
const { composeNotice, noticeKeyFor } = require('../../lib/notifications/compose');
const {
  LEVELS, CEILING, priorityFor, shouldSuppress, suppressionKeyFor,
} = require('../../lib/notifications/priority');

const ICONS = Object.freeze({
  automatic_corrections: '🔧',
  needs_attention: '👀',
  system_errors: '🚨',
  self_healing: '🩹',
  fuel: '⛽',
  safety_escalation: '🛑',
  retention: '💬',
  load_lifecycle: '📦',
  ai_learning: '🧠',
});

/**
 * How long a held notice waits, and how many about one driver it takes.
 *
 * The window is the same number on both sides on purpose: the hold lasts
 * exactly as long as the crowding that caused it, so the notice arrives the
 * moment it would no longer be the fourth thing said about one person in an
 * hour. Making the hold shorter than the window would just re-ask the same
 * question and hold it again.
 */
const SUPPRESSION_WINDOW_MINUTES = 60;
const MAX_PER_SUBJECT_PER_WINDOW = 3;

function defaultDeps() {
  /* eslint-disable global-require */
  return {
    store: require('../../database/operationalNotifications'),
    settings: require('../../database/operationalNotificationSettings'),
    // No `telegram` key on purpose — see resolveTelegram.
    safeSend: require('../telegramHtml').safeSend,
  };
  /* eslint-enable global-require */
}

/**
 * ABSENT means "find the bot"; NULL means "there is no client".
 *
 * Those are different, and collapsing them is a real bug: a caller that
 * deliberately passes no client — a test, or a worker running before the bot is
 * up — would silently reach the live bot and message a real chat.
 */
function resolveTelegram(deps) {
  if (deps.telegram !== undefined) return deps.telegram;
  try {
    // Lazy: this module must be requirable without pulling in the bot.
    // eslint-disable-next-line global-require
    return require('../../bot/bot').bot?.telegram || null;
  } catch (_) {
    return null;
  }
}

/**
 * Record a notice and try to send it now.
 *
 * @param {object} notice
 * @param {string} notice.category   a key from lib/notifications/categories
 * @param {string} notice.title      what happened, in a few words
 * @param {string[]} [notice.lines]  the facts
 * @param {string} [notice.reason]   why, clipped hard
 * @param {string} [notice.action]   the one thing a person should do
 * @param {string} notice.subjectType
 * @param {string|number} notice.subjectId
 * @param {string} [notice.discriminator]  what makes THIS event different from
 *   the same condition seen again — a cycle id, a load id, a date.
 * @param {number} [notice.personId]
 * @param {number} [notice.groupId]
 * @param {object} [notice.evidence]
 * @param {string} [notice.severity]  how serious THIS event is, when the caller
 *   knows better than its category does. A category's severity is a constant —
 *   `fuel` is `warning` whether the truck is twenty miles from a station with
 *   half a tank or four hundred miles out at eight percent — and the second of
 *   those is the one that costs money. An unrecognised value falls back to the
 *   category's rather than to the most alarming one.
 * @param {object} [notice.facts]  established numbers that move the urgency —
 *   a distance, a percentage, a count, an hours-until-due. NEVER an opinion:
 *   `lib/notifications/priority.js` has no parameter a model could reach.
 * @returns {Promise<{recorded:boolean, delivered:boolean, reason?:string,
 *   notice?:object, priority?:string}>}
 */
async function notify(notice, deps = defaultDeps()) {
  const {
    category, title, lines = [], reason = null, action = null,
    subjectType = 'system', subjectId = '', discriminator = null,
    personId = null, groupId = null, evidence = null,
    severity = null, facts = null,
  } = notice || {};

  if (!isKnownCategory(category)) {
    // A typo'd category would otherwise route by falling through to the
    // default and never be configurable. Refusing loudly in the log is the
    // cheapest way to catch it, and it still never throws at the caller.
    console.warn(`[NOTIFY] unknown category "${category}" — nothing sent.`);
    return { recorded: false, delivered: false, reason: 'unknown_category' };
  }

  let config;
  try {
    config = await deps.settings.getNotificationSettings();
  } catch (err) {
    console.warn('[NOTIFY] could not read notification settings:', err.message);
    return { recorded: false, delivered: false, reason: 'settings_unavailable' };
  }

  // BUILT BEFORE THE DESTINATION IS RESOLVED, and that ordering is the fix for
  // a counter that shipped wrong. Both discards below record this key, so the
  // same load reconsidered every ten minutes is one thing unheard rather than
  // a hundred and forty-four.
  const noticeKey = noticeKeyFor(category, subjectType, subjectId, discriminator);

  if (config.enabled === false) {
    await deps.store.recordDiscard(category, 'disabled', noticeKey).catch(() => {});
    return { recorded: false, delivered: false, reason: 'disabled' };
  }

  const { chatId, via } = resolveDestination(category, {
    defaultChatId: config.defaultChatId,
    overrides: config.categoryChatIds,
  });
  if (!chatId) {
    // NOT an error, and deliberately not enqueued. A notice with nowhere to go
    // would sit pending forever and, on the day a destination is finally set,
    // deliver a backlog of stale alerts into a live staff chat — which is
    // exactly what this repository decided NOT to do with 98 expired ones.
    //
    // BUT IT IS COUNTED. The cost of that decision was invisible: every feature
    // running, finding real things, and saying nothing — the same silence this
    // whole project started from, reached by a different route. A count is a
    // sentence somebody acts on; "not configured" is not.
    await deps.store.recordDiscard(category, 'no_destination', noticeKey).catch(() => {});
    console.log(`[NOTIFY] no destination for "${category}" — not recorded.`);
    return { recorded: false, delivered: false, reason: 'no_destination' };
  }

  // ── how much this deserves somebody's attention right now ────────────────
  //
  // The category's severity is the default and the caller's is the more
  // specific fact. An unrecognised severity falls back to the category's: a
  // typo must not be able to raise an alarm, which is the only direction that
  // matters.
  const stated = CEILING[severity] ? severity : (getCategory(category)?.severity || 'info');
  const priority = priorityFor({ severity: stated, facts: facts || {} });

  // ── has this person been told enough about this driver already? ───────────
  //
  // Not the same question as the notice key, which stops the SAME notice being
  // sent twice and is already answered below. This one is about a fuel risk, a
  // load contradiction and a retention signal about ONE driver arriving within
  // minutes, each correctly deduplicated against itself.
  //
  // Held, never dropped: the notice is still enqueued, with its first attempt
  // pushed past the window, so the sweep delivers it once the crowd has
  // cleared. Nothing is lost, which is the whole difference between this and
  // the discard above.
  //
  // OPTIONAL-CHAINED AND FAIL-OPEN. A dependency map without the new read — and
  // a store whose query failed — must cost the HOLD, not the notice. Saying a
  // thing twice is a nuisance; not saying it is the failure this application
  // exists to remove.
  const subjectKey = suppressionKeyFor({ personId, groupId, subjectType, subjectId });
  const recent = await Promise.resolve(
    deps.store.listRecentNoticesAbout?.({
      personId, groupId, subjectType, subjectId,
      // SCOPED TO WHERE THIS ONE IS GOING. Three fuel notices in the fuel
      // team's chat must not hold the first safety notice in a safety chat:
      // nobody reading that chat saw the burst it would be held for.
      chatId,
      withinMinutes: SUPPRESSION_WINDOW_MINUTES,
    })
  ).catch(() => null);
  const held = recent
    ? shouldSuppress({
      level: priority.level,
      subjectKey,
      recent: recent.map((n) => ({ subjectKey, at: n.at })),
      windowMinutes: SUPPRESSION_WINDOW_MINUTES,
      maxPerSubject: MAX_PER_SUBJECT_PER_WINDOW,
    })
    : { suppress: false, why: 'recent notices could not be read' };

  // STAGGERED, NOT STACKED. Every held row used to be dated forward by the
  // same fixed window, so a hundred notices became three now and ninety-seven
  // together an hour later — the hold moved the flood rather than removing it.
  // Each notice already waiting for this subject pushes this one a further
  // window out, which spreads them instead of piling them onto one minute.
  //
  // Optional-chained and fail-safe like the read above: a store without the
  // count, or a count that failed, costs the STAGGER and not the hold.
  let holdSeconds = 0;
  if (held.suppress) {
    const alreadyHeld = await Promise.resolve(
      deps.store.countHeldNoticesAbout?.({ personId, groupId, subjectType, subjectId, chatId })
    ).catch(() => 0);
    holdSeconds = SUPPRESSION_WINDOW_MINUTES * 60 * (1 + (Number(alreadyHeld) || 0));
  }

  const body = composeNotice({
    icon: ICONS[category] || 'ℹ️',
    title,
    // Only a `now` explains itself. A "today" that announced its own urgency on
    // every line would be the noise this is meant to reduce.
    lines: priority.level === LEVELS.NOW && priority.reasons.length
      ? [...lines, priority.reasons[0]]
      : lines,
    reason,
    action,
  });
  let row;
  try {
    row = await deps.store.enqueueNotification({
      noticeKey, category, chatId, routedVia: via, body,
      subjectType, subjectId, personId, groupId,
      // The level is recorded with the facts it came from, so the Operations
      // screen can show WHY a notice was urgent rather than only that it was.
      evidence: { ...(evidence || {}), priority: priority.level },
      delaySeconds: holdSeconds,
    });
  } catch (err) {
    console.warn(`[NOTIFY] could not record "${noticeKey}":`, err.message);
    return { recorded: false, delivered: false, reason: 'enqueue_failed' };
  }

  // Already known. THIS IS THE DEDUP GUARANTEE WORKING, not a failure — the
  // same condition was seen again and nobody is told twice.
  if (!row) return { recorded: false, delivered: false, reason: 'already_sent' };

  // Held. The row is written and dated forward; the sweep owns it from here.
  // Claiming it now would deliver exactly the interruption the hold exists to
  // prevent.
  if (held.suppress) {
    console.log(`[NOTIFY] holding "${noticeKey}" for ${Math.round(holdSeconds / 60)}min — ${held.why}`);
    return {
      recorded: true, delivered: false, reason: 'held', notice: row, priority: priority.level,
    };
  }

  const claimed = await deps.store.claimNotificationById(row.id).catch(() => null);
  // Losing the claim race means the sweep has it. That is a success.
  if (!claimed) {
    return {
      recorded: true, delivered: false, reason: 'claimed_elsewhere', notice: row,
      priority: priority.level,
    };
  }

  const delivered = await deliverOne(claimed, deps);
  return { recorded: true, delivered, notice: claimed, priority: priority.level };
}

/** Send one claimed notice. Settles its state either way. Never throws. */
async function deliverOne(notice, deps = defaultDeps()) {
  const telegram = resolveTelegram(deps);
  if (!telegram) {
    await deps.store.markNotificationFailed(notice.id, 'no telegram client available').catch(() => {});
    return false;
  }
  try {
    const sent = await deps.safeSend(() => telegram.sendMessage(notice.chatId, notice.body, {
      parse_mode: 'HTML', disable_web_page_preview: true,
    }));
    await deps.store.markNotificationDelivered(notice.id, {
      telegramMessageId: sent?.message_id || null,
    });
    return true;
  } catch (err) {
    await deps.store.markNotificationFailed(notice.id, err.message).catch(() => {});
    console.warn(`[NOTIFY] delivery of #${notice.id} failed (will retry):`, err.message);
    return false;
  }
}

/**
 * Drain whatever is due. Ridden by the operations sweep, so a notice that could
 * not be sent at the moment it happened still goes out later.
 */
async function runNotificationSweep({ limit = 10 } = {}, deps = defaultDeps()) {
  let due = [];
  try {
    due = await deps.store.claimDueNotifications({ limit });
  } catch (err) {
    console.warn('[NOTIFY] sweep could not claim:', err.message);
    return { claimed: 0, delivered: 0 };
  }
  let delivered = 0;
  for (const notice of due) {
    // eslint-disable-next-line no-await-in-loop
    if (await deliverOne(notice, deps)) delivered += 1;
  }
  return { claimed: due.length, delivered };
}

module.exports = {
  ICONS,
  SUPPRESSION_WINDOW_MINUTES,
  MAX_PER_SUBJECT_PER_WINDOW,
  notify,
  deliverOne,
  runNotificationSweep,
  getCategory,
};
