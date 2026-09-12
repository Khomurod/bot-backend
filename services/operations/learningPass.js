'use strict';

/**
 * Noticing that Wenze keeps being corrected the same way, and proposing
 * something about it.
 *
 * THE SUGGESTION IS ONLY EVER A SUGGESTION. Nothing in this file changes a
 * setting, disables a check, edits a rule or touches a threshold. It writes a
 * row whose status is `proposed` and posts a message. The owner's line is that
 * important business rules must not change permanently without an
 * administrator confirming, and the cheapest way to keep that true is for the
 * code that spots the pattern to have no way to act on it — so
 * `lib/operations/learning.js` returns plain data and this file only stores and
 * sends it.
 *
 * THE SIGNAL IS A HUMAN UNDOING SOMETHING, because that is the only feedback
 * this application actually collects. Nobody fills in a form saying "that was
 * wrong"; they revert the correction, or they answer the candidate themselves.
 * `operational_corrections.reverted_at` and
 * `recruiting_ai_conversations.last_refusal_reason` are already written for
 * other reasons, and are the whole input.
 *
 * ONE REVERT IS NOT A LESSON. A person disagreeing about one row is usually
 * right about that row and nothing more. Three of the same action inside a
 * fortnight is the point at which "this check is wrong" becomes more likely
 * than "those three rows were unusual".
 */
const { findLessons } = require('../../lib/operations/learning');
const { withRunRecord } = require('./runLedger');

const POLL_MS = 12 * 60 * 60 * 1000;
const FIRST_TICK_DELAY_MS = 25 * 60 * 1000;

function defaultDeps() {
  /* eslint-disable global-require */
  return {
    corrections: require('../../database/operationalCorrections'),
    conversations: require('../../database/recruitingConversations'),
    decisions: require('../../database/operationalDecisions'),
    store: require('../../database/operationalLearning'),
    knowledge: require('../../database/controlKnowledge'),
    notify: require('../notifications/send').notify,
  };
  /* eslint-enable global-require */
}

/**
 * Everything a person undid recently, and every draft the recruiting guard
 * refused. Either source failing costs that source only: half the evidence is
 * still evidence, and a suggestion built from one of them is not wrong, just
 * narrower.
 */
async function gatherSources(deps, { limit = 500 } = {}) {
  const [corrections, conversations, decisions, memories] = await Promise.all([
    deps.corrections.listCorrections({ live: false, limit }).catch((err) => {
      console.warn('[LEARNING] could not read reverted corrections:', err.message);
      return [];
    }),
    deps.conversations.listConversations({ limit: 200 }).catch((err) => {
      console.warn('[LEARNING] could not read recruiting conversations:', err.message);
      return [];
    }),
    // THE WORLD DISAGREEING, rather than a person. Reverts are somebody
    // objecting and refusals are somebody rejecting a draft; this is a check
    // that acted and whose action the verification pass later found did not
    // hold. It is empty until decisions have been graded, and empty costs
    // nothing.
    // Optional-chained and wrapped in Promise.resolve: a caller supplying a
    // partial dependency map — every existing test of this pass does — must
    // lose the NEW source, not the whole pass. Without this, adding a third
    // input silently turned every such caller's learning off.
    Promise.resolve(deps.decisions?.listRecentDecisions?.({ verdict: 'act', limit: 300 }))
      .then((rows) => rows || [])
      .catch((err) => {
        console.warn('[LEARNING] could not read graded decisions:', err.message);
        return [];
      }),
    // THE OWNER SAYING WHAT THEY WANT, IN WORDS. The other three sources are
    // somebody objecting after the fact; this one is the closest thing to a
    // stated business rule the application ever receives. Same optional chain
    // and same reason: a partial dependency map loses this source only.
    Promise.resolve(deps.knowledge?.listMemories?.({ limit: 200 }))
      .then((rows) => rows || [])
      .catch((err) => {
        console.warn('[LEARNING] could not read remembered answers:', err.message);
        return [];
      }),
  ]);
  return { corrections, conversations, decisions, memories };
}

/**
 * One pass.
 *
 * A suggestion already announced is NOT announced again. The pattern persisting
 * is the normal case — the check is still wrong and still being reverted — and
 * repeating the same proposal every twelve hours is how somebody stops reading
 * them. The row's `last_seen_at` keeps moving so the screen shows it is current.
 */
