'use strict';

/**
 * Asking about Board ↔ Bitrix differences, ONE AT A TIME, in the
 * Needs-attention group (the owner, 29 October 2026): a difference is asked as
 * soon as it is found if nothing else is out; the next goes out only after the
 * last is confirmed fixed or skipped. No daily limit, no buttons — the owner
 * fixes Bitrix and replies "done" (services/boardBitrix/reply.js).
 *
 * A QUESTION NOBODY ANSWERS IS POSTED AGAIN after REMIND_AFTER_HOURS, as a
 * reminder: the same question, at the bottom of the chat, rather than a
 * silence where the next question waits behind one scrolled out of sight.
 * Still one at a time — the reminder IS the question out.
 *
 * Economy mode stands it down with the rest of the check: nothing is asked or
 * reminded while `board_bitrix_check` is paused.
 *
 * The notice goes through notify() — the one door — in category
 * `needs_attention`, with subject `board_bitrix_question:<id>`. It carries no
 * `question_json`, so the control channel's Yes / No / Later machinery (its
 * buttons, standing cap and daily budget) never touches it, exactly as with
 * the AI learning questions (docs/architecture/ai-learning.md).
 *
 * Never throws.
 */

const { questionFor } = require('../../lib/boardBitrix/wording');
const { TRUCK_ENTITY_TYPE_ID } = require('../../lib/boardBitrix/vocabulary');
const { dealUrlFor, itemUrlFor } = require('../bitrix24DealStages');

const SUBJECT_TYPE = 'board_bitrix_question';
const CATEGORY = 'needs_attention';
const REMIND_AFTER_HOURS = 24;

function defaultDeps() {
  /* eslint-disable global-require */
  return {
    store: require('../../database/boardBitrix'),
    notify: require('../notifications/send').notify,
    portalOrigin: require('../bitrix24DealStages').portalOrigin,
    paused: () => require('../operations/economy').economyPauseReasonFor('board_bitrix_check'),
  };
  /* eslint-enable global-require */
}

/** Deal and truck links for a portal origin (no credential in it). */
function linksFor(origin) {
  if (!origin) return {};
  return {
    dealUrl: (id) => dealUrlFor(origin, id),
    truckUrl: (id) => itemUrlFor(origin, TRUCK_ENTITY_TYPE_ID, id),
  };
}

/** @returns {Promise<{asked: boolean, reason?: string, id?: number}>} */
async function askNext(deps = defaultDeps()) {
  try {
    if (deps.paused?.()) return { asked: false, reason: 'paused' };
    const settings = await deps.store.getSettings();
    if (!settings.enabled) return { asked: false, reason: 'off' };
    let claimed;
    let reminder = false;
    if (await deps.store.currentQuestion()) {
      claimed = await deps.store.bumpStaleQuestion(REMIND_AFTER_HOURS);
      if (!claimed) return { asked: false, reason: 'waiting_for_answer' };
      reminder = true;
    } else {
      const next = await deps.store.nextToAsk();
      if (!next) return { asked: false, reason: 'nothing_open' };
      try {
        claimed = await deps.store.markAsked(next.id);
      } catch (err) {
        // uniq_board_bitrix_one_asked: another pass asked one a moment ago.
        if (err && err.code === '23505') return { asked: false, reason: 'waiting_for_answer' };
        throw err;
      }
      if (!claimed) return { asked: false, reason: 'claimed_elsewhere' };
    }

    const waiting = await deps.store.countWaiting();
    const origin = await Promise.resolve(deps.portalOrigin()).catch(() => null);
    const q = questionFor(claimed.details, { ...linksFor(origin), waiting });
    const out = await deps.notify({
      category: CATEGORY,
      title: reminder ? `Reminder — ${q.title}` : q.title,
      lines: q.lines,
      action: q.action,
      subjectType: SUBJECT_TYPE,
      subjectId: String(claimed.id),
      // Each ask is its own notice: a question skipped yesterday and asked
      // again today must not be swallowed by the outbox's dedup.
      discriminator: `ask:${claimed.askCount}`,
    });
    if (out?.recorded || out?.reason === 'already_sent') {
      if (out.notice?.id) await deps.store.setQuestionNotice(claimed.id, out.notice.id);
      return { asked: true, id: claimed.id, reminder };
    }
    // A reminder that reached nobody leaves the question out, as it was.
    if (reminder) return { asked: false, reason: out?.reason || 'not_sent' };
    // A new question that reached nobody (no group, notifications off) goes
    // back in line rather than blocking every question behind it.
    await deps.store.unmarkAsked(claimed.id);
    return { asked: false, reason: out?.reason || 'not_sent' };
  } catch (err) {
    console.warn('[BOARD-BITRIX] could not ask the next question:', String(err.message).slice(0, 200));
    return { asked: false, reason: 'error' };
  }
}

/**
 * A short line in the group, hung under a message (the question, or the
 * owner's reply). Never throws.
 */
async function sayUnder({ chatId, messageId, text, lines = [], key }, deps = defaultDeps()) {
  if (chatId == null || messageId == null) {
    return deps.notify({ category: CATEGORY, title: text, lines, subjectType: 'board_bitrix_reply', subjectId: String(key) }).catch(() => null);
  }
  return deps.notify({
    category: CATEGORY,
    title: text,
    lines,
    subjectType: 'board_bitrix_reply',
    subjectId: String(key),
    inReplyTo: { chatId, messageId },
  }).catch(() => null);
}

module.exports = { SUBJECT_TYPE, CATEGORY, REMIND_AFTER_HOURS, askNext, sayUnder, linksFor, defaultDeps };
