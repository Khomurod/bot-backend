'use strict';

/**
 * A change typed in the owner's own words (6 November 2026): a model may
 * PROPOSE a value, Wenze puts the exact change back as a question, and only the
 * owner's Yes to that change makes it. No model in this file — every reader is
 * a stub, so what is pinned is the catalogue, the question, and the writer.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { validateProposal, describeChange, correctionFor } = require('../lib/control/changeCatalogue');
const { readChangeWithAi } = require('../services/control/aiChange');
const { proposeChange, candidateGroupIds, MAX_CHANGE_ROUNDS } = require('../services/control/confirmChange');
const { handleControlReply } = require('../services/control/replyHandler');
const { executeOffered } = require('../services/control/actions');
const { isAskableFinding } = require('../services/control/askPass');
const { isAnswerableNotice } = require('../lib/control/askable');

const JOHN = {
  letter: 'A', groupId: 347484, groupName: 'WENZE UNIT # 01 JOHN / MARK',
  current: { unitNumber: '01', driverType: 'owner', truckFleet: 'owner_operator', truckOwner: 'RUDOLPH', status: 'active' },
};

test('the catalogue: one operation, on a chat that was offered, with a value that fits — or nothing', () => {
  const ok = validateProposal({ operation: 'set_unit', target: 'a', values: { unit_number: ' 1 ' } }, [JOHN]);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.change.values, { unitNumber: '1' });
  assert.equal(describeChange(ok.change), 'WENZE UNIT # 01 JOHN / MARK: unit 01 → 1');
  assert.deepEqual(correctionFor(ok.change), {
    actionKey: 'profile.set_unit', payload: { groupId: 347484, unitNumber: '1', from: '01' },
  });

  assert.match(validateProposal({ operation: 'drop_table', target: 'A', values: {} }, [JOHN]).reason, /not in the catalogue/);
  assert.match(validateProposal({ operation: 'set_unit', target: 'B', values: { unit_number: '1' } }, [JOHN]).reason, /not one of the chats/);
  assert.match(validateProposal({ operation: 'set_unit', target: 'A', values: { unit_number: '1; DROP' } }, [JOHN]).reason, /do not fit/);
  assert.match(validateProposal({ operation: 'set_unit', target: 'A', values: { unit_number: '01' } }, [JOHN]).reason, /already says/);
  assert.match(validateProposal({ operation: 'set_driver_type', target: 'A', values: { driver_type: 'boss' } }, [JOHN]).reason, /do not fit/);
  assert.equal(validateProposal({ operation: 'none' }, [JOHN]).ok, false);

  const truck = validateProposal({ operation: 'set_truck', target: 'A', values: { fleet: 'company', owner: 'RUDOLPH' } }, [JOHN]);
  assert.deepEqual(truck.change.values, { fleet: 'company', owner: null }, 'a company truck has no owner');

  // A stored change is validated again at the writer, never trusted.
  assert.equal(correctionFor({ ...ok.change, values: { unitNumber: 'x y' } }), null);
});

test('the reader: a proposal is checked as the router\'s validator AND again; failure is no proposal', async () => {
  let validator = null;
  const run = (answer) => async (args) => { validator = args.validate; return { parsed: answer }; };
  const got = await readChangeWithAi('правильно 1', { targets: [JOHN], run: run({ operation: 'set_unit', target: 'A', values: { unit_number: '1' } }) });
  assert.equal(got.change.groupId, 347484);
  assert.equal(validator('', { operation: 'set_unit', target: 'Z', values: { unit_number: '1' } }).message.includes('not one of the chats'), true);

  assert.equal((await readChangeWithAi('ok', { targets: [JOHN], run: run({ operation: 'none' }) })).change, null);
  assert.equal((await readChangeWithAi('it is 7', { targets: [JOHN], run: run({ operation: 'set_unit', target: 'A', values: { unit_number: 'seven' } }) })).change, null);
  assert.equal((await readChangeWithAi('x', { targets: [], run: run({}) })).change, null, 'no chat, no proposal');
  const down = await readChangeWithAi('it is 1', { targets: [JOHN], run: async () => { throw new Error('down'); } });
  assert.equal(down.change, null);
});

test('which chats a finding lets a change touch: its own, its evidence\'s, where the board check found the driver', () => {
  assert.deepEqual(candidateGroupIds({ subjectType: 'group', subjectId: '60', evidence: { groupId: 60 } }), [60]);
  assert.deepEqual(candidateGroupIds({
    subjectType: 'board_truck', subjectId: '1 RUDOLPH',
    evidence: { wenzeElsewhere: [{ groupId: 347484 }, { groupId: 1109 }] },
  }), [347484, 1109]);
});

function confirmDeps(overrides = {}) {
  const sent = [];
  return {
    sent,
    notify: async (n) => { sent.push(n); return { recorded: true }; },
    changeTargets: async () => [JOHN],
    readChangeWithAi: async () => ({ change: validateProposal({ operation: 'set_unit', target: 'A', values: { unit_number: '1' } }, [JOHN]).change }),
    ...overrides,
  };
}

test('"Did I understand you right?" — the exact change on its Yes; No means "you misread me"; the title is said', async () => {
  const deps = confirmDeps();
  const notice = { id: 3, findingId: 11, question: { prompt: { ask: 'Original?', lines: [] }, offeredActions: [] } };
  const got = await proposeChange({
    reply: { chatId: '-1', messageId: 9 }, notice, finding: { id: 11 }, text: 'правильно 1', prompt: notice.question.prompt,
  }, deps);
  assert.match(got.message, /Did I understand you right\? WENZE UNIT # 01 JOHN \/ MARK: unit 01 → 1/);
  const q = deps.sent[0].question;
  assert.equal(q.offeredActions[0].key, 'approve');
  assert.equal(q.offeredActions[0].change.values.unitNumber, '1');
  assert.deepEqual(q.offeredActions[1], { key: 'dismiss', label: 'no', rejectsChange: true });
  assert.deepEqual(q.pending, { kind: 'confirm_change', changeRound: 1 });
  assert.deepEqual(q.prompt, { ask: 'Original?', lines: [] }, 'a reply to it is read against the original question');
  assert.ok(deps.sent[0].lines.some((l) => /chat title still says 01/.test(l)));

  const tired = await proposeChange({
    reply: { chatId: '-1', messageId: 9 }, notice: { ...notice, question: { ...notice.question, pending: { changeRound: MAX_CHANGE_ROUNDS } } }, finding: { id: 11 }, text: 'x',
  }, confirmDeps());
  assert.equal(tired, null, 'at most two proposals in one conversation');
});

function replyDeps({ question, text, readChange }) {
  const calls = { finalised: [], executed: [], acks: [], notices: [] };
  return {
    calls,
    deps: {
      settings: { getControlSettings: async () => ({ enabled: true, clarifyLimit: 1 }) },
      operators: { isControlOperator: async () => true },
      replies: {
        recordReply: async (row) => ({ id: 7, ...row }),
        finaliseReply: async (id, patch) => { calls.finalised.push(patch); },
      },
      notices: {
        findNoticeByTelegramMessage: async () => ({ id: 3, findingId: 11, question }),
        markNoticeAnswered: async () => true,
      },
      findings: { getFindingById: async () => ({ id: 11, status: 'open', checkKey: 'fleet.driver_not_in_wenze', evidence: {} }) },
      parseIntent: require('../lib/control/intent').parseIntent,
      readReplyWithAi: async () => ({ intent: 'unclear', action: null, reason: null, remember: false }),
      readChangeWithAi: readChange,
      proposeChange,
      changeTargets: async () => [JOHN],
      notify: async (n) => { calls.notices.push(n); return { recorded: true }; },
      rememberAnswerFor: async () => null,
      fileRequest: async () => ({ request: { id: 1 } }),
      executeOffered: async (args) => { calls.executed.push(args); return { outcome: args.intent.action === 'dismiss' ? 'no_op' : 'applied', message: 'ok' }; },
      ack: async (a) => { calls.acks.push(a.text); },
    },
    reply: {
      chatId: '-100', chatType: 'supergroup', messageId: 500, repliedToMessageId: 400, text, telegramUserId: '1', fromIsBot: false,
    },
  };
}

const NOTICE_Q = { findingId: 11, offeredActions: [{ key: 'dismiss', label: 'no (say why)' }, { key: 'snooze', label: 'later' }], prompt: { ask: 'What is right?', lines: [] } };

test('a typed correction to a question becomes a "did I understand you right?", and nothing is changed yet', async () => {
  const { deps, reply, calls } = replyDeps({
    question: NOTICE_Q, text: 'это 01, на доске ошибка — правильно 1',
    readChange: async () => ({ change: validateProposal({ operation: 'set_unit', target: 'A', values: { unit_number: '1' } }, [JOHN]).change }),
  });
  const got = await handleControlReply(reply, deps);
  assert.equal(got.outcome, 'clarified');
  assert.equal(got.proposed, true);
  assert.equal(calls.executed.length, 0, 'nothing written before the Yes');
  assert.equal(calls.notices[0].question.pending.kind, 'confirm_change');
});

test('a plain "no, because …" with no change in it closes as before', async () => {
  const { deps, reply, calls } = replyDeps({
    question: NOTICE_Q, text: 'no, the dispatcher will fix the board', readChange: async () => ({ change: null }),
  });
  await handleControlReply(reply, deps);
  assert.equal(calls.executed.length, 1);
  assert.equal(calls.executed[0].intent.action, 'dismiss');
});

test('to "did I understand you right?": yes applies the stored change; a bare no asks no "why?"', async () => {
  const change = validateProposal({ operation: 'set_unit', target: 'A', values: { unit_number: '1' } }, [JOHN]).change;
  const confirmQ = {
    findingId: 11,
    offeredActions: [{ key: 'approve', label: 'yes', change }, { key: 'dismiss', label: 'no', rejectsChange: true }, { key: 'snooze', label: 'later' }],
    pending: { kind: 'confirm_change', changeRound: 1 },
    prompt: NOTICE_Q.prompt,
  };
  const yes = replyDeps({ question: confirmQ, text: 'да', readChange: async () => ({ change: null }) });
  await handleControlReply(yes.reply, yes.deps);
  assert.equal(yes.calls.executed[0].intent.action, 'approve');

  const no = replyDeps({ question: confirmQ, text: 'no', readChange: async () => ({ change: null }) });
  await handleControlReply(no.reply, no.deps);
  assert.equal(no.calls.executed[0].intent.action, 'dismiss');
  assert.equal(no.calls.notices.length, 0, 'no "why?" — no here means "you misread me"');
});

test('the writer: the stored change goes through the registry as the owner, leaving the finding for the sweep', async () => {
  const change = validateProposal({ operation: 'set_unit', target: 'A', values: { unit_number: '1' } }, [JOHN]).change;
  const applied = [];
  const snoozed = [];
  const deps = {
    applyCorrection: async (args) => { applied.push(args); return { id: 501 }; },
    StaleCorrectionError: class extends Error {},
    findings: { snoozeFinding: async (id, until) => { snoozed.push({ id, until }); }, dismissFinding: async () => { throw new Error('must not dismiss'); } },
    takeDecision: async () => ({ id: 77, acted: async () => {} }),
    payloadFor: () => null,
    actionForCheck: () => null,
    choiceActionFor: () => null,
    getAction: require('../services/operations/corrections/actions').getAction,
  };
  const question = { offeredActions: [{ key: 'approve', label: 'yes', change }, { key: 'dismiss', label: 'no', rejectsChange: true }] };
  const finding = { id: 11, checkKey: 'fleet.driver_not_in_wenze', subjectType: 'board_truck', subjectId: '1 RUDOLPH', evidence: {} };
  const got = await executeOffered({ question, finding, intent: { action: 'approve' }, telegramUserId: '42' }, deps);
  assert.equal(got.outcome, 'applied');
  assert.match(got.message, /unit 01 → 1/);
  assert.equal(applied[0].actionKey, 'profile.set_unit');
  assert.deepEqual(applied[0].payload, { groupId: 347484, unitNumber: '1', from: '01' });
  assert.deepEqual(applied[0].admin, { telegramUserId: '42' });
  assert.equal(applied[0].markFinding, false, 'whether it settled the question is the next sweep\'s to say');
  assert.equal(snoozed.length, 1);

  const rejected = await executeOffered({ question, finding, intent: { action: 'dismiss' }, telegramUserId: '42' }, deps);
  assert.equal(rejected.outcome, 'no_op', 'no to the change closes nothing');
});

test('a warning is put to the owner only when its wording says it is answerable', () => {
  const open = { status: 'open', tier: 'warning' };
  assert.equal(isAnswerableNotice('fleet.driver_not_in_wenze'), true);
  assert.equal(isAnswerableNotice('identity.duplicate_unit'), false);
  assert.equal(isAskableFinding(open, { hasAction: false, answerable: true }), true);
  assert.equal(isAskableFinding(open, { hasAction: false, answerable: false }), false);
});

test('"да" and "нет" are read with no model, like "yes" and "no" — a confirmation must not need one', () => {
  const { parseIntent } = require('../lib/control/intent');
  const offered = { offered: [{ key: 'approve' }, { key: 'dismiss' }, { key: 'snooze' }] };
  assert.equal(parseIntent('да', offered).intent, 'approve');
  assert.equal(parseIntent('Ha', offered).intent, 'approve');
  assert.deepEqual([parseIntent('нет', offered).intent, parseIntent('нет', offered).reason], ['dismiss', null], 'a bare no has no reason');
  assert.equal(parseIntent('нет, правильно 01', offered).reason, 'правильно 01');
  assert.equal(parseIntent("yo'q", offered).intent, 'dismiss');
  assert.equal(parseIntent('данные неверные', offered).intent, 'unclear', 'a word that starts with да is not yes');
});
