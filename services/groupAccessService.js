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
const ht = require('../database/homeTime');
const {
  RECENT_SEEN_DAYS,
  computeReadingVerdict,
  parseAdminGrantPayload,
} = require('./groupAccessConstants');

function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

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

/**
 * Confirm the result of a ?startgroup admin-grant deep link.
 *
 * Telegram cannot pre-select the group, so the link carries the intended group
 * id as a start parameter. When the super admin adds the bot to a group, Telegram
 * sends the bot a `/start htadmin_<id>` message in that group. We compare the
 * chosen group to the requested one, cache the bot's new role, and DM the super
 * admin a ✅ confirmation or a ⚠️ mismatch warning. Never throws.
 *
 * @param {object} telegram   bot.telegram instance (passed from the ctx)
 * @param {object} args
 * @param {string|number} args.chatTelegramId  the group the bot was added to
 * @param {string} args.chatTitle              that group's title
 * @param {string} args.payload                the /start payload (htadmin_<id>)
 */
async function confirmAdminGrant(telegram, { chatTelegramId, chatTitle, payload }) {
  try {
    const requestedGroupId = parseAdminGrantPayload(payload);
    if (!requestedGroupId) return;

    const settings = await ht.getBotAccessSettings();
    if (!settings?.super_admin_telegram_id) return;

    const chosenGroup = await db.getGroupByTelegramId(chatTelegramId);

    // Cache the bot's current role in the chosen group for the access view.
    let role = 'unknown';
    try {
      const botId = await getBotId(telegram);
      const member = await telegram.getChatMember(String(chatTelegramId), botId);
      role = member?.status || 'unknown';
    } catch (err) {
      role = statusFromError(err);
    }
    if (chosenGroup) {
      await db.updateGroupBotAccess(chosenGroup.id, role, new Date().toISOString()).catch(() => {});
    }

    const isAdmin = role === 'administrator' || role === 'creator';
    const chosenLabel = escapeHtml(chosenGroup?.group_name || chatTitle || `chat ${chatTelegramId}`);

    let text;
    if (chosenGroup && chosenGroup.id === requestedGroupId) {
      text = isAdmin
        ? `✅ <b>Done.</b> The bot is now an admin in <b>${chosenLabel}</b> and can read all of its messages.`
        : `⚠️ The bot was added to <b>${chosenLabel}</b> (the right group), but not as an admin yet. `
          + `Please promote it to admin so it can read messages.`;
    } else {
      // Resolve the intended group's name for a helpful warning.
      let intendedLabel = `group #${requestedGroupId}`;
      try {
        const rows = await db.listDriverGroupAccess();
        const intended = rows.find((g) => Number(g.group_id) === requestedGroupId);
        if (intended) {
          const name = [intended.first_name, intended.last_name].filter(Boolean).join(' ').trim();
          intendedLabel = escapeHtml(name || intended.group_name || intendedLabel);
        }
      } catch (_) { /* best-effort */ }
      text = `⚠️ You added the bot to <b>${chosenLabel}</b>, but the request was for <b>${intendedLabel}</b>. `
        + `If that was a mistake, remove it there and use the link again, picking the correct group.`;
    }

    await telegram.sendMessage(settings.super_admin_telegram_id, text, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }).catch((err) => {
      console.warn('[GROUP-ACCESS] Could not DM super admin grant result:', err.message);
    });
  } catch (err) {
    console.error('[GROUP-ACCESS] confirmAdminGrant error:', err.message);
  }
}

module.exports = {
  RECENT_SEEN_DAYS,
  computeReadingVerdict,
  refreshDriverGroupBotAccess,
  confirmAdminGrant,
};
