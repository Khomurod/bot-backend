'use strict';

/**
 * Reading one Safety decision and posting it.
 *
 * THE ORDER IS THE SAFETY:
 *   1. the feature is on and still pointed at this chat — or nothing is posted;
 *   2. the message is a decision at all: a #Approved / #NotApproved hashtag,
 *      or the words "approved" / "not approved" (lib/safetyApprovals/
 *      trigger.js). Capture only queues those, and an edit that took the words
 *      out is not read. Words with a CONDITION ("if CLH is clean we can
 *      hire") are not a decision: nothing is posted and nothing is asked. An
 *      answer to the bot's OWN post may withdraw it (botPostReply.js);
 *   3. the post is known: the message it replies to, or — for a decision
 *      written on its own — the post the last few messages were about
 *      (services/safetyApprovals/postLocator.js). Not known → Safety is ASKED
 *      in General, once (the owner's choice: a decision is never silently lost).
 *      There is no waiting for Safety's PDFs: they are not posted (the owner's
 *      layout), so a hashtag goes out seconds after it is written;
 *   4. the decision (services/safetyApprovals/decide.js): a hashtag decides
 *      with no model; the words alone are read by a model and verified. Who
 *      it is about cannot be settled → CLAUDE reads the whole conversation
 *      (judge.js); still not settled → Safety is asked — not at once, once,
 *      and the question is taken back if the message turns out clear
 *      (questions.js);
 *   5. a decision already posted for that driver on that post is not posted
 *      again; a changed one is. The right to post is RESERVED before the
 *      send, so a failure after Telegram accepted it cannot post it twice.
 *
 * An AI outage, a Telegram failure or a file that would not download is
 * retried with backoff, and given up (`gave_up`, visible in Settings) after
 * six attempts or a day — a decision a day late is not a decision to post.
 */

const messages = require('../../database/safetyApprovals/messages');
const reviews = require('../../database/safetyApprovals/reviews');
const { assembleSafety } = require('../../lib/safetyApprovals/bundle');
const { readTrigger, isConditional } = require('../../lib/safetyApprovals/trigger');
const { readSafetyReply, AiUnavailableError } = require('./aiReading');
const { resolvePost, locatePost } = require('./postLocator');
const { decide } = require('./decide');
const { answerBotPost } = require('./botPostReply');
const { announceDecisions } = require('./publish');
const { askOnce, takeBackQuestion } = require('./questions');
const { judgeDecision } = require('./judge');

const MAX_ATTEMPTS = 6;
const TEXT_ONLY_AFTER_ATTEMPTS = 3;
const GIVE_UP_AFTER_MS = 24 * 3600 * 1000;
const BACKOFF_SECONDS = Object.freeze([60, 300, 900, 1800, 3600]);
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

function log(text) {
  console.log(`[SAFETY APPROVALS] ${text}`);
}

/** Telegram and download errors are built without URLs; still, keep it short. */
function errorText(err) {
  return String(err?.message || err || 'failed').slice(0, 300);
}

/** The decision message itself: the single message, or every item of the album. */
async function loadTrigger(review) {
  const [kind, id] = String(review.safetyKey || '').split(/:(.+)/);
  if (kind === 'album') return messages.getMediaGroup(review.chatId, id);
  const one = await messages.getMessage(review.chatId, Number(id));
  return one ? [one] : [];
}

/** The post's pictures, in order; one that will not download is left out. */
async function fetchImages(images, download) {
  const fetched = [];
  for (const image of images) {
    if (image.size && image.size > MAX_IMAGE_BYTES) continue;
    try {
      // eslint-disable-next-line no-await-in-loop
      const buffer = await download(image.fileId, { maxBytes: MAX_IMAGE_BYTES });
      fetched.push({ buffer, mimeType: image.mimeType });
    } catch (err) {
      log(`a photo of the post would not download (${errorText(err)})`);
    }
  }
  return fetched;
}

function summarise(result) {
  const reading = result?.reading || null;
  return {
    mode: result?.mode || null,
    candidates: (result?.candidates || reading?.candidates || []).map((c) => ({ name: c.name, cdl: c.cdlPhoto != null })),
    decisions: (result?.decisions || []).map((d) => ({ name: d.name, decision: d.decision })),
    dropped: reading?.dropped || [],
    provider: reading?.provider ?? null,
    model: reading?.model ?? null,
    withoutPhotos: Boolean(reading?.withoutPhotos),
  };
}

async function failOrRetry(review, err, now) {
  const tooOld = now - new Date(review.createdAt).getTime() > GIVE_UP_AFTER_MS;
  if (review.attempts >= MAX_ATTEMPTS || tooOld) {
    await reviews.finishReview(review, { status: 'gave_up', error: errorText(err) });
    log(`review ${review.id} gave up after ${review.attempts} attempt(s): ${errorText(err)}`);
    return 'gave_up';
  }
  const delaySeconds = BACKOFF_SECONDS[Math.min(review.attempts - 1, BACKOFF_SECONDS.length - 1)] || 60;
  await reviews.retryReview(review, { delaySeconds, error: errorText(err) });
  log(`review ${review.id} will be tried again in ${delaySeconds}s: ${errorText(err)}`);
  return 'retry';
}

/** Close the review with nothing posted and nothing asked; a question asked before is taken back. */
async function quiet(review, deps, outcome) {
  await reviews.finishReview(review, { status: 'unclear', outcome });
  await takeBackQuestion(review, deps);
  return 'unclear';
}

/** Where the rules stop and Claude may still settle it (judge.js). */
const JUDGEABLE = Object.freeze(new Set(['which_of_team', 'conflict', 'unclear']));

