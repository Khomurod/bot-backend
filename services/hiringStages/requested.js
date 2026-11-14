'use strict';

/**
 * A read a PERSON ASKED FOR — a reply to the lead's post that mentions the
 * bot (queued by requestQueue.js; owner, 13–14 November 2026). The bot had
 * been missing leads: a deal was created only after a model verified a stage
 * move, a post nobody had answered was never read, and a post sent while the
 * bot was down was never captured (requestQueue.js rebuilds that one).
 *
 * EVERY GUARD OF THE NORMAL READ STAYS. Only these change:
 *
 *   a) a post nobody has answered yet is read (the tag is not an answer: it
 *      carries no data and was left out by the reviewer);
 *   b) the post is assembled the way Safety Approvals assembles it — its
 *      album and, when that has no words or no picture, the same sender's
 *      messages around it (services/safetyApprovals/postLocator.js
 *      `resolvePost`) — so a name sent right after the album counts;
 *   c) CREATION DOES NOT WAIT FOR A VERIFIED MOVE: a creation left in flight
 *      is finished first; then the deal is looked for by phone, then by name;
 *      none → noDeal.js (the conversation's own deal, closed, rejected, not
 *      certain, or CREATE at "Sent to Safety" with the display name). Then
 *      the normal stage read (stageRead.js) of the conversation AFTER the
 *      post proposes the next stage with a Move button, exactly as always — a
 *      person still presses it (no answer yet: no model is asked);
 *   d) the tag overrides a recruiter's earlier Skip (owner decision 4).
 *
 * THE ANSWER: everything goes on the driver's ONE card in the Bitrix topic —
 * who asked, created, already in Bitrix, why it could not create, the
 * proposal — each line once (card.js notices). In General only a reaction on
 * the tagging message (`answerRequest`): 👍 when the candidate has a deal or a
 * Move was proposed, 🤷 when it needs a person (lib/hiringStages/botRequest.js).
 *
 * A creation here is recorded in Monitoring → Logs as the person who asked
 * (`person_reply`, crmCreate.js `createAudit`).
 */

const crypto = require('node:crypto');
const proposals = require('../../database/hiringStages/proposals');
const records = require('../../database/hiringStages/crmRecords');
const conversation = require('../../lib/hiringStages/conversation');
const { candidateIdentity } = require('../../lib/hiringStages/identity');
const { requestReaction } = require('../../lib/hiringStages/botRequest');
const { namesInPost } = require('../../lib/safetyApprovals/postDetails');
const msg = require('../../lib/hiringStages/messages');
const bitrix = require('../bitrix24DealStages');
const { resolvePost } = require('../safetyApprovals/postLocator');
const { reactQuietly } = require('../telegram/reaction');
const { findCandidateDeal } = require('./dealFinder');
const { resumeInFlight } = require('./crmCreate');
const { whenNoDeal, sayCreated, notice } = require('./noDeal');
const { stagesFor, newDealCategory, stageNameOf } = require('./stagePlan');
const { done } = require('./propose');
const { readStage, rereadAfterCreate, DEAL_EXISTS } = require('./stageRead');

/** Who asked — the first person to tag — and the newest tagging message; null for a normal read. */
function requesterOf(thread) {
  if (!thread?.requestedAt) return null;
  return {
    userId: thread.requestedByUserId ?? null,
    name: thread.requestedByName || null,
    requestMessageId: thread.requestMessageId ?? null,
  };
}

/** "Requested by Ann" — once; once more if it overrides a Skip pressed since. */
async function sayRequested(thread, deps, driverName, requestedBy) {
  const asked = await proposals.listForRoot(thread.chatId, thread.rootMessageId);
  const overridesSkip = asked.some((p) => p.kind === 'create_deal' && p.status === 'declined');
  await notice(thread, deps, overridesSkip ? 'requested_over_skip' : 'requested', msg.requestedLine({
    name: requestedBy?.name, overridesSkip,
  }), driverName);
}

/** "Already in Bitrix" — once per deal, and never for the deal this conversation's own creation made. */
async function sayInBitrix(thread, deps, deal, driverName, opts) {
  const own = await records.getForRoot(thread.chatId, thread.rootMessageId);
  if (own?.status === 'created' && Number(own.dealId) === Number(deal.id)) return;
  await notice(thread, deps, `in_bitrix:${deal.id}`, msg.inBitrixLine({
    dealId: deal.id, dealTitle: deal.title, dealUrl: await bitrix.dealUrl(deal.id), stageName: await stageNameOf(deal, opts),
  }), driverName);
}

/**
 * The normal stage read of the conversation AFTER the post — with its own
 * guard: with nobody's answer yet there is nothing to read a stage from, and
 * no model is asked. The deal found or created stands either way.
 */
async function readAfterPost(thread, deps, seen, view, lookup) {
  if (!conversation.hasReplies(view.messages, thread.rootMessageId)) {
    return done(thread, { result: 'no_conversation', ...(lookup.deal ? { dealId: lookup.deal.id } : {}) });
  }
  return readStage(thread, deps, seen, view, lookup);
}

