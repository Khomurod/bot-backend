'use strict';

/**
 * Reading a reply in the notification group and acting on it.
 *
 * THE GATES, IN ORDER, AND WHY THIS ORDER. Each one is cheaper than the next
 * and each rejects a whole class, so a group carrying ordinary chatter costs
 * almost nothing:
 *
 *   1. shape          not a group, a bot, no `reply_to_message`, no text →
 *                     not ours, and NOT ONE DATABASE QUERY IS MADE. This is
 *                     the common case by orders of magnitude: people talking
 *                     to each other.
 *   2. switched off   `control_settings.enabled = false` → silence, not a
 *                     refusal message. An off switch that announces itself in
 *                     the chat is not off.
 *   3. is it ours     the replied-to message must be a notice WE sent that
 *                     carries a question. A reply to any other message of ours
 *                     is somebody talking, not answering.
 *   4. WHO            the allow-list. Recorded either way — "a stranger
 *                     answered an operational question" is worth a trace — but
 *                     never obeyed and never answered. Answering would tell an
 *                     unauthorised person that their reply was read, which is
 *                     an invitation.
 *   5. redelivery     `recordReply` claims (chat, message). A null claim means
 *                     this exact reply is already recorded; stop.
 *   6. still open     the finding is re-read LIVE. Minutes have passed since
 *                     the question; somebody may have fixed it in the admin.
 *   7. what it means  the deterministic parser first, ALWAYS. A model is
 *                     reached only when that returns `unclear`, and even then
 *                     it may only pick from what the question offered — see
 *                     `services/control/aiIntent.js`.
 *   8. do it          `executeOffered`, the only writer. A "no" is then
 *                     remembered against the CONDITION, so the next sweep does
 *                     not ask it again.
 *
 * The acknowledgement goes back as a REPLY to the operator's own message, so a
 * busy group shows the answer under the question rather than at the bottom.
 */
const defaultSettings = require('../../database/controlSettings');
const defaultOperators = require('../../database/controlOperators');
const defaultReplies = require('../../database/controlReplies');
const defaultNotices = require('../../database/operationalNotifications');
const defaultFindings = require('../../database/operationalFindings');
const defaultSend = require('../notifications/send');
const { parseIntent } = require('../../lib/control/intent');
const { executeOffered } = require('./actions');
const { readReplyWithAi } = require('./aiIntent');
const { shouldRemember, rememberAnswerFor } = require('./memory');
const defaultEngineering = require('../../database/engineeringRequests');
const { replyHintFor } = require('../../lib/control/askable');

function defaultDeps() {
  return {
    settings: defaultSettings,
    operators: defaultOperators,
    replies: defaultReplies,
    notices: defaultNotices,
    findings: defaultFindings,
    parseIntent,
    readReplyWithAi,
    executeOffered,
    rememberAnswerFor,
    fileRequest: defaultEngineering.fileRequest,
    notify: defaultSend.notify,
    // Injected rather than imported so a test never reaches the outbox, and so
    // this module has no opinion about how a message is sent.
    ack: null,
  };
}

const GROUP_TYPES = new Set(['group', 'supergroup']);

/**
 * @param {object} reply  { chatId, messageId, repliedToMessageId, text,
 *                          telegramUserId, chatType, fromIsBot }
 * @returns {Promise<{handled:boolean, outcome?:string, reason?:string}>}
 *   never throws — a failure here must not break the group message pipeline.
 */
