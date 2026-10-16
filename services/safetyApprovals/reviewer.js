'use strict';

/**
 * Reading one Safety reply and posting what it decided.
 *
 * THE ORDER IS THE SAFETY:
 *   1. the feature is on and still pointed at this chat — or nothing is posted;
 *   2. the post Safety answered was seen by the bot — or nothing is posted
 *      (a reply to something from before the feature was on has no CDL, no
 *      names to check the model against);
 *   3. Safety has finished answering: a reply that has no words yet, or no
 *      files yet, and is under two minutes old is given time, because Safety
 *      often sends the PDFs and the sentence as two messages;
 *   4. a model reads the words, and lib/safetyApprovals/reading.js keeps only
 *      what the messages prove. Nothing proven → `unclear`, nothing posted;
 *   5. a decision already posted for that driver on that post is not posted
 *      again; a changed one is.
 *
 * An AI outage, a Telegram failure or a file that would not download is
 * retried with backoff, and given up (`gave_up`, visible in Settings) after
 * six attempts or a day — a decision a day late is not a decision to post.
 */

const messages = require('../../database/safetyApprovals/messages');
const reviews = require('../../database/safetyApprovals/reviews');
const { assemblePost, assembleSafety, imagesOf } = require('../../lib/safetyApprovals/bundle');
const { documentsFor } = require('../../lib/safetyApprovals/reading');
const { buildCaption, postLink } = require('../../lib/safetyApprovals/announcement');
const { readSafetyReply, AiUnavailableError } = require('./aiReading');
const { postDecision } = require('./announcer');

const WAIT_FOR_REST_SECONDS = 120;
const NEIGHBOUR_SECONDS = 180;
const CHAIN_HOPS = 3;
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

/**
 * The recruiter's post, from the message Safety replied to. A Safety person
 * replying to Safety's own earlier message is followed back to the post.
 */
async function resolvePost(chatId, messageId, safetyIds) {
  let message = await messages.getMessage(chatId, messageId);
  for (let hop = 0; hop < CHAIN_HOPS && message && safetyIds.includes(message.fromUserId)
    && message.replyToMessageId; hop += 1) {
    // eslint-disable-next-line no-await-in-loop
    message = await messages.getMessage(chatId, message.replyToMessageId);
  }
  if (!message || safetyIds.includes(message.fromUserId)) return null;

  const album = message.mediaGroupId ? await messages.getMediaGroup(chatId, message.mediaGroupId) : [];
  const rows = [message, ...album];
  const complete = rows.some((r) => r.text) && rows.some((r) => imagesOf(r).length);
  const neighbours = complete ? [] : await messages.listSenderMessagesAround({
    chatId, fromUserId: message.fromUserId, at: message.sentAt, seconds: NEIGHBOUR_SECONDS,
  });
  return assemblePost(message, album, neighbours);
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

function summarise(reading) {
  return {
    candidates: reading.candidates.map((c) => ({ name: c.name, cdl: c.cdlPhoto !== null })),
    decisions: reading.decisions.map((d) => ({ name: d.name, decision: d.decision })),
    dropped: reading.dropped,
    provider: reading.provider ?? null,
    model: reading.model ?? null,
    withoutPhotos: Boolean(reading.withoutPhotos),
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

/**
 * @param {object} review   a claimed row from database/safetyApprovals/reviews.js
 * @param {object} deps     { settings, telegram, download, readReply?, now? }
 * @returns {Promise<string>} what happened: published | unclear | no_post | waiting | retry | gave_up
 */
async function processReview(review, deps) {
  const { settings, telegram, download } = deps;
  const readReply = deps.readReply || readSafetyReply;
  const now = deps.now ? deps.now() : Date.now();
  const { chatId } = review;

  if (!settings.enabled || settings.chatId !== chatId || !settings.topicId) {
    await reviews.finishReview(review, { status: 'no_post', outcome: { reason: 'switched_off_or_moved' } });
    return 'no_post';
  }

  try {
    const safetyIds = settings.safetyUserIds;
    const post = await resolvePost(chatId, review.postMessageId, safetyIds);
    if (!post) {
      await reviews.finishReview(review, { status: 'no_post', outcome: { reason: 'post_not_seen' } });
      return 'no_post';
    }

    const safety = assembleSafety(await messages.listSafetyReplies({
      chatId, postMessageIds: post.messageIds, safetyUserIds: safetyIds,
    }));
    const ageSeconds = safety.latestAt ? (now - safety.latestAt.getTime()) / 1000 : Infinity;
    if ((!safety.text || !safety.documents.length) && ageSeconds < WAIT_FOR_REST_SECONDS) {
      const delaySeconds = Math.max(5, Math.ceil(WAIT_FOR_REST_SECONDS - ageSeconds) + 5);
      await reviews.retryReview(review, { delaySeconds, countAttempt: false });
      return 'waiting';
    }
    if (!safety.text) {
      await reviews.finishReview(review, { status: 'unclear', outcome: { reason: 'no_words_from_safety' } });
      return 'unclear';
    }

    const images = await fetchImages(post.images, download);
    if (post.images.length && !images.length) throw new Error('none of the post\'s photos would download');

    const reading = await readReply({
      postText: post.text,
      safetyText: safety.text,
      fileNames: safety.fileNames,
      images,
      // A vision model silent for three attempts (~20 min): read the words.
      textOnlyFallback: review.attempts >= TEXT_ONLY_AFTER_ATTEMPTS,
    });
    if (!reading.decisions.length) {
      await reviews.finishReview(review, { status: 'unclear', outcome: summarise(reading) });
      return 'unclear';
    }

    const posted = [];
    const unchanged = [];
    for (const decision of reading.decisions) {
      // eslint-disable-next-line no-await-in-loop
      const last = await reviews.lastAnnouncement(chatId, post.anchorId, decision.key);
      if (last && last.decision === decision.decision) {
        unchanged.push(decision.name);
        continue;
      }
      const caption = buildCaption({
        decision: decision.decision,
        name: decision.name,
        phone: decision.phone,
        safetyNote: safety.text,
        recruiterName: post.recruiterName,
        safetyName: safety.safetyName,
        link: postLink(chatId, post.anchorId),
      });
      // eslint-disable-next-line no-await-in-loop
      const topicMessageIds = await postDecision(telegram, {
        chatId,
        topicId: settings.topicId,
        caption,
        name: decision.name,
        cdl: decision.cdlPhoto === null ? null : images[decision.cdlPhoto],
        documents: documentsFor(decision, reading.candidates, safety.documents),
      });
      // eslint-disable-next-line no-await-in-loop
      await reviews.recordAnnouncement({
        chatId,
        postMessageId: post.anchorId,
        driverKey: decision.key,
        driverName: decision.name,
        decision: decision.decision,
        reviewId: review.id,
        topicMessageIds,
      });
      posted.push(decision.name);
    }

    await reviews.finishReview(review, {
      status: 'published',
      outcome: { ...summarise(reading), posted, unchanged },
    });
    log(`review ${review.id}: posted ${posted.length}, already posted ${unchanged.length}`);
    return 'published';
  } catch (err) {
    if (!(err instanceof AiUnavailableError)) log(`review ${review.id} failed: ${errorText(err)}`);
    return failOrRetry(review, err, now);
  }
}

module.exports = {
  processReview,
  resolvePost,
  WAIT_FOR_REST_SECONDS,
  MAX_ATTEMPTS,
  BACKOFF_SECONDS,
};
