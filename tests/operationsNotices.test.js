/**
 * Saying what Wenze fixed by itself.
 *
 * The correction engine has been changing records in the background since Phase
 * 3, audited and revertible, and completely silently. "The software corrected
 * it" is only trustworthy if you find out it happened.
 *
 * The two failure modes are opposite and both real: saying nothing, and saying
 * the same thing every twelve minutes until nobody reads any of it.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { announceCorrections, SUMMARY_THRESHOLD } = require('../services/operations/correctionNotices');
const { describeCorrection, isLabelledAction } = require('../lib/operations/correctionLabels');
const { ACTIONS } = require('../services/operations/corrections/actions');

function harness({ delivered = true } = {}) {
  const sent = [];
  const deps = {
    async notify(n) { sent.push(n); return { recorded: true, delivered }; },
  };
  return { deps, sent };
}

const ONE = {
  correctionId: 91, findingId: 7, actionKey: 'home_time.mark_returned_to_road',
  subjectType: 'group', subjectId: '310',
};

// ── every action can be described ────────────────────────────────────────────

test('EVERY registered action has a written description', () => {
  const missing = [...ACTIONS.keys()].filter((k) => !isLabelledAction(k));
  assert.deepEqual(missing, [],
    'a new correction that ships unlabelled announces itself as a key nobody can read');
});

test('a description says what was DONE, in the past tense, not what was wrong', () => {
  for (const key of ACTIONS.keys()) {
    const { did } = describeCorrection(key);
    assert.ok(did.length > 12, `${key}: too terse to be a sentence`);
    assert.equal(did.includes('_'), false, `${key}: reads as English, not a key`);
    assert.match(did, /^[A-Z]/, `${key}: starts as a sentence`);
  }
});

test('an unknown action still produces something readable rather than silence', () => {
  const out = describeCorrection('future.action');
  assert.match(out.did, /future\.action/);
  assert.equal(out.why, null);
});

// ── one notice per correction ────────────────────────────────────────────────

test('a single correction is announced with what it did and how to undo it', async () => {
  const { deps, sent } = harness();
  const out = await announceCorrections([ONE], deps);
  assert.deepEqual(out, { sent: 1, skipped: 0 });
  assert.equal(sent[0].category, 'automatic_corrections');
  assert.equal(sent[0].title, 'Moved a driver back to Road');
  assert.match(sent[0].action, /Undo it/);
  assert.match(sent[0].lines[0], /group 310/);
});

test('the CORRECTION id is the key, so a re-derived finding cannot re-announce', async () => {
  const { deps, sent } = harness();
  await announceCorrections([ONE], deps);
  assert.equal(sent[0].subjectType, 'correction');
  assert.equal(sent[0].subjectId, '91',
    'keyed on the finding, the same problem found again would announce the old fix');
});

test('the evidence records which action and which finding, for the audit trail', async () => {
  const { deps, sent } = harness();
  await announceCorrections([ONE], deps);
  assert.deepEqual(sent[0].evidence, {
    actionKey: 'home_time.mark_returned_to_road', findingId: 7,
  });
});

// ── a batch is one message ───────────────────────────────────────────────────

test(`more than ${SUMMARY_THRESHOLD} in one pass becomes a single summary`, async () => {
  const { deps, sent } = harness();
  const many = Array.from({ length: 9 }, (_, i) => ({
    ...ONE, correctionId: 100 + i,
    actionKey: i < 6 ? 'home_time.close_cycle' : 'identity.sync_unit',
  }));
  const out = await announceCorrections(many, deps);

  assert.equal(sent.length, 1, 'nine separate messages is noise nobody reads');
  assert.equal(out.sent, 1);
  assert.match(sent[0].title, /corrected 9 things/);
  assert.match(sent[0].lines[0], /^6 × closed a home stay/, 'the commonest first');
  assert.match(sent[0].lines[1], /^3 × recorded a driver/);
  assert.match(sent[0].action, /History/);
});

test('a summary is keyed on the pass, so re-running it says nothing new', async () => {
  const { deps, sent } = harness();
  const many = Array.from({ length: 6 }, (_, i) => ({ ...ONE, correctionId: 200 + i }));
  await announceCorrections(many, deps);
  assert.equal(sent[0].subjectId, '205', 'the highest id in the batch names this pass');
});

test('exactly at the threshold each one still gets its own message', async () => {
  const { deps, sent } = harness();
  const rows = Array.from({ length: SUMMARY_THRESHOLD }, (_, i) => ({ ...ONE, correctionId: 300 + i }));
  await announceCorrections(rows, deps);
  assert.equal(sent.length, SUMMARY_THRESHOLD);
});

// ── it never touches the correction itself ───────────────────────────────────

test('nothing to announce is a clean, silent pass', async () => {
  const { deps, sent } = harness();
  assert.deepEqual(await announceCorrections([], deps), { sent: 0, skipped: 0 });
  assert.deepEqual(await announceCorrections(undefined, deps), { sent: 0, skipped: 0 });
  assert.equal(sent.length, 0);
});

test('a half-formed result row is skipped rather than announced as nonsense', async () => {
  const { deps, sent } = harness();
  const out = await announceCorrections([{ ok: true }, null, ONE], deps);
  assert.equal(sent.length, 1);
  assert.equal(out.sent, 1);
});

test('a notification failure is reported, never thrown — the fix already committed', async () => {
  const { deps } = harness();
  deps.notify = async () => { throw new Error('Telegram is down'); };
  const out = await announceCorrections([ONE], deps);
  assert.deepEqual(out, { sent: 0, skipped: 1 });
});

test('an undelivered notice is counted as skipped, not as sent', async () => {
  const { deps } = harness({ delivered: false });
  assert.deepEqual(await announceCorrections([ONE], deps), { sent: 0, skipped: 1 });
});
