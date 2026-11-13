'use strict';

/**
 * The ONE message per candidate in the Bitrix topic (owner, 11 November 2026:
 * "the bot must not spam the group"). The words are
 * lib/hiringStages/messages.js `cardText`; the row is
 * database/hiringStages/cards.js; this is the I/O.
 *
 *   ask      a new question: the card is re-posted at the BOTTOM of the topic
 *            with it (so people see it), and the previous copy is deleted
 *   note     a line of news — deal created, two people match, a Bitrix
 *            error — once per key; the card moves to the bottom with it
 *   close    the question was answered: its line joins the history and the
 *            buttons go, EDITED IN PLACE — an answer is not news
 *   replace  the question changed in place ("search again" found the deal)
 *   offerAside / closeAside   a second, smaller question that stays while
 *            the stage question changes — "✏️ Name in Bitrix: “No name” →
 *            …?" — added and answered IN PLACE, so the message an open
 *            proposal points at is never replaced by it
 *
 * A copy Telegram will not delete (too old, no right) is edited to point
 * below instead. A send Telegram refuses THROWS from `ask` (the proposal is
 * then `unsent` and retried); `note` never throws.
 *
 * Read in General, written here only: every send carries the Bitrix topic's
 * `message_thread_id`, and without a saved topic nothing is sent.
 */

const cards = require('../../database/hiringStages/cards');
const notices = require('../../database/hiringStages/notices');
const msg = require('../../lib/hiringStages/messages');

function topicOptions(topicId) {
  if (!Number.isInteger(Number(topicId)) || Number(topicId) <= 0) {
    throw new Error('no Bitrix topic is saved (Settings → Safety Approvals → 5)');
  }
  return { message_thread_id: Number(topicId), parse_mode: 'HTML', disable_web_page_preview: true };
}

const textOf = (card) => msg.cardText({ ...card, current: card.currentText, aside: card.asideText });
const markupOf = (card) => {
  const keyboard = msg.cardKeyboard(card);
  return keyboard ? { reply_markup: keyboard } : {};
};
const warn = (what, err) => console.warn(`[HIRING STAGES] could not ${what}: ${String(err?.message || err).slice(0, 120)}`);

async function retire(telegram, chatId, messageId) {
  try {
    await telegram.deleteMessage(chatId, messageId);
    return;
  } catch { /* too old, or no right to delete: point below instead */ }
  try {
    await telegram.editMessageText(chatId, messageId, undefined, '⤵️ Updated — see the newer message below.', {});
  } catch (err) {
    warn(`retire card message ${messageId}`, err);
  }
}

/** Post the card at the bottom of the topic, then take the previous copy away. @returns the new message id */
async function repost(telegram, topicId, card) {
  const options = topicOptions(topicId);
  const sent = await telegram.sendMessage(card.chatId, textOf(card), { ...options, ...markupOf(card) });
  await cards.updateCard(card.chatId, card.rootMessageId, { messageId: sent.message_id });
  if (card.messageId && card.messageId !== sent.message_id) await retire(telegram, card.chatId, card.messageId);
  return sent.message_id;
}

async function editInPlace(telegram, card) {
  if (!card?.messageId) return;
  try {
    await telegram.editMessageText(card.chatId, card.messageId, undefined, textOf(card), {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...markupOf(card),
    });
  } catch (err) {
    warn(`edit card message ${card.messageId}`, err);
  }
}

/**
 * A new question on the driver's card.
 * @param {{chatId, rootMessageId, driverName}} conv
 * @param {{text: string, keyboard?: object}} question
 * @returns {Promise<number>} the card's message id — the proposal's bot message
 * @throws when Telegram refuses (nothing is shown then)
 */
async function ask(telegram, topicId, conv, question) {
  topicOptions(topicId);
  await cards.ensureCard(conv.chatId, conv.rootMessageId, conv.driverName);
  const card = await cards.updateCard(conv.chatId, conv.rootMessageId, { current: question });
  return repost(telegram, topicId, card);
}

/**
 * A line of news on the driver's card, once per conversation and key.
 * @returns {Promise<boolean>} whether it was shown now. Never throws.
 */
async function note(telegram, topicId, conv, { key, line }) {
  let reservation = null;
  try {
    topicOptions(topicId);
    reservation = await notices.reserve(conv.chatId, conv.rootMessageId, key);
    if (!reservation) return false;
    await cards.ensureCard(conv.chatId, conv.rootMessageId, conv.driverName);
    const card = await cards.updateCard(conv.chatId, conv.rootMessageId, { line });
    const messageId = await repost(telegram, topicId, card);
    await notices.recordSent(reservation, messageId);
    return true;
  } catch (err) {
    warn(`post the "${key}" line`, err);
    if (reservation) await notices.release(reservation).catch(() => {});
    return false;
  }
}

/** The card showing this proposal now, or null (a message from before cards, or a card moved on). */
async function cardShowing(proposal) {
  if (!proposal?.botMessageId) return null;
  const card = await cards.getCard(proposal.chatId, proposal.rootMessageId).catch(() => null);
  return card && card.messageId === Number(proposal.botMessageId) ? card : null;
}

/**
 * The proposal was answered: `line` joins the history, the buttons go, edited
 * in place. A null line (superseded) leaves no trace — the new question follows.
 * @returns {Promise<boolean>} false when no card shows it (the caller edits the old message)
 */
async function close(telegram, proposal, line) {
  if (!(await cardShowing(proposal))) return false;
  const updated = await cards.updateCard(proposal.chatId, proposal.rootMessageId, { line, current: null });
  if (line) await editInPlace(telegram, updated);
  return true;
}

/** The open question changed in place. @returns false when no card shows it */
async function replace(telegram, proposal, question) {
  if (!(await cardShowing(proposal))) return false;
  const updated = await cards.updateCard(proposal.chatId, proposal.rootMessageId, { current: question });
  await editInPlace(telegram, updated);
  return true;
}

/**
 * Add the aside question to the driver's card: edited in place when the card
 * is already posted, posted when it is not.
 * @returns {Promise<number>} the card's message id
 * @throws when Telegram refuses a NEW card (nothing is shown then)
 */
async function offerAside(telegram, topicId, conv, aside) {
  topicOptions(topicId);
  await cards.ensureCard(conv.chatId, conv.rootMessageId, conv.driverName);
  const card = await cards.updateCard(conv.chatId, conv.rootMessageId, { aside });
  if (!card.messageId) return repost(telegram, topicId, card);
  await editInPlace(telegram, card);
  return card.messageId;
}

/**
 * The aside was answered: `line` joins the history and its buttons go,
 * edited in place. Only the aside whose buttons carry `callbackData` is
 * cleared — a newer one is left alone.
 * @returns {Promise<boolean>} false when the card has no such aside
 */
async function closeAside(telegram, conv, callbackData, line) {
  const card = await cards.getCard(conv.chatId, conv.rootMessageId).catch(() => null);
  const showing = card && JSON.stringify(card.asideKeyboard || {}).includes(`"${callbackData}"`);
  const updated = await cards.updateCard(conv.chatId, conv.rootMessageId, showing ? { line, aside: null } : { line });
  if (updated) await editInPlace(telegram, updated);
  return Boolean(showing);
}

module.exports = {
  ask, note, close, replace, offerAside, closeAside, topicOptions,
};
