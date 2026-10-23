'use strict';

/**
 * Which driver a Safety decision is about, when Safety did not reply to the
 * driver's post — "approved" written on its own in General.
 *
 * The candidates are found WITHOUT a model (services/safetyApprovals/
 * postLocator.js): the posts the last few messages before Safety's belong to.
 * A model is asked only when there is more than one, and it may only PICK one
 * of them by its label, or say it cannot tell — it never names a driver
 * itself. What it picks is then read exactly like a reply to that post.
 *
 * The text is redacted first (no SSN, phone or other long number leaves) and
 * fenced as untrusted: anybody in the group can write "ignore the above".
 */

const { AiUnavailableError, runCapability } = require('../ai/router');
const { redactForAi } = require('../../lib/hiringStages/redact');

const CAPABILITY = 'safety_approval_reading';

const SYSTEM = [
  'You read a trucking company\'s recruiting group chat.',
  'A Safety officer wrote a hire decision WITHOUT replying to the driver\'s post.',
  'You are given the last messages before it, and the driver posts they are about, labelled P1, P2, …',
  'Say which post the Safety message is about. Use who was being discussed just before it,',
  'names Safety mentions, and replies. If you are not sure, answer null — never guess.',
  'Answer with JSON only: {"post": "P1"} or {"post": null}',
].join('\n');

function fence(tag, text) {
  return `<${tag}>\n${String(text || '').replace(new RegExp(`</?${tag}>`, 'gi'), '')}\n</${tag}>`;
}

const clip = (text, n) => {
  const t = redactForAi(text || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

function buildPrompt({ recent, posts, safetyText }) {
  const postLines = posts.map((p, i) => `P${i + 1} (by ${p.recruiterName || 'a recruiter'}): ${clip(p.text, 300) || '(photos only)'}`);
  const recentLines = recent.map((m) => {
    const about = m.postIndex === null ? '' : ` [about P${m.postIndex + 1}]`;
    return `${m.role}${m.fromName ? ` (${m.fromName})` : ''}${about}: ${clip(m.text, 200) || '(file)'}`;
  });
  return [
    fence('driver_posts', postLines.join('\n')),
    fence('recent_messages', recentLines.join('\n')),
    fence('safety_decision', clip(safetyText, 400)),
  ].join('\n\n');
}

function validateShape(_text, parsed) {
  if (!parsed || typeof parsed !== 'object' || !('post' in parsed)) return { message: 'expected {"post": …}' };
  return true;
}

/**
 * @returns {Promise<number|null>} the index of the post, or null
 * @throws {AiUnavailableError} when no model could be asked
 */
async function pickPost({ recent, posts, safetyText }, deps = {}) {
  const run = deps.runCapability || runCapability;
  const answer = await run({
    capability: CAPABILITY,
    systemText: SYSTEM,
    userText: buildPrompt({ recent, posts, safetyText }),
    expects: 'json',
    validate: validateShape,
  });
  // Not sure even after Claude: no post — Safety is asked instead.
  if (answer?.uncertain) return null;
  const label = String(answer?.parsed?.post ?? '').trim().toUpperCase();
  const match = label.match(/^P(\d+)$/);
  if (!match) return null;
  const index = Number(match[1]) - 1;
  return index >= 0 && index < posts.length ? index : null;
}

module.exports = { pickPost, buildPrompt, SYSTEM, AiUnavailableError };
