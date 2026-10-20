'use strict';

/**
 * Reading one Safety decision and posting it.
 *
 * THE ORDER IS THE SAFETY:
 *   1. the feature is on and still pointed at this chat — or nothing is posted;
 *   2. the message is a decision at all: a #Approved / #NotApproved hashtag,
 *      or the words "approved" / "not approved" (lib/safetyApprovals/
 *      trigger.js). Capture only queues those, and an edit that took the words
 *      out is not read;
 *   3. the post is known: the message it replies to, or — for a decision
 *      written on its own — the post the last few messages were about
 *      (services/safetyApprovals/postLocator.js). Not known → Safety is ASKED
 *      in General, once (the owner's choice: a decision is never silently lost).
 *      There is no waiting for Safety's PDFs: they are not posted (the owner's
 *      layout), so a hashtag goes out seconds after it is written;
 *   4. the decision (services/safetyApprovals/decide.js): a hashtag decides
 *      with no model; the words alone are read by a model and verified. Who
 *      it is about cannot be settled → Safety is asked;
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
const { readTrigger } = require('../../lib/safetyApprovals/trigger');
const { personName } = require('../../lib/safetyApprovals/postDetails');
const { buildCaption, postLink } = require('../../lib/safetyApprovals/announcement');
const { readSafetyReply, AiUnavailableError } = require('./aiReading');
const { resolvePost, locatePost } = require('./postLocator');
const { decide } = require('./decide');
const { postDecision, askSafety } = require('./announcer');

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

/** Safety is asked in General, and the review closes as unclear: it never decides on its own. */
async function ask(review, deps, triggerRow, reason, extra = {}) {
  const asked = await askSafety(deps.telegram, {
    chatId: review.chatId, threadId: triggerRow.threadId, replyTo: triggerRow.messageId, reason,
  });
  await reviews.finishReview(review, { status: 'unclear', outcome: { ...extra, reason, asked } });
  return 'unclear';
}

/** Post every decision not posted yet. @returns names posted and names already there */
async function announce(review, deps, { post, result, triggerRow }) {
  const { chatId } = review;
  const posted = [];
  const unchanged = [];
  const link = postLink(chatId, post.anchorId);
  for (const decision of result.decisions) {
    // eslint-disable-next-line no-await-in-loop
    const reservation = await reviews.reserveAnnouncement({
      chatId,
      postMessageId: post.anchorId,
      driverKey: decision.key,
      driverName: decision.name,
      decision: decision.decision,
      reviewId: review.id,
    });
    if (!reservation) {
      unchanged.push(decision.name);
      continue;
    }
    const caption = buildCaption({
      decision: decision.decision,
      postText: post.text,
      name: decision.name,
      nameInStatus: result.candidates.length > 1,
      nameFromCdl: decision.nameFromCdl,
      decidedBy: personName(triggerRow.fromName),
      reason: decision.reason,
      recruiterName: personName(post.recruiterName),
      link,
    });
    let topicMessageIds;
    try {
      // eslint-disable-next-line no-await-in-loop
      topicMessageIds = await postDecision(deps.telegram, {
        chatId, topicId: deps.settings.topicId, caption, images: post.images,
      });
    } catch (err) {
      // Not posted: the retry may post it.
      // eslint-disable-next-line no-await-in-loop
      await reviews.releaseAnnouncement(reservation.id).catch(() => {});
      throw err;
    }
    // Posted. Failing to note where must not make a retry post it again —
    // the reservation already says it went out.
    // eslint-disable-next-line no-await-in-loop
    await reviews.completeAnnouncement(reservation.id, topicMessageIds)
      .catch((err) => log(`review ${review.id}: posted, but not recorded where (${errorText(err)})`));
    posted.push(decision.name);
  }
  return { posted, unchanged };
}

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
    if (!triggerRows.length || (!trigger.hashtag && !trigger.keyword)) {
      await reviews.finishReview(review, { status: 'unclear', outcome: { reason: 'not_a_decision' } });
      return 'unclear';
    }
    if (!trigger.hashtag && trigger.question) {
      // "Is he approved?" asks; it does not decide, and is not answered with a question.
      await reviews.finishReview(review, { status: 'unclear', outcome: { reason: 'question' } });
      return 'unclear';
    }
    const triggerRow = triggerRows.find((r) => r.text) || triggerRows[0];

    let post;
    let located = null;
    if (review.postMessageId) {
      post = await resolvePost(chatId, review.postMessageId, safetyIds);
      if (!post) return ask(review, deps, triggerRow, 'post_not_seen');
    } else {
      located = await locatePost({
        chatId, trigger: { messageId: triggerRow.messageId, text: triggerText }, safetyIds,
      }, deps);
      if (located.ask) return ask(review, deps, triggerRow, located.ask);
      post = located.post;
    }

    const safety = assembleSafety([
      ...await messages.listSafetyReplies({ chatId, postMessageIds: post.messageIds, safetyUserIds: safetyIds }),
      ...triggerRows,
    ]);

    const result = await decide({
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
    if (result.ask) return ask(review, deps, triggerRow, result.ask, { ...summarise(result), ...via });
    if (result.unclear) {
      await reviews.finishReview(review, { status: 'unclear', outcome: { ...summarise(result), reason: result.unclear } });
      return 'unclear';
    }

    const { posted, unchanged } = await announce(review, deps, { post, result, triggerRow });
    await reviews.finishReview(review, {
      status: 'published',
      outcome: { ...summarise(result), ...via, posted, unchanged },
    });
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
