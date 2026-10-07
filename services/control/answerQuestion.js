'use strict';

/**
 * Answering one question, once the reply has been claimed. Gates 6 to 8.
 *
 * TWO WAYS IN, ONE WAY THROUGH. A typed reply (`replyHandler.js`) and a tap on
 * a Yes / No / Later button (`buttonHandler.js`) each do their own gating —
 * shape, switch, is-it-ours, who, redelivery — and then hand the claimed reply
 * here. Everything that decides what an answer MEANS and what it DOES lives in
 * this one function, so a button can never take a path a typed word would not.
 * A button arrives as the word it stands for (`lib/control/buttons.js`).
 *
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
 * The acknowledgement goes back as a REPLY to the message being answered, so a
 * busy group shows the answer under the question rather than at the bottom.
 */
const { shouldRemember } = require('./memory');
const { replyHintFor } = require('../../lib/control/askable');

/**
 * @param {object} args
 * @param {object} args.reply     { chatId, messageId, telegramUserId } — the
 *   message an acknowledgement is threaded under
 * @param {object} args.notice    the question being answered
 * @param {object} args.claim     the `control_replies` row already claimed
 * @param {object} args.settings  `control_settings`
 * @param {string} args.text      what was said (a button arrives as its word)
 * @returns {Promise<{handled:true, outcome:string, message?:string}>}
 *   throws only what its dependencies throw; both callers catch.
 */
async function answerQuestion({
  reply, notice, claim, settings, text,
}, deps) {
  // ── 6. still open ───────────────────────────────────────────────────────
  const finding = notice.findingId
    ? await deps.findings.getFindingById(notice.findingId)
    : null;
  if (!finding) {
    await deps.replies.finaliseReply(claim.id, { outcome: 'no_op' });
    const gone = 'That one is gone from my list.';
    await say(deps, reply, gone);
    return { handled: true, outcome: 'no_op', message: gone };
  }
  if (finding.status !== 'open') {
    await deps.replies.finaliseReply(claim.id, { outcome: 'no_op' });
    const already = `Already ${finding.status}. Nothing to do.`;
    await say(deps, reply, already);
    return { handled: true, outcome: 'no_op', message: already };
  }

  // ── 7. what it means ────────────────────────────────────────────────────
  const offered = notice.question.offeredActions || [];
  let intent = deps.parseIntent(text, { offered });

  // THE MODEL IS THE SECOND READER, NEVER THE FIRST. Every reply the fixed
  // rules understand — which is nearly all of them — is decided with no model
  // involved. `remember` is carried across because "don't ask me again" is
  // read by the deterministic rules even when the rest of the sentence is not.
  if (intent.intent === 'unclear') {
    const fromAi = await deps.readReplyWithAi(text, { offered, question: promptOf(notice) });
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
      requestedBy: `telegram:${reply.telegramUserId}`,
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
    const noted = filed?.request
      ? `Noted as request #${filed.request.id} for a person to build. Nothing in the system changed.`
      : 'I could not write that down — please tell somebody directly. Nothing in the system changed.';
    await say(deps, reply, noted);
    return {
      handled: true,
      outcome: filed?.request ? 'engineering_request' : 'failed',
      requestId: filed?.request?.id ?? null,
      message: noted,
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
    // ASK THE QUESTION AGAIN, NOT "YES OR NO". Production, 2026-10-07: the
    // owner replied "I don't know which driver" and was told to reply yes or
    // no — the same question, minus the part they said was missing. The
    // re-ask names who it is about and lists the answers it will take.
    const prompt = promptOf(notice);
    const restated = notice.question?.prompt?.ask ? prompt.ask : null;
    return askAgain(deps, { reply, notice, settings, offered }, {
      message: restated
        ? `Sorry, I did not follow. ${restated}`
        : 'I did not follow that. Reply yes, no (and why), or later.',
      exhausted: 'I still did not follow that, so I am leaving it open for you. It stays on Needs Attention.',
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
    question: notice.question, finding, intent, telegramUserId: reply.telegramUserId,
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
      finding, intent, telegramUserId: reply.telegramUserId, replyId: claim.id,
    }).catch(() => null));
  }

  const said = remembered && result.outcome === 'dismissed'
    ? 'Closed, and noted — I will not ask again while nothing changes.'
    : result.message;
  await say(deps, reply, said);
  return {
    handled: true, outcome: result.outcome, remembered, message: said,
  };
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
    return {
      handled: true, outcome: 'clarified', clarified: false, message: exhausted || null,
    };
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
      // THE QUESTION AS ASKED, carried down the chain so a reply to the
      // follow-up is read against the same question the first one was.
      prompt: notice.question?.prompt || null,
    },
    parentNoticeId: rootOf(notice),
    clarifyRound: round + 1,
  })).catch(() => null);

  // A FOLLOW-UP NOBODY RECEIVES IS SILENCE. If the notice could not be recorded
  // — no destination, the channel's category switched off — say it in the thread
  // instead, so the owner is told rather than left waiting for a reply that is
  // not coming. It cannot be answered, but neither can nothing.
  if (!sent?.recorded) await say(deps, reply, message);
  return {
    handled: true, outcome: 'clarified', clarified: Boolean(sent?.recorded), message,
  };
}

/**
 * The question as the owner saw it: `{ask, lines}`. Stored on every question
 * asked since 2026-10-07; an older notice falls back to its own text, tags
 * stripped, which is the same words with less structure.
 */
function promptOf(notice) {
  const p = notice?.question?.prompt;
  if (p && p.ask) {
    return { ask: String(p.ask), lines: Array.isArray(p.lines) ? p.lines.map(String) : [] };
  }
  const body = String(notice?.body || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return body ? { ask: body.slice(0, 600), lines: [] } : null;
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


module.exports = {
  answerQuestion, askAgain, rootOf, say, promptOf,
};
