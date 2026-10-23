'use strict';

/**
 * Asking the owner, one question at a time.
 *
 * THE OWNER'S RULE (23 October 2026): questions go to the system-notifications
 * group in English, ONE at a time — the next only after the last is answered
 * or skipped — with no daily limit and no buttons. The answer is typed as a
 * reply, read in services/ai/learning/answer.js.
 *
 * `askNextQuestion` is called after a question is queued, after one is
 * answered or skipped, and from the scheduler's hourly tick (so a question
 * that could not be sent — no group configured, the switch off — goes out
 * once it can). It never throws.
 *
 * See docs/architecture/ai-learning.md.
 */
const { questionNotice } = require('../../../lib/ai/lessons');

/** The notice's subject: what the reply handler looks for. */
const SUBJECT_TYPE = 'ai_learning_question';

function defaultDeps() {
  /* eslint-disable global-require */
  return {
    store: require('../../../database/aiLessons'),
    getAiSettings: require('../../../database/aiSettings').getAiSettings,
    notify: require('../../notifications/send').notify,
  };
  /* eslint-enable global-require */
}

/** @returns {Promise<{asked: boolean, reason?: string, id?: number}>} */
async function askNextQuestion(deps = defaultDeps()) {
  try {
    const settings = await deps.getAiSettings();
    if (settings.enabled === false || settings.learningEnabled === false) return { asked: false, reason: 'off' };
    if (await deps.store.currentQuestion()) return { asked: false, reason: 'waiting_for_answer' };
    const next = await deps.store.nextQueuedQuestion();
    if (!next) return { asked: false, reason: 'nothing_queued' };
    const claimed = await deps.store.markAsked(next.id);
    if (!claimed) return { asked: false, reason: 'claimed_elsewhere' };

    const notice = questionNotice(claimed);
    const out = await deps.notify({
      category: 'ai_learning',
      title: notice.title,
      lines: notice.lines,
      subjectType: SUBJECT_TYPE,
      subjectId: String(claimed.id),
      discriminator: 'ask',
    });
    // Written down (sent, or held for the outbox) — or sent before, which is
    // the outbox's dedup speaking. Anything else reached nobody, so the
    // question goes back in line rather than blocking every one behind it.
    if (out?.recorded || out?.reason === 'already_sent') return { asked: true, id: claimed.id };
    await deps.store.unmarkAsked(claimed.id);
    return { asked: false, reason: out?.reason || 'not_sent' };
  } catch (err) {
    console.warn('[AI LEARNING] could not ask the next question:', err.message);
    return { asked: false, reason: 'error' };
  }
}

/** Queue a question, then ask it if nothing else is out. Never throws. */
async function queueAndAsk(question, deps = defaultDeps()) {
  try {
    // Switched off: nothing is queued either, so switching it back on does not
    // start with a backlog of stale questions.
    const settings = await deps.getAiSettings();
    if (settings.enabled === false || settings.learningEnabled === false) return { queued: false, reason: 'off' };
    const queued = await deps.store.queueQuestion(question);
    if (!queued) return { queued: false, reason: 'already_known' };
    console.log(`[AI LEARNING] queued question ${queued.id} (${question.capability})`);
    const asked = await askNextQuestion(deps);
    return { queued: true, id: queued.id, asked: asked.asked };
  } catch (err) {
    console.warn('[AI LEARNING] could not queue a question:', err.message);
    return { queued: false, reason: 'error' };
  }
}

module.exports = { SUBJECT_TYPE, askNextQuestion, queueAndAsk, defaultDeps };
