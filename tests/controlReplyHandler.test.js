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
    aiReads: [], clarifications: [], remembered: [], requests: [],
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
          question: {
            findingId: 11,
            offeredActions: [
              { key: 'approve', label: 'yes' },
              { key: 'dismiss', label: 'no (say why)' },
              { key: 'snooze', label: 'later' },
            ],
          },
        };
      },
      markNoticeAnswered: async (id, replyId) => { calls.answered.push([id, replyId]); return true; },
    },
    findings: {
      getFindingById: async () => ({ id: 11, status: 'open', checkKey: 'identity.stale_unit_assignment' }),
    },
    parseIntent: require('../lib/control/intent').parseIntent,
    // NO MODEL IN THE TEST SUITE. The stub records that it was reached and says
    // it did not understand either, so every assertion below is about the
    // deterministic path and the clarification loop, never about a provider.
    readReplyWithAi: async (text, opts) => {
      calls.aiReads.push({ text, offered: opts.offered });
      return { intent: 'unclear', action: null, reason: null, snoozeHours: null, remember: false };
    },
    notify: async (notice) => { calls.clarifications.push(notice); return { recorded: true }; },
    rememberAnswerFor: async (args) => { calls.remembered.push(args); return { id: 9 }; },
    fileRequest: async (args) => {
      calls.requests.push(args);
      return { request: { id: 12, ...args }, created: true };
    },
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

test('an unclear reply reaches the model, then asks again as a REPLYABLE question', async () => {
  const deps = makeDeps();
  const got = await handleControlReply({ ...REPLY, text: 'hmm' }, deps);
  assert.strictEqual(got.outcome, 'clarified');
  assert.strictEqual(deps.calls.executed.length, 0);
  assert.strictEqual(deps.calls.aiReads.length, 1, 'the model is the second reader');
  assert.deepStrictEqual(
    deps.calls.aiReads[0].offered.map((o) => o.key), ['approve', 'dismiss', 'snooze'],
    'it may only pick from what the question offered',
  );

  // A CLARIFICATION GOES OUT AS A NOTICE, not as a plain acknowledgement. The
  // reply path only recognises an answer to a message carrying a question, so a
  // bare "I did not follow that" would be a dead end and the owner's next
  // sentence would be read as ordinary chatter and lost.
  const [clarification] = deps.calls.clarifications;
  assert.ok(clarification, 'a follow-up question was sent');
  assert.match(clarification.lines.join(' '), /yes.*no.*later/i);
  assert.strictEqual(clarification.parentNoticeId, 3);
  // The subject is the REPLY, so the burst suppressor cannot hold a follow-up
  // behind the question it is following up on.
  assert.strictEqual(clarification.subjectType, 'control_reply');
  assert.strictEqual(clarification.clarifyRound, 1);
  assert.deepStrictEqual(
    clarification.question.offeredActions.map((o) => o.key), ['approve', 'dismiss', 'snooze'],
  );
  assert.strictEqual(clarification.inReplyTo.chatId, REPLY.chatId,
    'it is pinned under the message they just sent');
});

test('the clarification loop is bounded — a second unclear reply stands down', async () => {
  const deps = makeDeps({
    notices: {
      findNoticeByTelegramMessage: async () => ({
        id: 4, findingId: 11, clarifyRound: 1,
        question: { findingId: 11, offeredActions: [{ key: 'dismiss' }, { key: 'snooze' }] },
      }),
      markNoticeAnswered: async () => true,
    },
  });
  const got = await handleControlReply({ ...REPLY, text: 'hmm' }, deps);
  assert.strictEqual(got.outcome, 'clarified');
  assert.strictEqual(deps.calls.clarifications.length, 0, 'no third question');
  assert.match(deps.calls.acks[0].text, /leaving it open/i);
});

test('a bare "no" is asked why once, and nothing is dismissed yet', async () => {
  const deps = makeDeps();
  const got = await handleControlReply({ ...REPLY, text: 'no' }, deps);
  assert.strictEqual(got.outcome, 'clarified');
  assert.strictEqual(deps.calls.executed.length, 0, 'nothing was closed on a reasonless no');
  assert.match(deps.calls.clarifications[0].title, /why/i);
});

test('a "no" WITH a reason is carried out and remembered', async () => {
  const deps = makeDeps({
    executeOffered: async () => ({
      outcome: 'dismissed', message: 'Closed. I will not raise it again.',
    }),
  });
  const got = await handleControlReply(
    { ...REPLY, text: 'no, he is a team driver' }, deps
  );
  assert.strictEqual(got.outcome, 'dismissed');
  assert.strictEqual(got.remembered, true);
  assert.strictEqual(deps.calls.remembered.length, 1);
  assert.strictEqual(deps.calls.remembered[0].intent.action, 'dismiss');
  assert.match(deps.calls.acks[0].text, /noted/i);
});

test('a plain "yes" is NOT remembered — one approval is not a standing permission', async () => {
  const deps = makeDeps();
  const got = await handleControlReply(REPLY, deps);
  assert.strictEqual(got.outcome, 'applied');
  assert.strictEqual(deps.calls.remembered.length, 0);
});

