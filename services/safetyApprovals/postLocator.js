'use strict';

/**
 * Which recruiter's post a Safety decision is about.
 *
 * A REPLY says so itself: the replied message, followed back to the start of
 * its reply chain, is the post (resolvePost).
 *
 * A DECISION WRITTEN ON ITS OWN in General — "approved", "#NotApproved" with
 * no reply — is located from the last few messages before it (locatePost):
 * each of them, followed back by replies, belongs to some post, and those
 * posts are the candidates. One candidate is the answer. Several are put to a
 * model, which may only pick one by label (services/safetyApprovals/
 * aiContext.js). None, or a model that cannot tell, means Safety is asked —
 * the owner's choice, so a decision is never silently lost and never guessed.
 */

const messages = require('../../database/safetyApprovals/messages');
const { assemblePost, isIncomplete, originKey } = require('../../lib/safetyApprovals/bundle');
const { phonesIn } = require('../../lib/safetyApprovals/reading');
const { namesInPost } = require('../../lib/safetyApprovals/postDetails');
const { resolveRoot } = require('../hiringStages/conversationQueue');
const { pickPost } = require('./aiContext');

const NEIGHBOUR_SECONDS = 180;
const CHAIN_HOPS = 15;
const RECENT_MESSAGES = 6;
const MAX_CANDIDATES = 4;

/**
 * The recruiter's post, from the message Safety replied to: the start of the
 * reply chain, whoever wrote each step. Safety answering a recruiter's "could
 * we schedule his drug test?" — itself a reply to the post — is about the
 * post, not about that question. A chain that runs into a message the bot
 * never saw stops at the last one it has.
 */
async function resolvePost(chatId, messageId, safetyIds) {
  let message = await messages.getMessage(chatId, messageId);
  for (let hop = 0; hop < CHAIN_HOPS && message?.replyToMessageId; hop += 1) {
    // eslint-disable-next-line no-await-in-loop
    const earlier = await messages.getMessage(chatId, message.replyToMessageId);
    if (!earlier) break;
    message = earlier;
  }
  // Safety's own words are not a post — but a post Safety FORWARDED is the recruiter's.
  if (!message || (safetyIds.includes(message.fromUserId) && !originKey(message))) return null;

  const album = message.mediaGroupId ? await messages.getMediaGroup(chatId, message.mediaGroupId) : [];
  const { incomplete } = isIncomplete([message, ...album]);
  const neighbours = !incomplete ? [] : await messages.listSenderMessagesAround({
    chatId, fromUserId: message.fromUserId, at: message.sentAt, seconds: NEIGHBOUR_SECONDS,
  });
  return assemblePost(message, album, neighbours);
}

/** A driver post: a picture, a phone number or a name in it. "Office is closed" is not one. */
function isDriverPost(post) {
  return post.images.length > 0 || phonesIn(post.text).size > 0 || namesInPost(post.text).length > 0;
}

/** The post a recent message belongs to, or null. */
async function postOf(chatId, message, safetyIds) {
  const rootId = message.replyToMessageId
    ? await resolveRoot(chatId, message.replyToMessageId)
    : message.messageId;
  if (!rootId) return null;
  const post = await resolvePost(chatId, rootId, safetyIds);
  return post && isDriverPost(post) ? post : null;
}

/**
 * @param {{chatId: string, messageId: number, text: string}} trigger  Safety's message
 * @returns {Promise<{post: object, via: string} | {ask: string}>}
 * @throws {AiUnavailableError} when a model was needed and none answered
 */
async function locatePost({ chatId, trigger, safetyIds }, deps = {}) {
  const recent = await messages.listRecentGeneral({
    chatId, beforeMessageId: trigger.messageId, limit: RECENT_MESSAGES,
  });
  const posts = [];
  const lines = [];
  for (const m of recent) {
    // eslint-disable-next-line no-await-in-loop
    const post = await postOf(chatId, m, safetyIds);
    let index = null;
    if (post) {
      index = posts.findIndex((p) => p.anchorId === post.anchorId);
      if (index === -1 && posts.length < MAX_CANDIDATES) {
        posts.push(post);
        index = posts.length - 1;
      }
      if (index === -1) index = null;
    }
    lines.push({
      role: safetyIds.includes(m.fromUserId) ? 'Safety' : 'Recruiter',
      fromName: m.fromName,
      text: m.text,
      postIndex: index,
    });
  }

  if (!posts.length) return { ask: 'which_driver' };
  if (posts.length === 1) return { post: posts[0], via: 'only_post_nearby' };

  const index = await (deps.pickPost || pickPost)({
    recent: lines.reverse(), posts, safetyText: trigger.text,
  });
  if (index === null) return { ask: 'which_driver' };
  return { post: posts[index], via: 'model_picked' };
}

module.exports = { resolvePost, locatePost, isDriverPost, RECENT_MESSAGES };