/** A reason names a phone or a name: its notice key is a hash of it, never the words. */
const reasonKey = (note) => crypto.createHash('sha256').update(String(note || '')).digest('hex').slice(0, 16);

/**
 * @param {object} thread  the queue row (requested)
 * @param {object} deps    settings, telegram, readStage
 * @param {object} seen    driverName, hasDeal — for the caller
 * @param {object} base    the conversation without requests to the bot (reviewer.js)
 * @returns {Promise<'done'|'retry'>}
 */
async function readRequested(thread, deps, seen, base) {
  const { settings } = deps;
  const { messages, opts, requestedBy } = base;
  const who = { rootMessageId: thread.rootMessageId, safetyUserIds: settings.safetyUserIds };
  const root = conversation.postMessages(messages, thread.rootMessageId)[0];
  const post = root ? await resolvePost(thread.chatId, thread.rootMessageId, settings.safetyUserIds) : null;
  if (!post) return done(thread, { result: 'no_post' });

  const phones = conversation.candidatePhones(messages, { ...who, post: post.text });
  const safetyTexts = conversation.safetyTexts(messages, who);
  const identity = candidateIdentity({ postText: post.text, phones, safetyTexts });
  const names = namesInPost(post.text);
  seen.driverName = identity.name || (names.length === 1 ? names[0] : null);
  await sayRequested(thread, deps, seen.driverName, requestedBy);
  if (!conversation.isCandidatePost(post)) {
    await notice(thread, deps, 'not_candidate', msg.notCandidateLine(), seen.driverName);
    return done(thread, { result: 'not_a_candidate_post' });
  }

  const categoryId = await newDealCategory();
  const loadStages = () => stagesFor(categoryId, opts);
  const view = {
    ...base, newDealCategory: categoryId, postText: post.text, phones, recruiter: root,
  };
  // A creation an earlier read left without an answer is finished first.
  const resumed = await resumeInFlight({
    chatId: thread.chatId, rootMessageId: thread.rootMessageId, categoryId, loadStages, requestedBy,
  }, opts);
  if (resumed) await sayCreated(thread, deps, resumed, resumed.stages);
  if (resumed?.status === 'created') {
    seen.hasDeal = true;
    return rereadAfterCreate(thread);
  }

  // By phone, then by name.
  const lookup = resumed?.deal ? { status: 'found', deal: resumed.deal }
    : await findCandidateDeal({ phones, name: seen.driverName }, opts);
  if (lookup.status === 'ambiguous') {
    await notice(thread, deps, 'ambiguous', msg.ambiguousLine({ count: lookup.count }), seen.driverName);
    return done(thread, { result: 'ambiguous', people: lookup.count });
  }
  if (lookup.deal) {
    await sayInBitrix(thread, deps, lookup.deal, seen.driverName, opts);
    seen.hasDeal = true;
    return readAfterPost(thread, deps, seen, view, lookup);
  }

  // No open deal: the same rules as a normal read — without waiting for a stage.
  const stages = await loadStages();
  if (!stages.length) return done(thread, { result: 'no_stages', categoryId });
  const ctx = { driverName: seen.driverName, note: null };
  const missing = await whenNoDeal(thread, ctx, {
    identity, categoryId, stages, rejected: base.rejectedBySafety, requestedBy,
  }, deps, opts);
  if (missing.outcome) {
    if (DEAL_EXISTS.has(missing.outcome.result)) seen.hasDeal = true;
    return done(thread, missing.outcome);
  }
  if (missing.created) {
    seen.hasDeal = true;
    return rereadAfterCreate(thread);
  }
  if (missing.deal) {
    await sayInBitrix(thread, deps, missing.deal, seen.driverName, opts);
    seen.hasDeal = true;
    return readAfterPost(thread, deps, seen, view, { status: 'found', deal: missing.deal });
  }
  // Not certain, or blocked in Bitrix: why, on the card. The stage read may
  // still ask the recruiter (with the same reason) — it never tries again.
  await notice(thread, deps, `not_created:${reasonKey(ctx.note)}`, msg.notCreatedLine({ note: ctx.note }), seen.driverName);
  return readAfterPost(thread, deps, seen, { ...view, noCreate: ctx.note }, { status: 'none' });
}

/**
 * The reaction on the newest tagging message once a requested read is over:
 * 👍 a deal, 🤷 a person is needed, nothing yet while it will be read again.
 * Never throws.
 */
async function answerRequest(thread, deps, seen, status) {
  if (!thread?.requestedAt || !thread.requestMessageId) return false;
  const emoji = requestReaction({ hasDeal: Boolean(seen?.hasDeal), status });
  if (!emoji) return false;
  return reactQuietly(deps.telegram, thread.chatId, thread.requestMessageId, emoji, 'HIRING STAGES');
}

module.exports = { readRequested, answerRequest, requesterOf };
