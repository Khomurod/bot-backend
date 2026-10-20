'use strict';

/**
 * From a post and Safety's answer to the decision(s) to post.
 *
 *   #Approved / #NotApproved  → THE HASHTAG DECIDES (lib/safetyApprovals/
 *     hashtagDecision.js). The drivers are read off the post without a model
 *     (lib/safetyApprovals/postDetails.js); only a post with no readable name
 *     asks the model — and then only for the names, never the decision.
 *   the words alone ("approved", "not approved") → the model reads Safety's
 *     words, as before, and lib/safetyApprovals/reading.js keeps only what the
 *     messages prove.
 *
 * Anything that cannot be settled returns `ask` (Safety is asked in General)
 * or, for a question Safety asked ("is he approved?"), `unclear` — a question
 * is not a decision and is not answered with one.
 */

const { namesInPost } = require('../../lib/safetyApprovals/postDetails');
const { driverKey, phonesIn } = require('../../lib/safetyApprovals/reading');
const { decideByHashtag, reasonFor } = require('../../lib/safetyApprovals/hashtagDecision');

/** The post's drivers, read without a model; [] when no line reads as a name. */
function driversFromPost(postText) {
  const names = namesInPost(postText);
  const phones = [...phonesIn(postText).values()];
  return names.map((name, i) => ({
    key: driverKey(name),
    name,
    phone: names.length === 1 ? (phones[0] || null) : (phones.length === names.length ? phones[i] : null),
    cdlPhoto: null,
  }));
}

/**
 * @param {object} args
 * @param {object} args.post        lib/safetyApprovals/bundle.js assemblePost
 * @param {object} args.safety      lib/safetyApprovals/bundle.js assembleSafety
 * @param {object} args.trigger     lib/safetyApprovals/trigger.js readTrigger, of the decision message
 * @param {string} args.triggerText the decision message's words
 * @param {Function} args.loadImages  the post's pictures, fetched — called only if a model is asked
 * @param {Function} args.readReply services/safetyApprovals/aiReading.js readSafetyReply
 * @returns {Promise<{mode: string, decisions: object[], candidates: object[], reading: object|null}
 *   | {ask: string, reading?: object} | {unclear: string, reading?: object}>}
 */
async function decide({
  post, safety, trigger, triggerText, loadImages, readReply, textOnlyFallback = false,
}) {
  const read = async () => readReply({
    postText: post.text, safetyText: safety.text, fileNames: safety.fileNames, images: await loadImages(), textOnlyFallback,
  });

  if (trigger.hashtag) {
    let candidates = driversFromPost(post.text);
    let reading = null;
    if (!candidates.length) {
      reading = await read();
      candidates = reading.candidates;
    }
    const result = decideByHashtag(trigger.segments, candidates);
    if (result.ask) return { ask: result.ask, reading };
    return { mode: reading ? 'hashtag_model_names' : 'hashtag', decisions: result.decisions, candidates, reading };
  }

  const reading = await read();
  if (!reading.decisions.length) {
    return trigger.question ? { unclear: 'question', reading } : { ask: 'unclear', reading };
  }
  const decisions = reading.decisions.map((d) => ({
    ...d, reason: d.decision === 'not_approved' ? reasonFor(d, triggerText) : null,
  }));
  return { mode: 'model', decisions, candidates: reading.candidates, reading };
}

module.exports = { decide, driversFromPost };
