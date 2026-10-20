'use strict';

/**
 * Sending and editing the bot's proposals in the recruiting group's General
 * topic. The words are lib/hiringStages/messages.js's; this is the I/O.
 *
 * No `message_thread_id`: General is the topic without one. Every proposal is
 * a REPLY — to the message that moved the conversation on, or, for "please
 * create the deal", to the recruiter's own post — and is still sent if that
 * message was deleted meanwhile.
 *
 * An edit that fails (the message is too old, was deleted, or already reads
 * the same) is logged by id and never thrown: the database row, not the
 * Telegram message, is the record of what was decided.
 */

const msg = require('../../lib/hiringStages/messages');
const { dealUrl } = require('../bitrix24DealStages');

async function withLink(proposal) {
  if (!proposal.dealId) return proposal;
  return { ...proposal, dealUrl: await dealUrl(proposal.dealId) };
}

async function render(proposal) {
  const p = await withLink(proposal);
  if (p.kind === 'create_deal') return { text: msg.createDealText(p), keyboard: msg.createDealKeyboard(p.id) };
  return { text: msg.moveText(p), keyboard: msg.moveKeyboard(p.id, p.toStageName) };
}

/** Post a proposal. @returns the Telegram message id. Throws when Telegram refuses. */
async function sendProposal(telegram, proposal, replyToMessageId) {
  const { text, keyboard } = await render(proposal);
  const sent = await telegram.sendMessage(proposal.chatId, text, {
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    reply_to_message_id: Number(replyToMessageId),
    allow_sending_without_reply: true,
    reply_markup: keyboard,
  });
  return sent.message_id;
}

/** Show an open proposal again with its buttons (a "create the deal" that became a move). */
async function refreshProposal(telegram, proposal) {
  if (!proposal.botMessageId) return;
  const { text, keyboard } = await render(proposal);
  await edit(telegram, proposal, text, keyboard);
}

/** Close a proposal's message: the outcome, and no buttons for anybody. */
async function closeProposal(telegram, proposal, outcome, extra = {}) {
  if (!proposal.botMessageId) return;
  const text = msg.closedText(await withLink(proposal), outcome, extra);
  await edit(telegram, proposal, text, undefined);
}

async function edit(telegram, proposal, text, keyboard) {
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

module.exports = { sendProposal, refreshProposal, closeProposal };
