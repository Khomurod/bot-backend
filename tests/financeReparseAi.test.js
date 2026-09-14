'use strict';

/**
 * The model's turn — and the fence around it.
 *
 * THE ONE PROPERTY THIS FILE EXISTS FOR: a reading a model produced may move a
 * message off the unclear pile and may hand a code to a person. It may never
 * void one. Voiding is an automatic action against money, and the invariant is
 * that AI interprets evidence and never manufactures the evidence an automatic
 * action needs. So an AI-read void becomes `needs_review`, and the test that
 * matters is the one asserting `voidCode` was not called.
 *
 * SECOND PROPERTY: an attempt is burned only when something actually answered.
 * A provider on cooldown, or a capability switched off, must not cost a message
 * the single reading it is allowed — otherwise one bad afternoon silently
 * consumes the whole backlog.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { offerToModel, MIN_AI_CONFIDENCE } = require('../services/finance/reparsePass');
const { AI_KIND } = require('../lib/finance/aiReading');

function harness({ waiting = [], interpret } = {}) {
  const calls = { markAiRead: [], voidCode: [], needsReview: [], lookedUp: [], statuses: [], codes: [] };
  const deps = {
    messages: {
      listMessagesAwaitingAiReading: async () => waiting,
      markAiRead: async (id) => { calls.markAiRead.push(id); },
      setMessageStatus: async (id, status, detail) => { calls.statuses.push({ id, status, detail }); },
      recordMoneycode: async (...a) => { calls.codes.push(a); return 1; },
    },
    lifecycle: {
      findCodeByDigits: async (digits) => {
        calls.lookedUp.push(digits);
        return digits === '1491583146' ? { id: 77, codeNormalized: digits, status: 'active' } : null;
      },
      voidCode: async (...args) => { calls.voidCode.push(args); return { changed: true }; },
      markReplaced: async () => { throw new Error('a model may not record a replacement'); },
      markNeedsReview: async (id, reason, opts) => {
        calls.needsReview.push({ id, reason, opts });
        return { changed: true };
      },
    },
    interpret,
  };
  const summary = { aiRead: 0, aiRefused: 0, aiFlagged: 0, errors: [] };
  return { deps, summary, calls };
}

const MESSAGE = { id: 5, text: 'voided 1491583146', parseStatus: 'ambiguous' };

test('AN AI-READ VOID NEVER VOIDS: it hands the code to a person', async () => {
  const { deps, summary, calls } = harness({
    waiting: [MESSAGE],
    interpret: async () => ({
      used: true,
      reading: { kind: AI_KIND.VOID_COMPLETED, referencesCode: '1491583146', confidence: 90, dropped: [] },
    }),
  });

  await offerToModel(summary, deps);

  assert.equal(calls.voidCode.length, 0, 'the model did not void anything');
  assert.equal(calls.needsReview.length, 1);
  assert.equal(calls.needsReview[0].id, 77);
  assert.equal(calls.needsReview[0].opts.decidedBy, 'ai',
    'and the record says a model was involved');
  assert.equal(summary.aiFlagged, 1);
  assert.equal(summary.aiRead, 1);
});

test('a code the model names but we do not hold changes nothing', async () => {
  const { deps, summary, calls } = harness({
    waiting: [MESSAGE],
    interpret: async () => ({
      used: true,
      reading: { kind: AI_KIND.VOID_COMPLETED, referencesCode: '5550001111', confidence: 95, dropped: [] },
    }),
  });

  await offerToModel(summary, deps);

  assert.deepEqual(calls.lookedUp, ['5550001111']);
  assert.equal(calls.needsReview.length, 0, 'nothing is invented to attach the doubt to');
  assert.equal(summary.aiFlagged, 0);
});

test('a reading below the confidence floor is read and then ignored', async () => {
  const { deps, summary, calls } = harness({
    waiting: [MESSAGE],
    interpret: async () => ({
      used: true,
      reading: {
        kind: AI_KIND.VOID_COMPLETED, referencesCode: '1491583146',
        confidence: MIN_AI_CONFIDENCE - 1, dropped: [],
      },
    }),
  });

  await offerToModel(summary, deps);

  assert.equal(calls.needsReview.length, 0);
  assert.deepEqual(calls.markAiRead, [5], 'it still had its turn');
});

test('NO PROVIDER MEANS NO ATTEMPT SPENT', async () => {
  const { deps, summary, calls } = harness({
    waiting: [MESSAGE],
    interpret: async () => ({ used: false, reason: 'no reading available' }),
  });

  await offerToModel(summary, deps);

  assert.deepEqual(calls.markAiRead, [], 'the message keeps its one chance for later');
  assert.equal(summary.aiRead, 0);
  assert.equal(summary.aiRefused, 0);
});

test('a capability switched off also costs nothing', async () => {
  const { deps, summary, calls } = harness({
    waiting: [MESSAGE],
    interpret: async () => ({ used: false, reason: 'finance message reading is switched off' }),
  });
  await offerToModel(summary, deps);
  assert.deepEqual(calls.markAiRead, []);
});

test('a refused reading IS spent, so a message cannot be offered forever', async () => {
  const { deps, summary, calls } = harness({
    waiting: [MESSAGE],
    interpret: async () => ({ used: false, reason: 'the reading named a code that is not in the message' }),
  });

  await offerToModel(summary, deps);

  assert.deepEqual(calls.markAiRead, [5]);
  assert.equal(summary.aiRefused, 1);
});

test('a replacement the model claims is flagged, never recorded as a replacement', async () => {
  const { deps, summary, calls } = harness({
    waiting: [{ id: 6, text: 'reissued', parseStatus: 'ambiguous' }],
    interpret: async () => ({
      used: true,
      reading: {
        kind: AI_KIND.REPLACEMENT, referencesCode: '1491583146',
        code: '2288341907', confidence: 92, dropped: [],
      },
    }),
  });

  // `markReplaced` throws in the harness: reaching it at all is the failure.
  await offerToModel(summary, deps);

  assert.equal(calls.needsReview.length, 1);
  assert.match(calls.needsReview[0].reason, /a person confirms it/);
  assert.equal(summary.aiFlagged, 1);
});

test('a model that throws costs one message, not the pass', async () => {
  const { deps, summary } = harness({
    waiting: [MESSAGE, { id: 6, text: 'voided 1491583146', parseStatus: 'ambiguous' }],
    interpret: async (row) => {
      if (row.text === MESSAGE.text && summary.errors.length === 0) throw new Error('boom');
      return { used: true, reading: { kind: AI_KIND.UNRELATED, confidence: 99, dropped: [] } };
    },
  });

  await offerToModel(summary, deps);

  assert.equal(summary.errors.length, 1);
  assert.match(summary.errors[0], /ai 5: boom/);
  assert.equal(summary.aiRead, 1, 'the second message was still offered');
});

/**
 * A READING THAT WAS PAID FOR IS WRITTEN DOWN.
 *
 * A message gets exactly one model attempt. Spending it and then discarding
 * everything but `void_completed` and `replacement` left the message on the
 * same unclear pile, ineligible for another try, with nothing to show for the
 * call — true for four of the six kinds a model may return.
 */
