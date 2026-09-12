'use strict';

/**
 * The gates, each proved by what it refuses.
 *
 * The five that matter, and the failure each prevents:
 *   a reply in the wrong place costs no database read at all;
 *   a stranger's reply is recorded and never answered;
 *   a redelivered reply never applies anything twice;
 *   a finding somebody already fixed is not fixed again;
 *   a switched-off channel is silent rather than refusing out loud.
 */
const test = require('node:test');
const assert = require('node:assert');

const { handleControlReply } = require('../services/control/replyHandler');

function makeDeps(overrides = {}) {
  const calls = {
    noticeLookups: 0, recorded: [], finalised: [], acks: [], executed: [], answered: [],
  };
  const deps = {
    calls,
    settings: { getControlSettings: async () => ({ enabled: true, clarifyLimit: 1 }) },
    operators: { isControlOperator: async () => true },
    replies: {
      recordReply: async (row) => { calls.recorded.push(row); return { id: 7, ...row }; },
      finaliseReply: async (id, patch) => { calls.finalised.push({ id, ...patch }); return { id }; },
    },
    notices: {
      findNoticeByTelegramMessage: async () => {
        calls.noticeLookups += 1;
        return {
          id: 3, findingId: 11,
          question: { findingId: 11, offeredActions: [{ key: 'approve' }, { key: 'dismiss' }, { key: 'snooze' }] },
        };
      },
      markNoticeAnswered: async (id, replyId) => { calls.answered.push([id, replyId]); return true; },
    },
    findings: {
      getFindingById: async () => ({ id: 11, status: 'open', checkKey: 'identity.stale_unit_assignment' }),
    },
    parseIntent: require('../lib/control/intent').parseIntent,
    executeOffered: async (args) => {
      calls.executed.push(args);
      return { outcome: 'applied', message: 'Done.', correctionId: 55, decisionId: 66 };
    },
    ack: async (a) => { calls.acks.push(a); },
  };
  return { ...deps, ...overrides, calls };
}

const REPLY = {
  chatId: '-100123', chatType: 'supergroup', messageId: 500,
  repliedToMessageId: 400, text: 'yes', telegramUserId: '2117922421', fromIsBot: false,
};

test('a private chat is not the control channel, and costs no database read', async () => {
  const deps = makeDeps();
  const got = await handleControlReply({ ...REPLY, chatType: 'private' }, deps);
  assert.strictEqual(got.handled, false);
  assert.strictEqual(deps.calls.noticeLookups, 0, 'nothing was read');
});

test('an ordinary message that is not a reply costs no database read', async () => {
  const deps = makeDeps();
  const got = await handleControlReply({ ...REPLY, repliedToMessageId: null }, deps);
  assert.strictEqual(got.handled, false);
  assert.strictEqual(deps.calls.noticeLookups, 0);
});

test('a reply to something we did not send is not ours', async () => {
  const deps = makeDeps({
    notices: { findNoticeByTelegramMessage: async () => null, markNoticeAnswered: async () => true },
  });
  const got = await handleControlReply(REPLY, deps);
  assert.strictEqual(got.handled, false);
  assert.strictEqual(got.reason, 'not_a_question');
  assert.strictEqual(deps.calls.recorded.length, 0);
});

test('a reply to a notice that asked nothing is not an answer', async () => {
  const deps = makeDeps({
    notices: {
      findNoticeByTelegramMessage: async () => ({ id: 3, findingId: 11, question: null }),
      markNoticeAnswered: async () => true,
    },
  });
  const got = await handleControlReply(REPLY, deps);
  assert.strictEqual(got.handled, false);
});

test('SWITCHED OFF IS SILENT — recorded, never answered', async () => {
  const deps = makeDeps({
    settings: { getControlSettings: async () => ({ enabled: false }) },
  });
  const got = await handleControlReply(REPLY, deps);
  assert.strictEqual(got.outcome, 'ignored_disabled');
  assert.strictEqual(deps.calls.acks.length, 0, 'an off switch must not announce itself');
  assert.strictEqual(deps.calls.executed.length, 0);
});

test('A STRANGER IS RECORDED AND NEVER ANSWERED', async () => {
  const deps = makeDeps({ operators: { isControlOperator: async () => false } });
  const got = await handleControlReply(REPLY, deps);
  assert.strictEqual(got.outcome, 'ignored_unauthorised');
  assert.strictEqual(deps.calls.recorded[0].authorised, false);
  assert.strictEqual(deps.calls.recorded[0].outcome, 'ignored_unauthorised');
  assert.strictEqual(deps.calls.executed.length, 0, 'nothing was applied');
  assert.strictEqual(deps.calls.acks.length, 0, 'and they were not told their reply was read');
});

test('A REDELIVERED REPLY APPLIES NOTHING A SECOND TIME', async () => {
  const deps = makeDeps({
    replies: {
      // The claim lost: this exact reply is already recorded.
      recordReply: async () => null,
      finaliseReply: async () => null,
    },
  });
  const got = await handleControlReply(REPLY, deps);
  assert.strictEqual(got.outcome, 'redelivery');
  assert.strictEqual(deps.calls.executed.length, 0);
});

test('a finding somebody already fixed is not fixed again', async () => {
  const deps = makeDeps({
    findings: { getFindingById: async () => ({ id: 11, status: 'applied', checkKey: 'x' }) },
  });
  const got = await handleControlReply(REPLY, deps);
  assert.strictEqual(got.outcome, 'no_op');
  assert.strictEqual(deps.calls.executed.length, 0);
  assert.match(deps.calls.acks[0].text, /already/i);
});

test('yes applies, closes the question and answers in the thread', async () => {
  const deps = makeDeps();
  const got = await handleControlReply(REPLY, deps);
  assert.strictEqual(got.outcome, 'applied');
  assert.strictEqual(deps.calls.executed.length, 1);
  assert.deepStrictEqual(deps.calls.answered[0], [3, 7]);
  const finalised = deps.calls.finalised[0];
  assert.strictEqual(finalised.outcome, 'applied');
  assert.strictEqual(finalised.correctionId, 55);
  assert.strictEqual(finalised.decisionId, 66);
  assert.strictEqual(deps.calls.acks[0].inReplyToMessageId, 500, 'answered under their own message');
});

test('an unclear reply asks again rather than guessing', async () => {
  const deps = makeDeps();
  const got = await handleControlReply({ ...REPLY, text: 'hmm' }, deps);
  assert.strictEqual(got.outcome, 'clarified');
  assert.strictEqual(deps.calls.executed.length, 0);
  assert.match(deps.calls.acks[0].text, /yes.*no.*later/i);
});

test('a complaint about the question changes nothing and says so', async () => {
  const deps = makeDeps();
  const got = await handleControlReply({ ...REPLY, text: 'this is a bug' }, deps);
  assert.strictEqual(got.outcome, 'engineering_request');
  assert.strictEqual(deps.calls.executed.length, 0);
  assert.match(deps.calls.acks[0].text, /nothing in the system changed/i);
});

test('a failure anywhere below leaves the message to the rest of the pipeline', async () => {
  const deps = makeDeps({
    notices: {
      findNoticeByTelegramMessage: async () => { throw new Error('database is down'); },
      markNoticeAnswered: async () => true,
    },
  });
  const got = await handleControlReply(REPLY, deps);
  assert.strictEqual(got.handled, false, 'not handled, so the group pipeline still sees it');
});
