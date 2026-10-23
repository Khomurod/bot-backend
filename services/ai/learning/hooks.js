'use strict';

/**
 * The two places learning touches every AI decision, handed to
 * services/ai/escalation.js by the router:
 *
 *   lessonsFor(capability)   the lessons block for that kind of decision,
 *                            cached for five minutes per scope. A read that
 *                            fails is cached as "no lessons" for the same five
 *                            minutes: an AI call must never wait on, or fail
 *                            because of, the lessons table.
 *   onUncertain(args, result)  a decision still not sure after Claude, whose
 *                            caller said what to ask (`args.learning`), is
 *                            queued as a question for the owner. Fire and
 *                            forget — never awaited, never thrown.
 *
 * See docs/architecture/ai-learning.md.
 */
const crypto = require('node:crypto');
const { scopeFor, renderLessonsForPrompt, contextForChat } = require('../../../lib/ai/lessons');

const TTL_MS = 5 * 60 * 1000;
const cache = new Map();

function store() {
  // eslint-disable-next-line global-require
  return require('../../../database/aiLessons');
}

async function lessonsFor(capability, { now = Date.now(), lessons = store() } = {}) {
  const scope = scopeFor(capability);
  if (!scope) return '';
  const hit = cache.get(scope);
  if (hit && hit.expiresAt > now) return hit.text;
  let text = '';
  try {
    text = renderLessonsForPrompt(await lessons.listActiveLessons(scope));
  } catch (err) {
    console.warn('[AI LEARNING] lessons unavailable:', err.message);
  }
  cache.set(scope, { text, expiresAt: now + TTL_MS });
  return text;
}

/** After a lesson is added or removed. No scope clears them all. */
function invalidateLessons(scope = null) {
  if (scope) cache.delete(scope);
  else cache.clear();
}

/** A stable key for "the same thing", when the caller gave none. */
function subjectKeyFor(learning) {
  if (learning.subjectKey) return String(learning.subjectKey).slice(0, 200);
  return crypto.createHash('sha256').update(String(learning.context || '')).digest('hex').slice(0, 32);
}

function onUncertain(args, result, { ask = null } = {}) {
  const learning = args?.learning;
  if (!learning || !learning.context || !learning.ask || !scopeFor(args.capability)) return;
  // eslint-disable-next-line global-require
  const askOwner = ask || require('./askOwner').queueAndAsk;
  Promise.resolve()
    .then(() => askOwner({
      capability: args.capability,
      subjectKey: subjectKeyFor(learning),
      context: contextForChat(learning.context),
      ask: String(learning.ask).slice(0, 300),
      confidence: result?.confidence ?? null,
    }))
    .catch((err) => console.warn('[AI LEARNING] could not queue a question:', err.message));
}

module.exports = { lessonsFor, invalidateLessons, onUncertain, subjectKeyFor };
