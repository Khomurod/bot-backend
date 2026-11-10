'use strict';

/**
 * Sending and editing the bot's Bitrix messages in the recruiting group's
 * BITRIX TOPIC. The words are lib/hiringStages/messages.js's; this is the I/O.
 *
 * READ IN GENERAL, WRITTEN IN THE BITRIX TOPIC (owner, November 2026). Every
 * new message — a proposal, a "please create it", a deal created, two people
 * matching, a Bitrix error — goes to `message_thread_id` = the Bitrix topic
 * saved in Settings → Safety Approvals → 5, never to General. It cannot reply
 * to the post across topics, so it names the driver and links the post.
 * Without a saved topic nothing is sent at all (the worker waits, `blocked`).
 *
 * A proposal's later states are EDITS of its own message, wherever it was
 * posted — one sent to General before the topic existed is closed there.
 *
 * An edit that fails (the message is too old, was deleted, or already reads
 * the same) is logged by id and never thrown: the database row, not the
 * Telegram message, is the record of what was decided. A notice is reserved
 * before it is sent (database/hiringStages/notices.js) and never thrown.
 */

const msg = require('../../lib/hiringStages/messages');
const notices = require('../../database/hiringStages/notices');
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

function topicOptions(topicId) {
  if (!Number.isInteger(Number(topicId)) || Number(topicId) <= 0) {
    throw new Error('no Bitrix topic is saved (Settings → Safety Approvals → 5)');
  }
  return { message_thread_id: Number(topicId), parse_mode: 'HTML', disable_web_page_preview: true };
}

/** Post a proposal in the Bitrix topic. @returns the Telegram message id. Throws when Telegram refuses. */
async function sendProposal(telegram, proposal, topicId) {
  const options = topicOptions(topicId);
  const { text, keyboard } = await render(proposal);
  const sent = await telegram.sendMessage(proposal.chatId, text, { ...options, reply_markup: keyboard });
  return sent.message_id;
}

/**
 * Post a notice in the Bitrix topic, once per conversation and key.
 * @param {object} notice  `{chatId, rootMessageId, key, text}`
 * @returns {Promise<boolean>} whether it was posted now. Never throws.
 */
async function sendNotice(telegram, topicId, notice) {
  let reservation = null;
  try {
    const options = topicOptions(topicId);
    reservation = await notices.reserve(notice.chatId, notice.rootMessageId, notice.key);
    if (!reservation) return false;
    const sent = await telegram.sendMessage(notice.chatId, notice.text, options);
    await notices.recordSent(reservation, sent.message_id);
    return true;
  } catch (err) {
    console.warn(`[HIRING STAGES] could not post the "${notice.key}" notice: ${String(err.message).slice(0, 120)}`);
    if (reservation) await notices.release(reservation).catch(() => {});
    return false;
  }
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

module.exports = {
  sendProposal, sendNotice, refreshProposal, closeProposal,
};