async function handleControlReply(reply, deps = defaultDeps()) {
  const {
    chatId, messageId, repliedToMessageId, text,
    telegramUserId, chatType, fromIsBot,
  } = reply || {};

  // ── 1. shape ──────────────────────────────────────────────────────────────
  if (!GROUP_TYPES.has(chatType)) return { handled: false, reason: 'not_a_group' };
  if (fromIsBot) return { handled: false, reason: 'from_a_bot' };
  if (repliedToMessageId == null || messageId == null || chatId == null) {
    return { handled: false, reason: 'not_a_reply' };
  }
  if (!String(text || '').trim()) return { handled: false, reason: 'no_text' };

  try {
    // ── 3. is it ours ───────────────────────────────────────────────────────
    //
    // BEFORE the enabled check reads anything else, because this is what tells
    // an ordinary group message from an answer. A chat full of drivers replying
    // to each other must not cost a settings read each time — but it must cost
    // one lookup, and this is it.
    const notice = await deps.notices.findNoticeByTelegramMessage(chatId, repliedToMessageId);
    if (!notice || !notice.question) return { handled: false, reason: 'not_a_question' };

    // ── 2. switched off ─────────────────────────────────────────────────────
    const settings = await deps.settings.getControlSettings();
    if (settings.enabled === false) {
      await deps.replies.recordReply({
        notificationId: notice.id, chatId, replyMessageId: messageId,
        repliedToMessageId, telegramUserId, authorised: false,
        rawText: text, outcome: 'ignored_disabled', findingId: notice.findingId,
      }).catch(() => null);
      return { handled: true, outcome: 'ignored_disabled' };
    }

    // ── 4. WHO ──────────────────────────────────────────────────────────────
    const authorised = await deps.operators.isControlOperator(telegramUserId);

    // ── 5. redelivery ───────────────────────────────────────────────────────
    const claim = await deps.replies.recordReply({
      notificationId: notice.id, chatId, replyMessageId: messageId,
      repliedToMessageId, telegramUserId, authorised,
      rawText: text,
      outcome: authorised ? 'no_op' : 'ignored_unauthorised',
      findingId: notice.findingId,
    });
    if (!claim) return { handled: true, outcome: 'redelivery' };

    if (!authorised) {
      // Recorded, never answered. See the header.
      return { handled: true, outcome: 'ignored_unauthorised' };
    }

    // ── 6. still open ───────────────────────────────────────────────────────
    const finding = notice.findingId
      ? await deps.findings.getFindingById(notice.findingId)
      : null;
    if (!finding) {
      await deps.replies.finaliseReply(claim.id, { outcome: 'no_op' });
      await say(deps, reply, 'That one is gone from my list.');
      return { handled: true, outcome: 'no_op' };
    }
    if (finding.status !== 'open') {
      await deps.replies.finaliseReply(claim.id, { outcome: 'no_op' });
      await say(deps, reply, `Already ${finding.status}. Nothing to do.`);
      return { handled: true, outcome: 'no_op' };
    }

    // ── 7. what it means ────────────────────────────────────────────────────
    const offered = notice.question.offeredActions || [];
    let intent = deps.parseIntent(text, { offered });

    // THE MODEL IS THE SECOND READER, NEVER THE FIRST. Every reply the fixed
    // rules understand — which is nearly all of them — is decided with no model
    // involved. `remember` is carried across because "don't ask me again" is
    // read by the deterministic rules even when the rest of the sentence is not.
    if (intent.intent === 'unclear') {
      const fromAi = await deps.readReplyWithAi(text, { offered });
      intent = { ...fromAi, remember: intent.remember || fromAi.remember };
    }

    if (intent.intent === 'engineering_request') {
      // A COMPLAINT ABOUT THE SOFTWARE BECOMES A ROW, AND ONLY A ROW. The ack
      // names its number so the owner can see it went somewhere, and says
      // plainly that nothing in the code changed — because nothing did, and
      // nothing in this application can. See
      // `database/engineeringRequests.js`: there is no column a patch could
      // live in.
      const filed = await deps.fileRequest({
        source: 'control_reply',
        replyId: claim.id,
        findingId: notice.findingId,
        requestedBy: `telegram:${telegramUserId}`,
        requestText: text,
      }).catch((err) => {
        console.warn('[CONTROL] could not file an engineering request:', err.message);
        return null;
      });

      // IF IT WAS NOT WRITTEN DOWN, SAY SO. The reply claim is already taken —
      // it has to be, it is the redelivery guard and it is taken before
      // anything is acted on — so Telegram will never deliver this sentence
      // again. Answering "noted" when nothing was recorded would lose the
      // complaint AND convince the owner it was safe, which is worse than
      // losing it. The outcome is recorded as `failed` so the trail says the
      // same thing the owner was told.
      await deps.replies.finaliseReply(claim.id, {
        outcome: filed?.request ? 'engineering_request' : 'failed',
        intent,
      });
      await say(deps, reply, filed?.request
        ? `Noted as request #${filed.request.id} for a person to build. Nothing in the system changed.`
        : 'I could not write that down — please tell somebody directly. Nothing in the system changed.');
      return {
        handled: true,
        outcome: filed?.request ? 'engineering_request' : 'failed',
        requestId: filed?.request?.id ?? null,
      };
    }
    // THIS REPLY IS THE REASON WE ASKED FOR. When the question they are
    // answering was Wenze's own "why?", their sentence IS the answer — it is not
    // a yes, a no or a later, and running it through a parser that only knows
    // those three throws away the one thing that was asked for. "He is a team
    // driver" is a reason, not an unclear reply.
    const pending = notice.question?.pending || null;
    if (pending?.action === 'dismiss' && intent.intent === 'unclear') {
      intent = {
        ...intent, intent: 'dismiss', action: 'dismiss',
        reason: String(text).trim().slice(0, 500),
        remember: true,
      };
    }

    if (intent.intent === 'unclear' || !intent.action) {
      await deps.replies.finaliseReply(claim.id, { outcome: 'clarified', intent });
      return askAgain(deps, { reply, notice, settings, offered }, {
        message: 'I did not follow that. Reply yes, no (and why), or later.',
        exhausted: 'I still did not follow that, so I am leaving it open for you.',
      });
    }

    // A BARE "NO" IS NOT A REASON, and a finding closed with no reason recorded
    // is a decision nobody can review later. One "why?" — and only one, bounded
    // by `clarify_limit` — then the default reason is used rather than nagging.
    if (intent.action === 'dismiss' && !intent.reason
        && (notice.clarifyRound || 0) < settings.clarifyLimit) {
      await deps.replies.finaliseReply(claim.id, { outcome: 'clarified', intent });
      return askAgain(deps, { reply, notice, settings, offered }, {
        message: 'Understood — why? I will write it down so I do not ask again.',
        exhausted: null,
        pending: { action: 'dismiss' },
      });
    }

    // ── 8. do it ────────────────────────────────────────────────────────────
    const result = await deps.executeOffered({
      question: notice.question, finding, intent, telegramUserId,
    });
    await deps.replies.finaliseReply(claim.id, {
      outcome: result.outcome,
      intent,
      chosenAction: intent.action,
      findingId: finding.id,
      decisionId: result.decisionId ?? null,
      correctionId: result.correctionId ?? null,
    });
    // The question is closed by whichever reply got here first; a second
    // operator answering seconds later is told the truth rather than silently
    // applying the same change again.
    await deps.notices.markNoticeAnswered(notice.id, claim.id).catch(() => {});
    // AND THE QUESTION THAT STARTED THE CHAIN. Every unanswered notice carrying
    // a question counts against the standing cap, so a clarification answered
    // while its parent stayed open would burn a slot for the whole repeat window
    // — five such conversations and the ask pass stops sending anything, with
    // every visible question answered. Marking is idempotent: only the first
    // reply closes a notice.
    const root = rootOf(notice);
    if (root !== notice.id) {
      await deps.notices.markNoticeAnswered(root, claim.id).catch(() => {});
    }

    // ── remember it ─────────────────────────────────────────────────────────
    //
    // AFTER the change, never before: a memory for an answer that failed to
    // apply would silence the finding without fixing anything. Silent on
    // failure — see `services/control/memory.js`.
    let remembered = false;
    if (shouldRemember({ outcome: result.outcome, intent })) {
      remembered = Boolean(await deps.rememberAnswerFor({
        finding, intent, telegramUserId, replyId: claim.id,
      }).catch(() => null));
    }

    await say(deps, reply, remembered && result.outcome === 'dismissed'
      ? 'Closed, and noted — I will not ask again while nothing changes.'
      : result.message);
    return { handled: true, outcome: result.outcome, remembered };
  } catch (err) {
    console.warn('[CONTROL] reply handling failed:', err.message);
    return { handled: false, reason: 'error' };
  }
}

