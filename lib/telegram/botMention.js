'use strict';

/**
 * Does a Telegram message tag the bot itself? Pure.
 *
 * A `mention` entity that is `@` + the bot's own username (any letter case —
 * read from Telegram at start, never written here), or a `text_mention` of the
 * bot's id, in `entities` or `caption_entities`. Shared by the recruiting
 * group's requests (lib/hiringStages/botRequest.js) and Truck Photos'
 * corrections in a driver group (services/truckPhotos/correction.js).
 */

/** The text an entity covers (Telegram offsets are UTF-16 code units, as JS strings are). */
function entityText(text, entity) {
  const offset = Number(entity?.offset);
  const length = Number(entity?.length);
  if (!Number.isInteger(offset) || !Number.isInteger(length)) return '';
  return String(text || '').slice(offset, offset + length);
}

/** The entities that tag the bot, with the text they sit in. */
function botMentions(message, botInfo) {
  if (!message || !botInfo) return [];
  const handle = botInfo.username ? `@${String(botInfo.username)}`.toLowerCase() : null;
  const botId = botInfo.id == null ? null : String(botInfo.id);
  const parts = [[message.text, message.entities], [message.caption, message.caption_entities]];
  const found = [];
  for (const [text, entities] of parts) {
    for (const entity of Array.isArray(entities) ? entities : []) {
      const mine = (entity?.type === 'mention' && handle !== null && entityText(text, entity).toLowerCase() === handle)
        || (entity?.type === 'text_mention' && botId !== null && String(entity.user?.id) === botId);
      if (mine) found.push({ text, entity });
    }
  }
  return found;
}

/**
 * @param {object} message   a Telegram message
 * @param {{id?: number, username?: string}} botInfo  the bot itself (ctx.botInfo)
 */
function mentionsBot(message, botInfo) {
  return botMentions(message, botInfo).length > 0;
}

/** The message's words with the bot's tag taken out — what the person asked. */
function withoutBotMention(message, botInfo) {
  const text = String(message?.text ?? message?.caption ?? '');
  const cuts = botMentions(message, botInfo)
    .filter((m) => m.text === text)
    .map((m) => [Number(m.entity.offset), Number(m.entity.offset) + Number(m.entity.length)])
    .sort((a, b) => b[0] - a[0]);
  let out = text;
  for (const [from, to] of cuts) out = `${out.slice(0, from)}${out.slice(to)}`;
  return out.replace(/\s+/g, ' ').trim();
}

module.exports = {
  entityText, mentionsBot, withoutBotMention,
};
