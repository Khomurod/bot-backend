'use strict';

/**
 * Reading one candidate's conversation and, when it has moved on, proposing
 * the Bitrix stage — the work behind one queue row.
 *
 *   conversation (General, without any message that mentions the bot)
 *     → a person ASKED for it with a tag? → requested.js (the post read as it
 *       is NOW, the deal created without waiting for a stage) → stage read
 *     → otherwise: answered? candidate post? → a creation left in flight →
 *       deal by phone → the stage read (stageRead.js): model → verified stage
 *       → deal by name → no deal? own / closed / rejected / CREATE → propose
 *
 * ONLY A CANDIDATE POST IS READ (lib/hiringStages/conversation.js
 * `isCandidatePost`): a picture (the CDL) or a phone number. A post with
 * neither costs no model call.
 *
 * A MESSAGE THAT MENTIONS THE BOT IS A REQUEST, NEVER DATA (owner, 13–14
 * November 2026): it is left out of everything read here — the transcript,
 * the evidence, the phones, the names. The one exception is Safety's
 * #NotApproved: a hashtag in such a message still stops a creation, because
 * a refusal can only make the bot do LESS.
 *
 * A MISSING DEAL IS CREATED ONLY FOR A CERTAIN CANDIDATE (noDeal.js,
 * crmCreate.js). Anything less certain asks a person instead, with the reason.
 *
 * Returns the queue status it left the row in; never throws for a failure it
 * can name (AI or Bitrix down → retry; after six attempts → gave_up). A Bitrix
 * failure that ends the read is said in the Bitrix topic, once. A read a
 * person asked for is answered with a reaction on their tag (requested.js).
 */

const threads = require('../../database/hiringStages/threads');
const conversation = require('../../lib/hiringStages/conversation');
const { namesInPost } = require('../../lib/safetyApprovals/postDetails');
const msg = require('../../lib/hiringStages/messages');
const { stripUrls } = require('../../lib/security/redactUrls');
const { BitrixError } = require('../bitrix24DealStages');
const { findCandidateDeal } = require('./dealFinder');
const { resumeInFlight } = require('./crmCreate');
const { sayCreated, notice, RetryLater } = require('./noDeal');
const { stagesFor, newDealCategory } = require('./stagePlan');
const { AiUnavailableError } = require('./aiReading');
const { done } = require('./propose');
const { readStage, rereadAfterCreate } = require('./stageRead');
const { readRequested, answerRequest, requesterOf } = require('./requested');

const RETRY_DELAYS_SECONDS = [60, 300, 900, 1800, 3600];
/** 1 + 5 + 15 + 30 + 60 minutes of trying; a new message in the conversation starts over. */
const MAX_ATTEMPTS = 6;

/**
 * The conversation as both reads see it: every message but the requests to
 * the bot, and whether Safety's #NotApproved stands.
 */
async function readConversation(thread, deps) {
  const all = await threads.listThreadMessages(thread.chatId, thread.rootMessageId);
  const who = { rootMessageId: thread.rootMessageId, safetyUserIds: deps.settings.safetyUserIds };
  return {
    messages: all.filter((m) => !m.botRequest),
    rejectedBySafety: conversation.safetyRejected(all, who),
    opts: { fetchImpl: deps.fetchImpl },
    requestedBy: requesterOf(thread),
  };
}

async function readAndPropose(thread, deps, seen) {
  const { settings } = deps;
  const base = await readConversation(thread, deps);
  if (thread.requestedAt) return readRequested(thread, deps, seen, base);

  const { messages, opts } = base;
  const post = conversation.postMessages(messages, thread.rootMessageId);
  if (!post.length) return done(thread, { result: 'no_post' });
  if (!conversation.hasReplies(messages, thread.rootMessageId)) return done(thread, { result: 'no_conversation' });
  if (!conversation.isCandidatePost(post)) return done(thread, { result: 'not_a_candidate_post' });
  base.newDealCategory = await newDealCategory();
  const categoryId = base.newDealCategory;

  const postText = conversation.postText(messages, thread.rootMessageId);
  const postNames = namesInPost(postText);
  seen.driverName = postNames.length === 1 ? postNames[0] : null;
  const phones = conversation.candidatePhones(messages, { rootMessageId: thread.rootMessageId, safetyUserIds: settings.safetyUserIds });

  // A creation an earlier read left without an answer is finished first.
  const resumed = await resumeInFlight({
    chatId: thread.chatId,
    rootMessageId: thread.rootMessageId,
    categoryId,
    loadStages: () => stagesFor(categoryId, opts),
  }, opts);
  if (resumed) await sayCreated(thread, deps, resumed, resumed.stages);
  if (resumed?.status === 'created') return rereadAfterCreate(thread);
  let lookup;
  if (resumed?.deal) lookup = { status: 'found', deal: resumed.deal };
  else lookup = phones.length ? await findCandidateDeal({ phones }, opts) : { status: 'none' };

  return readStage(thread, deps, seen, {
    ...base, postText, phones, recruiter: post[0],
  }, lookup);
}

function retryable(err) {
  if (err instanceof AiUnavailableError || err instanceof RetryLater) return true;
  if (err instanceof BitrixError) return err.retryable;
  return true;
}

/** A Bitrix failure that ends this read is said in the Bitrix topic — once per revision. */
async function sayBitrixFailed(thread, deps, err, seen) {
  if (!(err instanceof BitrixError)) return;
  await notice(thread, deps, `bitrix_error:${thread.revision}`, msg.bitrixErrorLine({ error: stripUrls(err.message) }), seen.driverName);
}

/** A read that failed: said once when it ends the read, else retried on the schedule. */
async function failed(thread, deps, err, seen) {
  const error = String(err?.message || err).slice(0, 300);
  if (!retryable(err)) {
    await threads.finishThread(thread, { status: 'done', outcome: { result: 'bitrix_error' }, error });
    await sayBitrixFailed(thread, deps, err, seen);
    return 'done';
  }
  if (thread.attempts >= MAX_ATTEMPTS) {
    await threads.finishThread(thread, { status: 'gave_up', error });
    await sayBitrixFailed(thread, deps, err, seen);
    return 'gave_up';
  }
  const delay = RETRY_DELAYS_SECONDS[Math.min(thread.attempts - 1, RETRY_DELAYS_SECONDS.length - 1)];
  await threads.retryThread(thread, { delaySeconds: delay, error });
  return 'retry';
}

/** @returns {Promise<'done'|'retry'|'gave_up'>} */
async function processThread(thread, deps) {
  const seen = { driverName: null, hasDeal: false };
  let status;
  try {
    status = await readAndPropose(thread, deps, seen);
  } catch (err) {
    status = await failed(thread, deps, err, seen);
  }
  // A person who asked with a tag gets their answer as a reaction (never throws).
  await answerRequest(thread, deps, seen, status);
  return status;
}

module.exports = { processThread, MAX_ATTEMPTS, RETRY_DELAYS_SECONDS };
