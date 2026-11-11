'use strict';

/**
 * The bot's Bitrix messages about one candidate, as they reach the topic. The
 * words are lib/hiringStages/messages.js's; the one-message-per-driver card
 * is services/hiringStages/card.js; this maps proposals onto it.
 *
 * READ IN GENERAL, WRITTEN IN THE BITRIX TOPIC (owner, November 2026), and
 * since 11 November 2026 as ONE CARD PER DRIVER: a question re-posts the
 * driver's card at the bottom of the topic, an answer edits it in place, news
 * (deal created, two people match, a Bitrix error) is a line on it.
 *
 * A proposal posted BEFORE cards existed — some still sit in General — is
 * closed by editing its own message, as it always was.
 *
 * An edit that fails (the message is too old, was deleted, or already reads
 * the same) is logged by id and never thrown: the database row, not the
 * Telegram message, is the record of what was decided.
 */

const msg = require('../../lib/hiringStages/messages');
const { dealUrl } = require('../bitrix24DealStages');
const card = require('./card');

async function withLink(proposal) {
  if (!proposal.dealId) return proposal;
  return { ...proposal, dealUrl: await dealUrl(proposal.dealId) };
}

async function question(proposal) {
  const p = await withLink(proposal);
  if (p.kind === 'create_deal') return { text: msg.createDealText(p), keyboard: msg.createDealKeyboard(p.id) };
  return { text: msg.moveText(p), keyboard: msg.moveKeyboard(p.id, p.toStageName) };
}

const convOf = (p, driverName = p.driverName) => ({ chatId: p.chatId, rootMessageId: p.rootMessageId, driverName });

/** Ask on the driver's card. @returns the card's message id. Throws when Telegram refuses. */
async function sendProposal(telegram, proposal, topicId) {
  return card.ask(telegram, topicId, convOf(proposal), await question(proposal));
}

/**
 * A line of news on the driver's card, once per conversation and key.
 * @param {{chatId, rootMessageId, driverName, key, line}} notice
 * @returns {Promise<boolean>} Never throws.
 */
async function sendNotice(telegram, topicId, notice) {
  return card.note(telegram, topicId, convOf(notice), { key: notice.key, line: notice.line });
}

async function editOwnMessage(telegram, proposal, text, keyboard) {
  try {
    await telegram.editMessageText(proposal.chatId, proposal.botMessageId, undefined, text, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...(keyboard ? { reply_markup: keyboard } : {}),
    });
  } catch (err) {
    console.warn(`[HIRING STAGES] could not edit proposal ${proposal.id}: ${String(err.message).slice(0, 120)}`);
  }
}

/** Show an open proposal again with its buttons (a "create the deal" that became a move). */
async function refreshProposal(telegram, proposal) {
  if (!proposal.botMessageId) return;
  const q = await question(proposal);
  if (await card.replace(telegram, proposal, q)) return;
  await editOwnMessage(telegram, proposal, q.text, q.keyboard);
}

/** Close a proposal: the outcome, and no buttons for anybody. */
async function closeProposal(telegram, proposal, outcome, extra = {}) {
  if (!proposal.botMessageId) return;
  const p = await withLink(proposal);
  if (await card.close(telegram, p, msg.outcomeLine(p, outcome, extra))) return;
  await editOwnMessage(telegram, p, msg.closedText(p, outcome, extra), undefined);
}

module.exports = {
  sendProposal, sendNotice, refreshProposal, closeProposal,
};
