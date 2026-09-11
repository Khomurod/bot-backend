'use strict';

/**
 * The seam between the SMS mirror and the after-hours reply.
 *
 * Two jobs, both of them plumbing, kept out of both neighbours:
 *
 *   1. Post what Wenze said into the recruiter's Telegram lead thread, and
 *      record it as an `outbound_ai` mirror row.
 *   2. Offer an inbound candidate SMS to `afterHoursReply.considerReply`,
 *      fire-and-forget.
 *
 * IT LIVES HERE BECAUSE THE DEPENDENCY ONLY GOES ONE WAY. The mirror service
 * owns Telegram and is called by the inbound route; the reply orchestrator
 * needs to post to Telegram. Requiring one from the other would close a cycle,
 * which this repository forbids. This module depends on both and neither
 * depends on it.
 *
 * NOTHING HERE MAY THROW. It is called from the path that records a candidate's
 * message, and a message must be recorded whether or not Wenze has anything to
 * say about it.
 */
const { sendTelegramHtmlChunks } = require('../telegramHtml');
const { sendToChatIdWithFallback, getLeadsTelegram } = require('../leadsTelegramClient');

function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function defaultDeps() {
  /* eslint-disable global-require */
  return {
    db: require('../../database/db'),
    considerReply: require('./afterHoursReply').considerReply,
    get telegram() {
      try { return getLeadsTelegram(); } catch (_) { return null; }
    },
  };
  /* eslint-enable global-require */
}

/**
 * The Telegram card for a reply Wenze sent in a recruiter's name.
 *
 * IT SAYS IT WAS WENZE, in the first line, every time. The candidate cannot
 * tell — the SMS came from the recruiter's own number, which is the point — but
 * the recruiter reading their thread on Monday morning absolutely must, before
 * they answer on top of it.
 */
function buildAiReplyHtml({ phone, text, recruiterName }) {
  const who = recruiterName ? ` as ${escapeHtml(recruiterName)}` : '';
  return `🤖 <b>Wenze answered after hours</b>${who} — SMS to ${escapeHtml(phone)}:\n`
    + `<pre>${escapeHtml(text)}</pre>`;
}

/**
 * Post the reply and record it.
 *
 * The mirror row is written even when Telegram fails, and that order is
 * deliberate: the row is what the NEXT turn reads to know Wenze already spoke,
 * so losing it to a Telegram outage would let the same question be answered
 * twice. Without a Telegram message id there is no mirror key, so the row is
 * keyed on the chat plus a negative synthetic id — negative because Telegram
 * message ids are positive and the two must never collide.
 */
async function postAiReplyToThread({
  telegramChatId, phone, text, recruiter = null, leadName = null,
  ringcentralMessageId = null,
}, deps = defaultDeps()) {
  const chatId = Number(telegramChatId);
  if (!Number.isFinite(chatId)) return { ok: false, reason: 'no_thread' };

  const html = buildAiReplyHtml({ phone, text, recruiterName: recruiter?.name || null });

  let messageId = null;
  let resolvedChatId = chatId;
  try {
    const telegram = deps.telegram;
    if (telegram) {
      let sendChatId = chatId;
      const sent = await sendToChatIdWithFallback(
        (id) => { sendChatId = id; return sendTelegramHtmlChunks(telegram, id, html); },
        chatId,
      );
      messageId = sent?.[0]?.message_id ?? null;
      resolvedChatId = sent?.[0]?.chat?.id ?? sendChatId;
    }
  } catch (err) {
    console.warn('[RecruitingAfterHours] Telegram post failed:', err.message);
  }

  try {
    await deps.db.insertFacebookLeadSmsMirror({
      telegramChatId: resolvedChatId,
      telegramMessageId: messageId ?? -Date.now(),
      driverPhone: phone,
      smsBody: text,
      leadName,
      ringcentralMessageId,
      sourceType: 'outbound_ai',
      recruiterId: recruiter?.id ?? null,
      fromNumber: recruiter?.phone_number ?? null,
    });
  } catch (err) {
    console.warn('[RecruitingAfterHours] could not record the reply:', err.message);
    return { ok: false, reason: 'mirror_insert_failed', messageId };
  }

  return { ok: true, messageId, telegramChatId: resolvedChatId };
}

/**
 * Offer one inbound candidate SMS to the after-hours reply.
 *
 * Every path returns; none throws. The caller has already recorded the
 * candidate's message and must not be made to care what happened next.
 */
async function considerAfterHoursReply(args, deps = defaultDeps()) {
  try {
    // eslint-disable-next-line global-require
    const orchestrator = require('./afterHoursReply');
    return await deps.considerReply(args, {
      ...orchestrator.defaultDeps(),
      postToThread: (postArgs) => postAiReplyToThread(postArgs, deps),
    });
  } catch (err) {
    console.warn('[RecruitingAfterHours] stood down after an error:', err.message);
    return { sent: false, reason: 'error', detail: err.message };
  }
}

module.exports = {
  escapeHtml,
  buildAiReplyHtml,
  defaultDeps,
  postAiReplyToThread,
  considerAfterHoursReply,
};
