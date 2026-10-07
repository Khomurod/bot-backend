'use strict';

/**
 * Control questions the owner can actually answer — the six fixes from the
 * 2026-10-07 screenshot (Q-51 / Q-52):
 *
 *   1. a chat that is not a driver group is asked "is it a driver chat?", not
 *      "is the driver working?";
 *   2. a status question names the driver and the truck, and its buttons are
 *      the answers — Working / Not working / Later;
 *   3. the owner's choice is carried out whoever set the status before, and a
 *      stand-down never claims somebody else fixed it;
 *   4. the AI reader sees the question, not only the reply;
 *   5. (covered in `controlAskPass.test.js`) each question gives its own reason;
 *   6. an unclear reply gets the question again, naming who it is about.
 */
const test = require('node:test');
const assert = require('node:assert');

const identity = require('../services/operations/checks/identity');
const { CHECK_TO_ACTION, getAction, choiceActionFor } = require('../services/operations/corrections/actions');
const { payloadFor } = require('../services/operations/corrections/autoApply');
const {
  QUESTIONS, questionFor, offeredActionsFor, replyHintFor,
} = require('../lib/control/askable');
const { keyboardFor, parseButton, wordFor } = require('../lib/control/buttons');
const { parseIntent } = require('../lib/control/intent');
const { executeOffered } = require('../services/control/actions');
const { shouldRemember } = require('../services/control/memory');
const { buildUserText, readReplyWithAi } = require('../services/control/aiIntent');
const { answerQuestion, promptOf } = require('../services/control/answerQuestion');
const { fingerprintFor } = require('../lib/control/fingerprint');

function group(id, name, extra = {}) {
  return {
    id, group_name: name, group_type: 'driver', active: true, status_source: 'bot', ...extra,
  };
}
function profile(groupId, extra = {}) {
  return {
    group_id: groupId, first_name: 'TEST', last_name: 'DRIVER', unit_number: '7777', status: 'active', ...extra,
  };
}

/** A status finding as the check files it for an AI-set chat. */
function aiStatusFinding() {
  const [f] = identity.checkStatusDisagreement({
    groups: [group(5, 'WENZE UNIT # 7777 TEST DRIVER', { active: false, status_source: 'ai' })],
    profiles: [profile(5)],
  });
  return { id: 51, status: 'open', ...f };
}

// ── 1. not a driver group ──────────────────────────────────────────────────

test('1. an admin-looking chat is never asked "is the driver working?"', () => {
  const groups = [group(72, 'Wenze Facebook Leads', { active: false, status_source: 'ai' })];
  assert.deepStrictEqual(identity.checkStatusDisagreement({ groups, profiles: [profile(72)] }), []);
});