test('"yes, always" IS recorded — but the record is never acted on by itself', async () => {
  const deps = makeDeps();
  await handleControlReply({ ...REPLY, text: 'yes, always' }, deps);
  assert.strictEqual(deps.calls.remembered.length, 1);
  assert.strictEqual(deps.calls.remembered[0].intent.action, 'approve');
  // The guarantee itself lives in lib/control/fingerprint.js and is asserted in
  // tests/controlFingerprint.test.js; this only proves the approval is stored.
  const { actsFromMemory } = require('../lib/control/fingerprint');
  assert.strictEqual(actsFromMemory('approve'), false);
});

test('A COMPLAINT ABOUT THE SOFTWARE BECOMES A ROW FOR A PERSON, AND ONLY A ROW', async () => {
  const deps = makeDeps();
  const got = await handleControlReply({ ...REPLY, text: 'this is a bug' }, deps);
  assert.strictEqual(got.outcome, 'engineering_request');
  assert.strictEqual(deps.calls.executed.length, 0, 'nothing was applied to the fleet');
  assert.strictEqual(deps.calls.requests.length, 1);
  assert.strictEqual(deps.calls.requests[0].source, 'control_reply');
  assert.strictEqual(deps.calls.requests[0].requestedBy, 'telegram:2117922421');
  assert.strictEqual(deps.calls.requests[0].requestText, 'this is a bug');
  // The number is the point: without it the owner has no way to see it went
  // anywhere, and "noted" reads like being humoured.
  assert.match(deps.calls.acks[0].text, /#12/);
  assert.match(deps.calls.acks[0].text, /nothing in the system changed/i);
});

test('a request that could not be filed still gets an honest answer', async () => {
  const deps = makeDeps({ fileRequest: async () => { throw new Error('table missing'); } });
  const got = await handleControlReply({ ...REPLY, text: 'this is a bug' }, deps);
  assert.strictEqual(got.outcome, 'engineering_request');
  assert.match(deps.calls.acks[0].text, /nothing in the system changed/i);
  assert.ok(!/#/.test(deps.calls.acks[0].text), 'and does not invent a number');
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

test('a clarification that could not be sent is said in the thread instead', async () => {
  // A follow-up nobody receives is silence, and silence looks exactly like Wenze
  // ignoring the owner.
  const deps = makeDeps({ notify: async () => ({ recorded: false, reason: 'no_destination' }) });
  const got = await handleControlReply({ ...REPLY, text: 'hmm' }, deps);
  assert.strictEqual(got.outcome, 'clarified');
  assert.match(deps.calls.acks[0].text, /did not follow/i);
});

/**
 * The clarification conversation, end to end — the half that only shows up when
 * the second message is treated as an answer to the first.
 */
function afterWhy(over = {}) {
  const deps = makeDeps({
    executeOffered: async () => ({ outcome: 'dismissed', message: 'Closed.' }),
    ...over,
  });
  // The notice the owner is replying to now IS Wenze's "why?", and it says what
  // it was asking for. Patched after `makeDeps` so the recorder is the deps'
  // own, not an empty object.
  deps.notices = {
    findNoticeByTelegramMessage: async () => ({
      id: 9, findingId: 11, clarifyRound: 1, parentNoticeId: 3,
      question: {
        findingId: 11,
        offeredActions: [
          { key: 'approve', label: 'yes' },
          { key: 'dismiss', label: 'no (say why)' },
          { key: 'snooze', label: 'later' },
        ],
        pending: { action: 'dismiss' },
      },
    }),
    markNoticeAnswered: async (id, replyId) => {
      deps.calls.answered.push([id, replyId]);
      return true;
    },
  };
  return deps;
}

test('THE ANSWER TO "WHY?" IS THE REASON — not an unclear reply', async () => {
  // With no model at all, "he is a team driver" matches none of the yes/no/later
  // rules. Treated as unclear it would stand down at the clarify limit and the
  // finding would stay open, having asked the owner for a reason and then
  // thrown it away.
  const deps = afterWhy();
  const got = await handleControlReply(
    { ...REPLY, text: 'he is a team driver, the truck is shared' }, deps
  );
  assert.strictEqual(got.outcome, 'dismissed');
  assert.strictEqual(deps.calls.clarifications.length, 0, 'it did not ask a third time');
  assert.strictEqual(deps.calls.remembered.length, 1);
  assert.match(deps.calls.remembered[0].intent.reason, /team driver/);
});

test('THE QUESTION THAT STARTED THE CHAIN IS CLOSED TOO', async () => {
  // Every unanswered notice carrying a question counts against the standing
  // cap. A clarification answered while its parent stayed open burns a slot for
  // the whole repeat window; five of those and the ask pass sends nothing.
  const deps = afterWhy();
  await handleControlReply({ ...REPLY, text: 'he is a team driver' }, deps);
  const marked = deps.calls.answered.map(([id]) => id).sort();
  assert.deepStrictEqual(marked, [3, 9], 'the clarification AND the original question');
});

test('a clarification points at the ROOT, so a chain of any depth closes in two marks', async () => {
  const deps = makeDeps({
    notices: {
      findNoticeByTelegramMessage: async () => ({
        id: 9, findingId: 11, clarifyRound: 0, parentNoticeId: 3,
        question: {
          findingId: 11,
          offeredActions: [{ key: 'dismiss', label: 'no (say why)' }, { key: 'snooze', label: 'later' }],
        },
      }),
      markNoticeAnswered: async () => true,
    },
  });
  await handleControlReply({ ...REPLY, text: 'hmm' }, deps);
  assert.strictEqual(deps.calls.clarifications[0].parentNoticeId, 3,
    'not 9 — the chain stays two deep however long the conversation runs');
});