/**
 * Come back with one more question, or stand down.
 *
 * WHY THIS IS A NOTICE AND NOT JUST A MESSAGE. A clarification the owner cannot
 * REPLY TO is a dead end: the reply path only recognises an answer to a message
 * that carries a `question_json`, so a plain "why?" would be read as ordinary
 * chatter and their explanation would be lost. This sends a real question,
 * pinned under theirs, carrying the same closed set of choices and a
 * `clarify_round` one higher — which is what stops it going round for ever.
 *
 * `exhausted: null` means "no third message" — used for the "why?" follow-up,
 * where the ordinary path takes the default reason on the next reply.
 */
async function askAgain(deps, { reply, notice, settings, offered }, { message, exhausted, pending = null }) {
  const round = Number(notice.clarifyRound || 0);
  if (round >= Math.max(0, Number(settings.clarifyLimit) || 0)) {
    if (exhausted) await say(deps, reply, exhausted);
    return { handled: true, outcome: 'clarified', clarified: false };
  }
  const sent = await Promise.resolve(deps.notify({
    category: 'needs_attention',
    title: message,
    lines: [replyHintFor(offered)],
    // THE SUBJECT IS THE REPLY, NOT THE DRIVER — the same choice the
    // acknowledgement makes, for the same reason. The burst suppressor groups by
    // subject, and a follow-up question held for an hour behind the question it
    // is following up on is a conversation that stops mid-sentence.
    subjectType: 'control_reply',
    subjectId: `${reply.chatId}:${reply.messageId}`,
    findingId: notice.findingId,
    severity: 'info',
    // UNDER THEIR OWN MESSAGE, in the chat they typed it in. `inReplyTo` is the
    // one documented exception to category routing, for exactly this.
    inReplyTo: { chatId: reply.chatId, messageId: reply.messageId },
    question: {
      findingId: notice.findingId,
      decisionId: notice.question?.decisionId ?? null,
      offeredActions: offered,
      // ALWAYS THE ROOT, never the immediate parent. Every notice in a chain
      // points at the question that started it, so closing the chain is two
      // marks rather than a walk — and stays two at any depth.
      parentNoticeId: rootOf(notice),
      // WHAT THIS FOLLOW-UP IS FOR. Without it the answer to "why?" goes back
      // through the yes/no/later parser, which does not recognise "he is a team
      // driver" as anything, and the reason the owner just typed is thrown away.
      pending,
    },
    parentNoticeId: rootOf(notice),
    clarifyRound: round + 1,
  })).catch(() => null);

  // A FOLLOW-UP NOBODY RECEIVES IS SILENCE. If the notice could not be recorded
  // — no destination, the channel's category switched off — say it in the thread
  // instead, so the owner is told rather than left waiting for a reply that is
  // not coming. It cannot be answered, but neither can nothing.
  if (!sent?.recorded) await say(deps, reply, message);
  return { handled: true, outcome: 'clarified', clarified: Boolean(sent?.recorded) };
}

/** The question that started this chain — itself, when it is the start. */
function rootOf(notice) {
  return notice.parentNoticeId || notice.id;
}

/** Answer in the thread. Never throws; an ack nobody sees is not a failure. */
async function say(deps, reply, message) {
  if (typeof deps.ack !== 'function') return;
  await Promise.resolve(deps.ack({
    chatId: reply.chatId, inReplyToMessageId: reply.messageId, text: message,
  })).catch(() => {});
}

module.exports = { handleControlReply, defaultDeps };
