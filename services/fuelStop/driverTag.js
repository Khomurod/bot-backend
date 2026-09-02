/**
 * Mentioning the driver on a fuel reminder.
 *
 * Telegram only reliably notifies users the bot has already seen, so a
 * username-less driver is pinged through a tg://user?id inline mention built
 * from the id captured in Driver Groups, falling back to a name lookup and then
 * to the plain escaped name. Wrong mention = the driver never sees the reminder.
 *
 * Split out of services/fuelStopAlertService.js, which re-exports these.
 */
const db = require('../../database/db');
const { buildMention, createMentionResolver } = require('../telegramMention');
const { normalizeText, buildDriverDisplayName } = require('./textRules');

// Resolver used to turn a username-less driver into a tg://user?id inline
// mention by looking their captured id up by name. Telegram only reliably
// notifies users the bot has already "seen", which broad id capture ensures.
const mentionResolver = createMentionResolver(db);

/**
 * Best mention for the driver on a fuel-alert / driver-profile row. Prefers the
 * stored @username; a username-less driver whose numeric telegram_user_id was
 * selected in Driver Groups still gets pinged via a tg://user?id inline
 * mention (Telegram only reliably notifies users the bot has seen — see
 * services/telegramMention.js). Without either, tries to resolve the captured
 * id by name, falling back to the plain escaped name if never captured.
 */
async function buildDriverTag(row) {
  const username = normalizeText(row?.telegram_username);
  const name = buildDriverDisplayName(row);
  if (username || row?.telegram_user_id != null) {
    return buildMention(
      { username, telegram_user_id: row?.telegram_user_id },
      { fallbackName: name }
    );
  }
  return mentionResolver.mentionForName(name, { fallbackName: name });
}

module.exports = {
  buildDriverTag,
};
