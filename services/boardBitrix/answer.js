'use strict';

/**
 * What a person's answer to a Board ↔ Bitrix question DOES — shared by a
 * typed reply (services/boardBitrix/reply.js) and a button press
 * (services/boardBitrix/buttons.js), so "skip" typed and "Skip" tapped are
 * the same thing.
 *
 *   may answer   the control channel's operators, and since 11 November 2026
 *                the people listed in Settings → Dispatcher Board ("who may
 *                answer"): before that only the owner counted, and a
 *                teammate's "skip" was silently ignored
 *   skip         back in line for a day, and the next question is asked
 *   done         Bitrix is read again; confirmed → the next question
 *   do action N  services/boardBitrix/apply.js (Bitrix re-read first), then
 *                the same re-check as "done"
 *
 * Never throws; every outcome is said under the question or the reply.
 */

const { factsFor } = require('../../lib/boardBitrix/wording');
const { linksFor } = require('./ask');

const SKIP_HOURS = 24;
/** One answer per question at a time in this process: a double tap is one press. */
const busy = new Set();

/** Whether this Telegram user's answers count. */
async function mayAnswer(telegramUserId, deps) {
  if (telegramUserId == null) return false;
  if (await deps.operators.isControlOperator(telegramUserId)) return true;
  const ids = await deps.advice.getResponderIds().catch(() => []);
  return ids.includes(String(telegramUserId));
}

async function skip(question, say, deps) {
  if (!(await deps.store.snooze(question.id, SKIP_HOURS))) return 'already_moved';
  await say('Skipped — I will come back to it tomorrow.');
  await deps.askNext();
  return 'skipped';
}

/** Bitrix read again: confirmed → thank and ask the next; else what is still different. */
async function recheck(question, say, deps, doneLine = '✅ Confirmed — Bitrix matches the Dispatcher Board now. Thank you!') {
  const summary = await deps.recheck(question.id);
  // A pass that compared but whose status sync failed carries `error` too
  // (services/boardBitrix/pass.js `syncFailure`): the comparison still holds.
  if (!summary || summary.blocked || (summary.error && summary.compared !== true)) {
    await say(`I could not check Bitrix just now (${String(summary?.error || summary?.blocked || 'no answer').slice(0, 160)}). `
      + 'I will check again on the next pass.');
    return 'recheck_failed';
  }
  const now = await deps.store.getDiscrepancy(question.id);
  // The timer's pass saw the fix first and has already said so and moved on.
  if (now && now.state === 'resolved' && now.resolvedHow === 'seen_fixed') return 'fixed_meanwhile';
  if (!now || now.state === 'resolved') {
    await say(doneLine);
    await deps.askNext();
    return 'confirmed';
  }
  const origin = await Promise.resolve(deps.portalOrigin()).catch(() => null);
  await say('Still different:', [
    ...factsFor(now.details, linksFor(origin)),
    'Reply "done" again once it is fixed. If you changed the Dispatcher Board instead, I re-read it every few minutes.',
  ]);
  return 'still_different';
}

const FIX_WORDS = Object.freeze({
  set_stage: 'move the deal to the stage the Board\'s status maps to',
  set_title: 'rename the deal to the Board\'s name',
  set_driver_type: 'set the deal\'s driver type',
  set_truck: 'point the deal at the Board\'s truck',
});

/**
 * Who asked for this fix, and why — for Monitoring → Logs. The Telegram id
 * is the evidence; the name is a label. No driver name goes in the reason.
 * @param {{kind: 'person_button'|'person_reply', telegramUserId, name}} actor
 */
function auditForFix(question, index, action, actor) {
  const viaButton = actor?.kind === 'person_button';
  return {
    actorKind: viaButton ? 'person_button' : 'person_reply',
    actorTelegramId: actor?.telegramUserId ?? null,
    actorName: actor?.name || null,
    trigger: viaButton ? 'board_bitrix.button' : 'board_bitrix.reply',
    reason: `${viaButton ? 'Pressed a button' : 'Asked in a reply'} under a Board ↔ Bitrix question to `
      + `${FIX_WORDS[action?.type] || 'apply a fix'} (the Dispatcher Board is the source of truth).`,
    evidence: {
      questionId: question.id, questionKind: question.kind || null, fixIndex: Number(index), fixType: action?.type || null,
    },
  };
}

/**
 * @param {object} [actor]  `{kind: 'person_button'|'person_reply', telegramUserId, name}`
 */
async function doAction(question, index, say, deps, actor = null) {
  const advice = await deps.advice.getAdvice(question.id);
  const action = advice?.actions?.[Number(index)];
  if (!action) {
    await say('That button no longer matches this question — reply "done" once it is fixed, or "skip".');
    return 'unknown_action';
  }
  let result;
  try {
    result = await deps.apply(action, auditForFix(question, index, action, actor));
  } catch (err) {
    await say(`Bitrix did not answer — nothing was changed. Try again in a minute. (${String(err.message).slice(0, 120)})`);
    return 'bitrix_failed';
  }
  if (!result.ok) {
    await say(`Not done: ${result.why}. Nothing was changed.`);
    return 'refused';
  }
  return recheck(question, say, deps, `✅ Done — ${action.label.replace(/^\w/, (c) => c.toLowerCase())}: ${result.done}. `
    + 'Bitrix matches the Dispatcher Board now.');
}

/**
 * Run one answer, one at a time per question.
 * @param {() => Promise<string>} work
 */
async function exclusive(questionId, work) {
  const key = String(questionId);
  if (busy.has(key)) return 'busy';
  busy.add(key);
  try {
    return await work();
  } finally {
    busy.delete(key);
  }
}

module.exports = {
  SKIP_HOURS, mayAnswer, skip, recheck, doAction, exclusive, auditForFix,
};