/**
 * @param {object} review   a claimed row from database/safetyApprovals/reviews.js
 * @param {object} deps     { settings, telegram, download, readReply?, pickPost?, now? }
 * @returns {Promise<string>} what happened: published | unclear | no_post | waiting | retry | gave_up
 */
async function processReview(review, deps) {
  const { settings, download } = deps;
  const readReply = deps.readReply || readSafetyReply;
  const now = deps.now ? deps.now() : Date.now();
  const { chatId } = review;

  if (!settings.enabled || settings.chatId !== chatId || !settings.topicId) {
    await reviews.finishReview(review, { status: 'no_post', outcome: { reason: 'switched_off_or_moved' } });
    return 'no_post';
  }

  try {
    const safetyIds = settings.safetyUserIds;
    const triggerRows = await loadTrigger(review);
    const triggerText = triggerRows.map((r) => r.text).filter(Boolean).join('\n');
    const trigger = readTrigger(triggerText);
    const triggerRow = triggerRows.find((r) => r.text) || triggerRows[0];

    // AN ANSWER TO THE BOT'S OWN POST in the approvals topic. Words: "not yet"
    // withdraws it, anything else is left alone (services/safetyApprovals/
    // botPostReply.js). A hashtag: a decision on the driver's original post.
    const botPost = triggerRows.length && review.postMessageId
      ? await reviews.findAnnouncementByTopicMessage(chatId, review.postMessageId) : null;
    // AWAITED, so a refused edit reaches the retry below rather than escaping it.
    if (botPost && !trigger.hashtag) {
      return await answerBotPost(review, deps, { announcement: botPost, triggerText, triggerRow });
    }

    // Awaited where returned, so a failure reaches the retry below.
    const askLater = (reason, extra = {}) => askOnce(review, deps, {
      triggerRows, triggerRow, reason, extra, now,
    });
    if (!triggerRows.length || (!trigger.hashtag && !trigger.keyword)) {
      return await quiet(review, deps, { reason: 'not_a_decision' });
    }
    if (!trigger.hashtag && trigger.question) {
      // "Is he approved?" asks; it does not decide, and is not answered with a question.
      return await quiet(review, deps, { reason: 'question' });
    }
    if (!trigger.hashtag && isConditional(triggerText)) {
      // "If CLH is clean we can hire" is not a decision yet. Nothing is posted,
      // and — the owner's choice, 27 November 2026 — nothing is asked.
      return await quiet(review, deps, { reason: 'conditional' });
    }

    let post;
    let located = null;
    if (botPost) {
      // The driver's post the bot's post was about; gone (60 days) → nothing to say.
      post = await resolvePost(chatId, botPost.postMessageId, safetyIds);
      if (!post) return await quiet(review, deps, { reason: 'post_not_seen' });
    } else if (review.postMessageId) {
      post = await resolvePost(chatId, review.postMessageId, safetyIds);
      if (!post) return await askLater('post_not_seen');
    } else {
      located = await locatePost({
        chatId, trigger: { messageId: triggerRow.messageId, text: triggerText }, safetyIds,
      }, deps);
      if (located.ask) return await askLater(located.ask);
      post = located.post;
    }

    const safety = assembleSafety([
      ...await messages.listSafetyReplies({ chatId, postMessageIds: post.messageIds, safetyUserIds: safetyIds }),
      ...triggerRows,
    ]);

    let result = await decide({
      post,
      safety,
      trigger,
      triggerText,
      readReply,
      // Downloaded only when a model has to look at the photos.
      loadImages: async () => {
        const images = await fetchImages(post.images, download);
        if (post.images.length && !images.length) throw new Error('none of the post\'s photos would download');
        return images;
      },
      // A vision model silent for three attempts (~20 min): read the words.
      textOnlyFallback: review.attempts >= TEXT_ONLY_AFTER_ATTEMPTS,
    });
    const via = located ? { located: located.via } : {};
    if (result.ask && JUDGEABLE.has(result.ask) && result.candidates?.length) {
      // THE RULES STOPPED: Claude reads the whole conversation (owner, 28
      // November 2026). Not sure, or not reachable → Safety is asked, below.
      const judged = await (deps.judge || judgeDecision)({
        chatId, post, candidates: result.candidates, triggerRows, triggerText, trigger, safetyIds,
      }, deps);
      if (judged) {
        result = {
          mode: 'judge',
          decisions: judged.decisions,
          candidates: judged.candidates,
          reading: { provider: judged.provider, model: judged.model, dropped: judged.dropped },
          rulesAsked: result.ask,
        };
      }
    }
    if (result.ask) return await askLater(result.ask, { ...summarise(result), ...via });
    if (result.unclear) return await quiet(review, deps, { ...summarise(result), reason: result.unclear });

    const { posted, unchanged } = await announceDecisions(review, deps, { post, result, triggerRow });
    await reviews.finishReview(review, {
      status: 'published',
      outcome: {
        ...summarise(result), ...via, posted, unchanged, ...(result.rulesAsked ? { rulesAsked: result.rulesAsked } : {}),
      },
    });
    await takeBackQuestion(review, deps);
    log(`review ${review.id}: posted ${posted.length}, already posted ${unchanged.length} (${result.mode})`);
    return 'published';
  } catch (err) {
    if (!(err instanceof AiUnavailableError)) log(`review ${review.id} failed: ${errorText(err)}`);
    return failOrRetry(review, err, now);
  }
}

module.exports = {
  processReview,
  resolvePost,
  MAX_ATTEMPTS,
  BACKOFF_SECONDS,
};