test('every verified reading is stored, whatever kind it is', async () => {
  const { deps, summary, calls } = harness({
    waiting: [{ id: 9, text: 'EFS 1491583146 480.00', parseStatus: 'ambiguous' }],
    interpret: async () => ({
      used: true,
      reading: {
        kind: AI_KIND.ISSUE, code: '1491583146', amount: 480,
        referencesCode: null, issuedTo: null, confidence: 88, dropped: [],
      },
    }),
  });

  await offerToModel(summary, deps);

  assert.equal(calls.statuses.length, 1, 'the reading reached the message');
  assert.equal(calls.statuses[0].status, 'needs_review',
    'a model saying "this issues a code" is work for a person, not a money row');
  assert.equal(calls.statuses[0].detail.read, AI_KIND.ISSUE);
  assert.equal(calls.statuses[0].detail.code, '1491583146');
  assert.deepEqual(calls.codes, [], 'and no money row is written from a reading');
});

test('an UNRELATED reading is stored without moving the message', async () => {
  const { deps, summary, calls } = harness({
    waiting: [{ id: 10, text: 'lunch?', parseStatus: 'unparsed' }],
    interpret: async () => ({
      used: true,
      reading: { kind: AI_KIND.UNRELATED, confidence: 95, dropped: [] },
    }),
  });

  await offerToModel(summary, deps);

  assert.equal(calls.statuses.length, 1);
  assert.equal(calls.statuses[0].status, 'unparsed',
    'the rules keep the status; only the reading is added beside it');
  assert.equal(calls.statuses[0].detail.read, AI_KIND.UNRELATED);
});

test('a reading below the floor is not stored either', async () => {
  const { deps, summary, calls } = harness({
    waiting: [{ id: 11, text: 'EFS something', parseStatus: 'ambiguous' }],
    interpret: async () => ({
      used: true,
      reading: { kind: AI_KIND.ISSUE, code: null, confidence: 10, dropped: [] },
    }),
  });
  await offerToModel(summary, deps);
  assert.deepEqual(calls.statuses, []);
});
