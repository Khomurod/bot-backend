'use strict';

/**
 * Relaying a recruiter's Telegram reply back out as an SMS — the inbound half
 * of the two-way mirror.
 *
 * Split out of services/facebookLeadSmsMirrorService.js, which re-exports
 * everything here so no caller moved. That file records what goes OUT to a
 * candidate; this one carries what a recruiter types back the other way.
 *
 * THE REPLY LEAVES FROM THE NUMBER THE CANDIDATE WAS TEXTED FROM. Each mirror
 * row remembers its sender, so a candidate answering the recruiter who
 * contacted them keeps talking to that recruiter's number rather than being
 * handed to the shared company line mid-conversation.
 */
const db = require('../../database/db');
const rc = require('../../database/ringcentral');
const conversations = require('../../database/recruitingConversations');
const { sendSms, sendSmsAsRecruiter } = require('../ringCentralSmsService');
const { safeSend } = require('../telegramHtml');
const { escapeHtml, findMirrorByTelegramMessage } = require('./smsMirrorLookup');

async function handleTelegramSmsReply(telegram, {
  telegramChatId,
  replyToMessageId,
  replyText,
  userReplyMessageId = null,
}) {
  const text = String(replyText || '').trim();
  if (!text) {
    const err = new Error('replyText is required');
    err.statusCode = 400;
    throw err;
  }

  const mirror = await findMirrorByTelegramMessage(telegramChatId, replyToMessageId);
  if (!mirror) {
    const err = new Error('No auto-SMS mirror found for that message');
    err.statusCode = 404;
    throw err;
  }

  const { smsResult, sender } = await sendReplyFromMirror(mirror, text);
  if (!smsResult.ok) {
    const err = new Error(smsResult.detail || smsResult.reason || 'SMS send failed');
    err.statusCode = 502;
    err.smsResult = smsResult;
    throw err;
  }

  // RECORD WHAT THE RECRUITER TYPED. This used to send and forget, so the
  // ledger held the company's opening line and the candidate's answers and
  // nothing in between — anybody reading the thread back, a person or a model,
  // was reading half a conversation and could not tell it was half. Keyed on
  // the recruiter's own Telegram message, a real id in the same chat.
  if (userReplyMessageId) {
    try {
      await db.insertFacebookLeadSmsMirror({
        telegramChatId: mirror.telegram_chat_id,
        telegramMessageId: userReplyMessageId,
        driverPhone: mirror.driver_phone,
        smsBody: text,
        leadName: mirror.lead_name || null,
        pageId: mirror.page_id || null,
        ringcentralMessageId: smsResult.messageId || null,
        sourceType: 'outbound_recruiter',
        recruiterId: sender.recruiterId,
        fromNumber: sender.fromNumber,
      });
    } catch (recordErr) {
      // The SMS is already gone. Losing its record is bad, and not worth
      // failing a delivered reply over.
      console.warn('[FacebookLeadSmsMirror] Could not record the recruiter reply:', recordErr.message);
    }
    // A person has answered, so the conversation is theirs again and Wenze
    // must not resume it tonight.
    await standDownAfterHours(mirror.driver_phone);
  }

  if (telegram && userReplyMessageId) {
    const confirmChatId = mirror.telegram_chat_id;
    const fromLabel = sender.fromNumber ? ` from ${escapeHtml(sender.fromNumber)}` : '';
    const confirmText = `✅ Sent via SMS to ${escapeHtml(mirror.driver_phone)}${fromLabel}`;
    try {
      await safeSend(() => telegram.sendMessage(confirmChatId, confirmText, {
        parse_mode: 'HTML',
        reply_to_message_id: userReplyMessageId,
      }));
    } catch (confirmErr) {
      console.warn('[FacebookLeadSmsMirror] Confirmation reply failed:', confirmErr.message);
    }
  }

  return {
    ok: true,
    phone: mirror.driver_phone,
    fromNumber: sender.fromNumber,
    via: sender.via,
    messageId: smsResult.messageId,
    conversationId: smsResult.conversationId,
  };
}

/**
 * Send one reply on the mirror's own number, falling back to the shared number
 * rather than losing the reply — a driver waiting on an answer is worse than an
 * answer from the wrong number, and the fallback is logged for the operator.
 */
async function sendReplyFromMirror(mirror, text) {
  const recruiterId = Number(mirror?.recruiter_id);
  if (Number.isFinite(recruiterId) && recruiterId > 0) {
    let recruiter = null;
    try {
      recruiter = await rc.getRecruiterById(recruiterId);
    } catch (err) {
      console.warn('[FacebookLeadSmsMirror] Could not load the mirror recruiter:', err.message);
    }
    if (recruiter && rc.recruiterCanSendSms(recruiter)) {
      const attempt = await sendSmsAsRecruiter(recruiter, mirror.driver_phone, text);
      if (attempt.ok) {
        return {
          smsResult: attempt,
          // What actually sent, not the human-typed column.
          sender: { via: 'recruiter', recruiterId, fromNumber: attempt.fromNumber || null },
        };
      }
      // The detail is RingCentral's own body — the MSG-245 text that names
      // WHY. It used to be dropped here, so the reply path reported a bare
      // `http_400` and the same failure was diagnosable on the lead path only.
      console.warn(
        `[FacebookLeadSmsMirror] Reply from ${recruiter.name || `recruiter ${recruiterId}`} failed `
        + `(${attempt.reason}${attempt.detail ? `: ${String(attempt.detail).slice(0, 200)}` : ''})`
        + `${attempt.attemptedFrom ? ` [tried ${attempt.attemptedFrom}]` : ''}`
        + ' — using the shared number.'
      );
    }
  }

  const smsResult = await sendSms(mirror.driver_phone, text);
  return {
    smsResult,
    sender: { via: 'shared', recruiterId: null, fromNumber: smsResult.ok ? (smsResult.fromNumber || null) : null },
  };
}

/**
 * Hand a conversation back to the person who just replied.
 *
 * Best-effort and silent on failure: the recruiter's SMS has been delivered,
 * and `recruiterSpokeAfterWenze` in lib/recruiting/thread.js catches the same
 * case from the transcript on the next inbound message. This is the fast path,
 * not the only one.
 */
async function standDownAfterHours(driverPhone) {
  try {
    const existing = await conversations.getConversation(driverPhone);
    if (!existing || existing.status !== 'active') return;
    await conversations.closeConversation(driverPhone, {
      status: 'handed_off', reason: 'a recruiter replied',
    });
  } catch (err) {
    console.warn('[FacebookLeadSmsMirror] Could not hand the conversation back:', err.message);
  }
}

module.exports = {
  handleTelegramSmsReply,
  sendReplyFromMirror,
  standDownAfterHours,
};