async function runLearningPass({ now = Date.now(), deps = defaultDeps(), options = {} } = {}) {
  const nowIso = new Date(now).toISOString();
  const summary = { found: 0, proposed: 0, announced: 0, errors: [] };

  let sources;
  try {
    sources = await gatherSources(deps, options);
  } catch (err) {
    return { ...summary, errors: [err.message] };
  }

  const lessons = findLessons(sources, { ...options, now: nowIso });
  summary.found = lessons.length;

  for (const lesson of lessons) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const row = await deps.store.upsertSuggestion({
        kind: lesson.kind,
        subjectId: lesson.subjectId,
        title: lesson.title,
        suggestion: lesson.suggestion,
        evidence: lesson.evidence,
        // What accepting would DO, or null. Carried through from the pure
        // module so the decision layer never has to re-derive it — and so a
        // suggestion with nothing safe to apply says so rather than implying.
        applyAction: lesson.applyAction || null,
      });
      summary.proposed += 1;

      if (row?.notifiedAt) continue;
      // A decision already taken is not re-raised either: an administrator who
      // dismissed a proposal should not meet it again every fortnight.
      if (row && row.status !== 'proposed') continue;

      // eslint-disable-next-line no-await-in-loop
      const out = await deps.notify({
        category: 'ai_learning',
        title: lesson.title,
        lines: lesson.lines,
        reason: lesson.suggestion,
        action: lesson.applyAction
          ? 'Nothing has changed yet. Accepting it in Operations → What Wenze learned '
            + 'will switch the setting, and one click puts it back'
          : 'Nothing has changed. Accepting records agreement; somebody still has to do it',
        subjectType: 'learning',
        subjectId: `${lesson.kind}:${lesson.subjectId}`,
        discriminator: nowIso.slice(0, 10),
        evidence: lesson.evidence,
      });
      if (out.recorded && row?.id) {
        // eslint-disable-next-line no-await-in-loop
        await deps.store.markSuggestionNotified(row.id);
        summary.announced += 1;
      }
    } catch (err) {
      summary.errors.push(`${lesson.kind}:${lesson.subjectId}: ${err.message}`);
    }
  }

  return summary;
}

let timer = null;
let stopped = true;

/**
 * What the last pass did, for `/api/health`.
 *
 * This pass writes rows ONLY when it finds something, and finding nothing is
 * the ordinary case — so three zeros cannot tell you whether it ran and had
 * nothing to say or never ran at all. Only one of those is good news. The same
 * reasoning as the retention watch, and the same reason: a background job whose
 * failure looks like its success is the problem this phase exists to remove.
 */
let lastRun = null;
let tickRunning = false;

async function tick() {
  // The same missing guard as retention's, and structurally identical. Twelve
  // hours is long enough that overlap is unlikely and not long enough that it
  // is impossible, and an unguarded pass upserting suggestions twice is a
  // silent duplicate nobody would trace back to here.
  if (tickRunning) return;
  tickRunning = true;
  const startedAt = new Date().toISOString();
  try {
    const summary = await withRunRecord('learning_pass', () => runLearningPass({}));
    lastRun = { at: startedAt, ok: true, ...summary, errors: summary.errors.length };
    if (summary.announced > 0) {
      console.log(`[LEARNING] ${summary.announced} suggestion(s) raised for an administrator`);
    }
  } catch (err) {
    lastRun = { at: startedAt, ok: false, error: err.message };
    console.warn('[LEARNING] pass failed:', err.message);
  } finally {
    tickRunning = false;
  }
}

/** Running, and what the last pass actually did. */
function getLearningStatus() {
  return { running: Boolean(timer), lastRun };
}

/**
 * Twice a day, first pass 25 minutes after boot.
 *
 * Slower than anything else here on purpose. A pattern that needs three reverts
 * inside a fortnight does not become visible in an hour, and a proposal about
 * how Wenze should behave is the last thing that should arrive often.
 */
function startLearningPass() {
  stopped = false;
  console.log(`[LEARNING] Pass started — every ${POLL_MS / 3600000}h`);
  setTimeout(() => { if (!stopped) tick(); }, FIRST_TICK_DELAY_MS).unref?.();
  timer = setInterval(() => { if (!stopped) tick(); }, POLL_MS);
  timer.unref?.();
}

function stopLearningPass() {
  stopped = true;
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = {
  POLL_MS,
  getLearningStatus,
  FIRST_TICK_DELAY_MS,
  defaultDeps,
  gatherSources,
  runLearningPass,
  startLearningPass,
  stopLearningPass,
};