test('1. ...it is asked whether it is a driver chat instead — even when inactive', () => {
  const groups = [group(72, 'Wenze Facebook Leads', { active: false })];
  const [f] = identity.checkNonDriverChatsTypedAsDriver({ groups });
  assert.ok(f, 'an inactive admin chat typed as a driver still gets the retype question');
  const q = questionFor({ checkKey: f.checkKey, ...f });
  assert.strictEqual(q.ask, 'Is "Wenze Facebook Leads" a driver\'s chat?');
  const offered = offeredActionsFor({ hasAction: true, choices: q.choices });
  const kb = keyboardFor(9, offered).inline_keyboard[0].map((b) => b.text);
  assert.deepStrictEqual(kb, ['🚚 Driver chat', '🏢 Not a driver', '⏰ Later']);
  // "Not a driver" is the fix; "Driver chat" closes the question with a reason.
  assert.strictEqual(parseIntent('not a driver', { offered }).action, 'approve');
  const keep = parseIntent('yes', { offered });
  assert.strictEqual(keep.action, 'dismiss');
  assert.match(keep.reason, /driver's chat/);
});

// ── 2. wording and buttons ─────────────────────────────────────────────────

test('2. an AI- or admin-set status is its own check, answered by a person', () => {
  const f = aiStatusFinding();
  assert.strictEqual(f.checkKey, 'identity.status_needs_decision');
  assert.strictEqual(f.tier, 'approval');
  assert.strictEqual(CHECK_TO_ACTION.get(f.checkKey), 'identity.set_driver_status');
  assert.strictEqual(getAction('identity.set_driver_status').tier, 'approval');
  // The bot-observed case keeps its automatic action, unchanged.
  const [bot] = identity.checkStatusDisagreement({
    groups: [group(6, 'WENZE UNIT # 6 X', { active: true, status_source: 'bot' })],
    profiles: [profile(6, { status: 'inactive' })],
  });
  assert.strictEqual(bot.checkKey, 'identity.status_disagreement');
  assert.strictEqual(CHECK_TO_ACTION.get(bot.checkKey), 'identity.sync_profile_status');
});

test('2. the status question names the driver and truck, with value buttons', () => {
  const f = aiStatusFinding();
  const q = questionFor(f);
  assert.strictEqual(q.ask, 'Is TEST DRIVER (Unit 7777) working for us right now?');
  assert.deepStrictEqual(q.lines, ['The chat says not working, the profile says working.']);
  const offered = offeredActionsFor({ hasAction: true, choices: q.choices });
  const row = keyboardFor(40, offered).inline_keyboard[0];
  assert.deepStrictEqual(row.map((b) => b.text), ['✅ Working', '🚫 Not working', '⏰ Later']);
  // The proposal is "inactive" (the chat's state), so Not working is approve
  // and Working is the alternative — and a tap on either parses back.
  assert.deepStrictEqual(parseButton(row[0].callback_data), { noticeId: 40, action: 'alternative' });
  assert.deepStrictEqual(parseButton(row[1].callback_data), { noticeId: 40, action: 'approve' });
  assert.match(replyHintFor(offered), /working · not working · later/);
  // No bare "no (say why)": to this question "no" is an answer.
  assert.ok(!offered.some((o) => o.key === 'dismiss'));
});

test('2. every choice button reads back as itself through the typed-reply rules', () => {
  const f = aiStatusFinding();
  for (const [key, entry] of Object.entries(QUESTIONS)) {
    if (typeof entry.choices !== 'function') continue;
    const q = questionFor({ ...f, checkKey: key });
    const offered = offeredActionsFor({ hasAction: true, choices: q.choices });
    for (const o of offered) {
      const got = parseIntent(wordFor(o.key, offered), { offered });
      assert.strictEqual(got.action, o.key, `${key}: the "${o.label}" button read as ${got.action}`);
    }
  }
});

test('2. the owner\'s own words for a status pick the right answer', () => {
  const offered = offeredActionsFor({ hasAction: true, choices: questionFor(aiStatusFinding()).choices });
  const value = (t) => parseIntent(t, { offered }).value ?? null;
  assert.strictEqual(value('Driver is active'), 'active');
  assert.strictEqual(value('working'), 'active');
  assert.strictEqual(value('yes'), 'active');
  assert.strictEqual(value('Да'), 'active');
  assert.strictEqual(value('no'), 'inactive');
  assert.strictEqual(value('he quit last week'), 'inactive');
  assert.strictEqual(value('уволился'), 'inactive');
  assert.strictEqual(value('not working'), 'inactive');
  // Not knowing is not "no".
  assert.strictEqual(parseIntent("I don't know which driver this is", { offered }).intent, 'unclear');
  assert.strictEqual(parseIntent('не знаю кто это', { offered }).intent, 'unclear');
  assert.strictEqual(parseIntent('later', { offered }).action, 'snooze');
});

// ── 3. the choice is carried out ───────────────────────────────────────────

function execDeps(calls) {
  return {
    applyCorrection: async (args) => { calls.push(args); return { id: 99 }; },
    StaleCorrectionError: class extends Error {},
    findings: {},
    takeDecision: async () => ({ id: 7, acted: async () => {} }),
    payloadFor,
    actionForCheck: () => getAction('identity.sync_profile_status'),
    choiceActionFor,
  };
}

test('3. "Working" on an AI-set chat sets BOTH records, through the person-only action', async () => {
  const f = aiStatusFinding();
  const offered = offeredActionsFor({ hasAction: true, choices: questionFor(f).choices });
  const calls = [];
  const got = await executeOffered({
    question: { offeredActions: offered }, finding: f,
    intent: parseIntent('working', { offered }), telegramUserId: '42',
  }, execDeps(calls));
  assert.strictEqual(got.outcome, 'applied');
  assert.strictEqual(got.message, 'Done — recorded as working.');
  assert.strictEqual(calls[0].actionKey, 'identity.set_driver_status');
  assert.deepStrictEqual(calls[0].payload, { groupId: 5, toStatus: 'active' });
  assert.deepStrictEqual(calls[0].admin, { telegramUserId: '42' });
});

test('3. the value comes from the question, never from the reply', async () => {
  const f = aiStatusFinding();
  const calls = [];
  const got = await executeOffered({
    question: { offeredActions: [{ key: 'approve', label: 'yes' }] }, finding: f,
    intent: { action: 'alternative', value: 'active' }, telegramUserId: '42',
  }, execDeps(calls));
  assert.strictEqual(got.outcome, 'refused', 'an answer the question did not offer');
  assert.strictEqual(calls.length, 0);
});

test('3. choosing the other answer is not stored as a yes or a no', () => {
  assert.strictEqual(shouldRemember({ outcome: 'applied', intent: { action: 'alternative', remember: true } }), false);
});

test('3. the split check keeps the answers the owner gave before it', () => {
  const evidence = { groupActive: false, profileStatus: 'active', statusSource: 'ai' };
  assert.strictEqual(
    fingerprintFor({ checkKey: 'identity.status_needs_decision', evidence }),
    fingerprintFor({ checkKey: 'identity.status_disagreement', evidence })
  );
});

// ── 4. the AI reader sees the question ─────────────────────────────────────

test('4. the AI is shown the question the owner is answering', async () => {
  const f = aiStatusFinding();
  const q = questionFor(f);
  const offered = offeredActionsFor({ hasAction: true, choices: q.choices });
  const text = buildUserText({ text: 'he drives for us', offered, question: { ask: q.ask, lines: q.lines } });
  assert.match(text, /<<<QUESTION\nIs TEST DRIVER \(Unit 7777\) working for us right now\?/);
  assert.match(text, /- alternative: means the answer "working"/);

  // Its pick returns the QUESTION's value, whatever else it says.
  const got = await readReplyWithAi('he drives for us', {
    offered,
    question: q,
    run: async () => ({ parsed: { action: 'alternative', value: 'inactive', confidence: 90 } }),
  });
  assert.strictEqual(got.action, 'alternative');
  assert.strictEqual(got.value, 'active');
});

// ── 6. an unclear reply gets the question again ────────────────────────────

test('6. "I don\'t know which driver" is answered with the question again, naming the driver', async () => {
  const f = aiStatusFinding();
  const q = questionFor(f);
  const offered = offeredActionsFor({ hasAction: true, choices: q.choices });
  const notice = {
    id: 3, findingId: 51, clarifyRound: 0,
    question: { findingId: 51, offeredActions: offered, prompt: { ask: q.ask, lines: q.lines } },
  };
  const seen = { ai: [], notices: [], finalised: [] };
  const deps = {
    findings: { getFindingById: async () => f },
    parseIntent,
    readReplyWithAi: async (text, opts) => {
      seen.ai.push(opts);
      return { intent: 'unclear', action: null, remember: false };
    },
    replies: { finaliseReply: async (id, patch) => { seen.finalised.push(patch); } },
    notify: async (n) => { seen.notices.push(n); return { recorded: true }; },
    ack: async () => {},
  };
  await answerQuestion({
    reply: { chatId: '-1', messageId: 77, telegramUserId: '42' },
    notice, claim: { id: 8 }, settings: { clarifyLimit: 1 }, text: "I don't know which driver this is",
  }, deps);

  assert.deepStrictEqual(seen.ai[0].question, { ask: q.ask, lines: q.lines }, 'the AI saw the question');
  const again = seen.notices[0];
  assert.strictEqual(again.title, 'Sorry, I did not follow. Is TEST DRIVER (Unit 7777) working for us right now?');
  assert.match(again.lines[0], /working · not working · later/);
  assert.deepStrictEqual(again.question.prompt, notice.question.prompt, 'the follow-up keeps the question');
  assert.doesNotMatch(again.title, /yes, no/);
});

test('6. a question asked before this change is still read against its own text', () => {
  assert.deepStrictEqual(
    promptOf({ question: {}, body: '<b>Is it?</b>\nRef Q-1' }),
    { ask: 'Is it? Ref Q-1', lines: [] }
  );
});
