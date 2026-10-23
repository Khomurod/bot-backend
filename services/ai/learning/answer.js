'use strict';

/**
 * Reading the owner's typed answer to one of Wenze's questions.
 *
 * THE GATES, cheapest first, the same order the control channel uses:
 *
 *   1. shape      a group, not a bot, a reply, some text — no database read
 *   2. is it ours the replied-to message is one of OUR questions
 *                 (subject `ai_learning_question`)
 *   3. WHO        the control channel's allow-list (`control_operators`).
 *                 Being in the group is not permission to teach Wenze; a
 *                 stranger's answer is consumed and never acted on or answered
 *   4. once       `answerWithLesson` moves the question only while it is
 *                 `asked`, in the same transaction as the lesson, so a
 *                 redelivered reply or a second person writes nothing and a
 *                 failed insert loses nothing
 *
 * Then the answer is kept as a lesson — the person's OWN WORDS, which later
 * prompts are given — and Wenze says back what it understood ("Understood: …
 * Saved"), restated by a model when one is available and in the owner's own
 * words when not. The restatement is shown, never used as the rule.
 *
 * Learning does not re-decide the case that raised the question: the lesson is
 * for the next one. See docs/architecture/ai-learning.md.
 */
const {
  scopeFor, isSkip, plainUnderstanding, understoodLine,
} = require('../../../lib/ai/lessons');
const { SUBJECT_TYPE, askNextQuestion } = require('./askOwner');
const { invalidateLessons } = require('./hooks');

const RESTATE_SYSTEM = [
  'A company owner answered a question about how to read messages at their trucking company.',
  'Restate in ONE short sentence, in English, what the answer teaches, so the owner can check',
  'you understood. Do not add anything the answer does not say. Reply with the sentence only.',
].join(' ');

function defaultDeps() {
  /* eslint-disable global-require */
  return {
    store: require('../../../database/aiLessons'),
    notices: require('../../../database/operationalNotifications'),
    operators: require('../../../database/controlOperators'),
    runCapability: require('../router').runCapability,
    askNext: () => askNextQuestion(),
    ack: null,
  };
  /* eslint-enable global-require */
}

const GROUP_TYPES = new Set(['group', 'supergroup']);

/** A model's one-sentence restatement, or the owner's own words. Never throws. */
async function understand(question, answer, deps) {
  try {
    const out = await deps.runCapability({
      capability: 'lesson_restatement',
      systemText: RESTATE_SYSTEM,
      userText: `Question: ${question.ask}\nAbout: "${question.context}"\nThe owner answered: "${answer}"`,
      expects: 'text',
      generation: { maxTokens: 160, temperature: 0 },
    });
    const text = String(out?.text || '').replace(/\s+/g, ' ').trim();
    if (text) return text;
  } catch (_) { /* no model, or it is switched off: the words themselves */ }
  return plainUnderstanding(answer);
}

/**
 * @param {object} reply  { chatId, chatType, messageId, repliedToMessageId,
 *                          text, telegramUserId, fromIsBot, fromName }
 * @returns {Promise<{handled: boolean, outcome?: string, reason?: string}>} never throws
 */
async function handleLessonReply(reply, deps = defaultDeps()) {
  const {
    chatId, chatType, messageId, repliedToMessageId, text, telegramUserId, fromIsBot, fromName,
  } = reply || {};
  if (!GROUP_TYPES.has(chatType) || fromIsBot) return { handled: false, reason: 'not_ours' };
  if (repliedToMessageId == null || messageId == null || chatId == null) return { handled: false, reason: 'not_a_reply' };
  const words = String(text || '').trim();
  if (!words) return { handled: false, reason: 'no_text' };

  try {
    const notice = await deps.notices.findNoticeByTelegramMessage(chatId, repliedToMessageId);
    if (!notice || notice.subjectType !== SUBJECT_TYPE) return { handled: false, reason: 'not_a_question' };
    const question = await deps.store.getQuestion(Number(notice.subjectId));
    if (!question) return { handled: false, reason: 'unknown_question' };

    if (!(await deps.operators.isControlOperator(telegramUserId))) {
      return { handled: true, outcome: 'ignored_unauthorised' };
    }
    const say = (line) => (deps.ack ? deps.ack({ chatId, inReplyToMessageId: messageId, text: line }) : null);

    if (question.status !== 'asked') {
      await say('That question is already answered. Thank you!');
      return { handled: true, outcome: 'already_answered' };
    }

    if (isSkip(words)) {
      const skipped = await deps.store.skipQuestion(question.id, { telegramUserId });
      if (!skipped) return { handled: true, outcome: 'already_answered' };
      await say('Skipped. I will not learn anything from that one.');
      await deps.askNext();
      return { handled: true, outcome: 'skipped' };
    }

    // Restated BEFORE the claim, so the claim and the lesson can be one
    // transaction without holding it open across a model call.
    const understood = await understand(question, words, deps);
    const scope = scopeFor(question.capability);
    const saved = await deps.store.answerWithLesson(question.id, {
      answerText: words,
      telegramUserId,
      lesson: {
        scope,
        about: `${question.ask} — "${question.context}"`,
        understoodAs: understood,
        createdByName: fromName || null,
      },
    });
    if (!saved) return { handled: true, outcome: 'already_answered' };
    invalidateLessons(scope);
    await say(understoodLine(understood));
    await deps.askNext();
    return { handled: true, outcome: 'learned' };
  } catch (err) {
    console.warn('[AI LEARNING] reply handling failed:', err.message);
    return { handled: false, reason: 'error' };
  }
}

module.exports = { handleLessonReply, understand, defaultDeps, RESTATE_SYSTEM };
