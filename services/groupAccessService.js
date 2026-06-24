/**
 * Bot Group Access — diagnostics for "can the bot actually read this group?".
 *
 * Two independent signals are combined:
 *   1. Membership role, queried from Telegram (getChatMember for the bot itself):
 *      admin/creator → the bot reads every message; member → only if the bot's
 *      privacy mode is off; left/kicked → the bot is not in the group at all.
 *   2. Whether the bot has actually RECEIVED a message recently (recorded by the
 *      group message handler). This is ground truth: if messages are arriving,
 *      the bot can read the group regardless of role.
 *
 * computeReadingVerdict() is pure (unit-testable). The Telegram refresh lazily
 * requires the bot to avoid any require cycle.
 */
const db = require('../database/db');
const { RECENT_SEEN_DAYS, computeReadingVerdict } = require('./groupAccessConstants');

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

let cachedBotId = null;

/** Normalize Telegram getChatMember errors to a membership status. */
function statusFromError(err) {
  const desc = String(err?.description || err?.message || '').toLowerCase();
  if (desc.includes('chat not found') || desc.includes('not found')
    || desc.includes('not a member') || desc.includes('kicked')
    || desc.includes('member list is inaccessible')) {
    return 'left';
  }
  return 'error';
}

async function getBotId(telegram) {
  if (cachedBotId) return cachedBotId;
  const me = await telegram.getMe();
  cachedBotId = me.id;
  return cachedBotId;
}

/**
 * Query Telegram for the bot's role in every driver group and cache it.
 * Returns a small summary. Safe to call from an admin endpoint.
 */
async function refreshDriverGroupBotAccess() {
  // Lazy require: bot.js never requires this module, so this avoids a cycle.
  const { bot } = require('../bot/bot');
  const telegram = bot.telegram;
  const botId = await getBotId(telegram);

  const groups = await db.listDriverGroupAccess();
  const checkedAt = new Date().toISOString();
  let reachable = 0;
  let notInGroup = 0;
  let errors = 0;

  for (const g of groups) {
    let status;
    try {
      const member = await telegram.getChatMember(String(g.telegram_group_id), botId);
      status = member?.status || 'unknown';
    } catch (err) {
      status = statusFromError(err);
    }
    if (status === 'left' || status === 'kicked' || status === 'not_found') notInGroup += 1;
    else if (status === 'error') errors += 1;
    else reachable += 1;

    await db.updateGroupBotAccess(g.group_id, status, checkedAt).catch(() => {});
    await sleep(40); // gentle pacing to stay clear of Telegram rate limits
  }

  return { checked: groups.length, reachable, notInGroup, errors, checkedAt };
}

module.exports = {
  RECENT_SEEN_DAYS,
  computeReadingVerdict,
  refreshDriverGroupBotAccess,
};
