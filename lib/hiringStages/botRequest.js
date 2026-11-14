'use strict';

/**
 * A person ASKING the bot for a lead in the recruiting group — the rules, pure
 * (owner, 13–14 November 2026; docs/architecture/hiring-stage-proposals.md
 * rule 20).
 *
 * THE TRIGGER. Anyone in the group replies to the lead's post with a message
 * that mentions the bot: a `mention` entity that is `@` + the bot's own
 * username (any letter case — the username is the bot's, read from Telegram
 * at start, never written here), or a `text_mention` of the bot's id, in
 * `entities` or `caption_entities`. It counts only
 *
 *   - in General (no topic thread), as a REAL reply — not the "reply" to a
 *     topic's root Telegram marks every topic message with
 *     (lib/telegram/messageParts.js `replyTarget`);
 *   - from a person: `from.is_bot` false — which also refuses the anonymous
 *     admin, whom Telegram sends as GroupAnonymousBot;
 *   - as a NEW message: editing a message to add the mention asks nothing;
 *   - with Safety Approvals on, its stage proposals on and a Bitrix topic
 *     saved. Otherwise nothing is done at all.
 *
 * A mention that is not a reply is not a request.
 *
 * THE TAGGING MESSAGE CARRIES NO DATA (owner: "not in that format"). A post
 * that lacks the name or phone is EDITED, then tagged. So the post is read in
 * its CURRENT version: `postNeedsRefresh` says when the copy Telegram sends
 * with the tag (`reply_to_message`) is newer than the stored one.
 *
 * THE ANSWER IS A REACTION on the tagging message, never words in General:
 * 👀 as soon as the request is accepted, then 👍 when the candidate has a deal
 * (found, created, or the conversation's own) or a Move was proposed, or 🤷
 * when it needs a person. The owner asked for ✅ — Telegram does not let a
 * bot react with ✅ (services/autoReactionConstants.js lists what it allows),
 * so "done" is 👍, as Truck Photos' delivery reaction is.
 */

const { replyTarget, senderName } = require('../telegram/messageParts');

const REQUEST_REACTIONS = Object.freeze({
  accepted: '👀',
  answered: '👍',
  needsPerson: '🤷',
});

/** The text an entity covers (Telegram offsets are UTF-16 code units, as JS strings are). */
function entityText(text, entity) {
  const offset = Number(entity?.offset);
  const length = Number(entity?.length);
  if (!Number.isInteger(offset) || !Number.isInteger(length)) return '';
  return String(text || '').slice(offset, offset + length);
}

/**
 * Does this message mention the bot?
 * @param {object} message   a Telegram message
 * @param {{id?: number, username?: string}} botInfo  the bot itself (ctx.botInfo)
 */
function mentionsBot(message, botInfo) {
  if (!message || !botInfo) return false;
  const handle = botInfo.username ? `@${String(botInfo.username)}`.toLowerCase() : null;
  const botId = botInfo.id == null ? null : String(botInfo.id);
  const parts = [[message.text, message.entities], [message.caption, message.caption_entities]];
  return parts.some(([text, entities]) => (Array.isArray(entities) ? entities : []).some((entity) => {
    if (entity?.type === 'mention') return handle !== null && entityText(text, entity).toLowerCase() === handle;
    if (entity?.type === 'text_mention') return botId !== null && String(entity.user?.id) === botId;
    return false;
  }));
}

/**
 * A REPLY that mentions the bot: a request to it, never data — stored with
 * `bot_request` and left out of every stage read (its words, phones, names).
 * A post that mentions the bot without replying to anything is an ordinary
 * message: it asks nothing and stays data.
 */
function isBotRequestMessage(message, botInfo) {
  return Boolean(replyTarget(message)) && mentionsBot(message, botInfo);
}

const refuse = (reason) => ({ request: null, reason });

/**
 * Is this message a request to read the lead it replies to?
 * @param {object} message   a Telegram message (new or edited)
 * @param {{botInfo: object, settings: object}} context  Safety Approvals settings
 * @returns {{request: {replyToMessageId: number, requestMessageId: number,
 *   requestedByUserId: string, requestedByName: string|null}} | {request: null, reason: string}}
 */
function readBotRequest(message, { botInfo, settings } = {}) {
  if (!mentionsBot(message, botInfo)) return refuse('no_mention');
  if (!settings?.enabled || !settings.stageProposalsEnabled) return refuse('switched_off');
  if (!(Number(settings.bitrixTopicId) > 0)) return refuse('no_bitrix_topic');
  if (String(message.chat?.id) !== String(settings.chatId)) return refuse('another_chat');
  if (message.edit_date) return refuse('an_edit');
  if (message.message_thread_id != null) return refuse('another_topic');
  const target = replyTarget(message);
  if (!target) return refuse('not_a_reply');
  if (!message.from || message.from.is_bot) return refuse('not_a_person');
  return {
    request: {
      replyToMessageId: Number(target),
      requestMessageId: Number(message.message_id),
      requestedByUserId: String(message.from.id),
      requestedByName: senderName(message.from),
    },
  };
}

const timeOf = (value) => {
  if (!value) return null;
  const at = new Date(value).getTime();
  return Number.isFinite(at) ? at : null;
};

/**
 * Is the copy of a message Telegram sent with a tag (`reply_to_message`)
 * newer than the stored one? A newer edit, or — with no older edit date —
 * different words. An OLDER copy never replaces a newer one.
 * @param {object|null} stored  database/safetyApprovals/messages.js row
 * @param {object} fresh        the reply_to_message, shaped (lib/safetyApprovals/messageShape.js)
 */
function postNeedsRefresh(stored, fresh) {
  if (!stored) return true;
  const was = timeOf(stored.editedAt);
  const now = timeOf(fresh?.editedAt);
  if (was !== null && now !== null && now < was) return false;
  if (now !== null && (was === null || now > was)) return true;
  return (stored.text ?? null) !== (fresh?.text ?? null);
}

/**
 * The reaction that answers a read a person asked for, or null to leave 👀
 * (the read will run again — a retry, or a creation read again shortly).
 * @param {{hasDeal: boolean, status: string}} read
 */
function requestReaction({ hasDeal, status }) {
  if (hasDeal) return REQUEST_REACTIONS.answered;
  if (status === 'retry') return null;
  return REQUEST_REACTIONS.needsPerson;
}

module.exports = {
  REQUEST_REACTIONS, mentionsBot, isBotRequestMessage, readBotRequest, postNeedsRefresh, requestReaction,
};
