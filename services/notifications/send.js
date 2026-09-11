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
 * @returns {Promise<{recorded:boolean, delivered:boolean, reason?:string, notice?:object}>}
 */
async function notify(notice, deps = defaultDeps()) {
  const {
    category, title, lines = [], reason = null, action = null,
    subjectType = 'system', subjectId = '', discriminator = null,
    personId = null, groupId = null, evidence = null,
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

  const body = composeNotice({
    icon: ICONS[category] || 'ℹ️', title, lines, reason, action,
  });
  let row;
  try {
    row = await deps.store.enqueueNotification({
      noticeKey, category, chatId, routedVia: via, body,
      subjectType, subjectId, personId, groupId, evidence,
    });
  } catch (err) {
    console.warn(`[NOTIFY] could not record "${noticeKey}":`, err.message);
    return { recorded: false, delivered: false, reason: 'enqueue_failed' };
  }

  // Already known. THIS IS THE DEDUP GUARANTEE WORKING, not a failure — the
  // same condition was seen again and nobody is told twice.
  if (!row) return { recorded: false, delivered: false, reason: 'already_sent' };

  const claimed = await deps.store.claimNotificationById(row.id).catch(() => null);
  // Losing the claim race means the sweep has it. That is a success.
  if (!claimed) return { recorded: true, delivered: false, reason: 'claimed_elsewhere', notice: row };

  const delivered = await deliverOne(claimed, deps);
  return { recorded: true, delivered, notice: claimed };
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

module.exports = { ICONS, notify, deliverOne, runNotificationSweep, getCategory };
