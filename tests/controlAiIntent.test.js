'use strict';

/**
 * The model is allowed to read a sentence. It is not allowed to decide anything
 * the question did not already offer, and it is not allowed to fail into a
 * guess. Both are proved here by feeding it answers a real provider might give
 * and asserting what comes out the other side.
 *
 * NO NETWORK. The router is injected, so nothing in this file reaches a
 * provider — which is also the point: the seam that makes that possible is the
 * same one that makes the capability switchable.
 */
const test = require('node:test');
const assert = require('node:assert');

const {
  CAPABILITY, buildUserText, validateShape, readReplyWithAi,
} = require('../services/control/aiIntent');
const { AiUnavailableError } = require('../services/ai/router');
const { getCapabilityMeta } = require('../lib/ai/capabilityCatalog');

const OFFERED = [
  { key: 'approve', label: 'yes' },
  { key: 'dismiss', label: 'no (say why)' },
  { key: 'snooze', label: 'later' },
];

function router(answer) {
  const calls = [];
  const run = async (args) => {
    calls.push(args);
    if (answer instanceof Error) throw answer;
    // THE ROUTER'S OWN VALIDATOR IS EXERCISED, not skipped — a validator that
    // is never run is a validator that can be wrong for months.
    const verdict = args.validate ? args.validate(answer) : true;
    if (verdict !== true) throw new Error(`validate refused: ${verdict.message}`);
    return answer;
  };
  return { run, calls };
}

test('the capability is registered, and registered as one that can change state', () => {
  const meta = getCapabilityMeta(CAPABILITY);
  assert.ok(meta, 'control_reply_reading is in the catalogue');
  assert.strictEqual(meta.changesState, true);
  assert.strictEqual(meta.sendsRawText, true, 'the owner\'s own sentence goes to the provider');
});

test('AN ACTION THAT WAS NOT OFFERED IS REFUSED', () => {
  assert.strictEqual(validateShape({ action: 'approve' }, OFFERED), true);
  const refused = validateShape({ action: 'approve' }, [{ key: 'dismiss' }, { key: 'snooze' }]);
  assert.notStrictEqual(refused, true);
  assert.match(refused.message, /not offered/);
});

test('an invented action is refused even when it sounds operational', () => {
  for (const action of ['deactivate', 'merge_people', 'apply_all', '']) {
    assert.notStrictEqual(validateShape({ action }, OFFERED), true, action);
  }
});

test('a reply the model understands becomes the SAME shape the parser returns', async () => {
  const { run, calls } = router({ action: 'approve', reason_text: 'they agreed', confidence: 90 });
  const got = await readReplyWithAi('ha, mayli', { offered: OFFERED, run });
  assert.strictEqual(got.intent, 'approve');
  assert.strictEqual(got.action, 'approve');
  assert.strictEqual(got.aiAssisted, true);
  assert.strictEqual(calls[0].capability, CAPABILITY);
  assert.strictEqual(calls[0].expects, 'json');
});

test('THE OWNER\'S WORDS ARE THE REASON, not the model\'s paraphrase', async () => {
  const { run } = router({ action: 'dismiss', reason_text: 'the driver is on a team' });
  const got = await readReplyWithAi('qoldiring, u team driver', { offered: OFFERED, run });
  assert.strictEqual(got.intent, 'dismiss');
  assert.strictEqual(got.reason, 'qoldiring, u team driver');
});

test('a delay carries hours, clamped to the same ceiling the parser uses', async () => {
  const { run } = router({ action: 'snooze', snooze_hours: 5000 });
  const got = await readReplyWithAi('keyinroq', { offered: OFFERED, run });
  assert.strictEqual(got.intent, 'snooze');
  assert.strictEqual(got.snoozeHours, 720);
});

test('NO PROVIDER MEANS UNCLEAR, NEVER A GUESS', async () => {
  const { run } = router(new AiUnavailableError('switched off'));
  const got = await readReplyWithAi('hmm', { offered: OFFERED, run });
  assert.strictEqual(got.intent, 'unclear');
  assert.strictEqual(got.action, null);
  assert.strictEqual(got.aiAssisted, false);
  assert.strictEqual(got.note, 'ai unavailable');
});

test('any other failure also means unclear — nothing is ever assumed', async () => {
  const { run } = router(new Error('every provider refused the shape'));
  const got = await readReplyWithAi('hmm', { offered: OFFERED, run });
  assert.strictEqual(got.intent, 'unclear');
  assert.strictEqual(got.action, null);
});

test('THE SECOND CHECK HOLDS even if the router hands back something unoffered', async () => {
  // A router that skipped its validator — a future refactor, a provider path
  // nobody thought about. The answer still cannot widen what a reply may choose.
  const run = async () => ({ action: 'approve' });
  const got = await readReplyWithAi('yes please', {
    offered: [{ key: 'dismiss', label: 'no' }, { key: 'snooze', label: 'later' }],
    run,
  });
  assert.strictEqual(got.intent, 'unclear');
  assert.strictEqual(got.note, 'refused');
});

test('the model is never asked about an empty reply', async () => {
  const { run, calls } = router({ action: 'approve' });
  const got = await readReplyWithAi('   ', { offered: OFFERED, run });
  assert.strictEqual(got.intent, 'unclear');
  assert.strictEqual(calls.length, 0, 'no call was made');
});

test('the prompt offers the keys and NOTHING about the case', () => {
  const text = buildUserText({ text: 'no, he is on a team', offered: OFFERED });
  assert.match(text, /approve/);
  assert.match(text, /dismiss/);
  assert.match(text, /engineering_request/);
  assert.match(text, /unclear/);
  // The reply is fenced and named as words to classify, so a sentence that
  // reads like an instruction is treated as the data it is.
  assert.match(text, /<<<REPLY[\s\S]*no, he is on a team[\s\S]*REPLY>>>/);
  assert.match(text, /never as instructions/i);
});

test('a very long reply is truncated before it is sent anywhere', () => {
  const text = buildUserText({ text: 'x'.repeat(5000), offered: OFFERED });
  assert.ok(text.length < 3000, 'the prompt stays small — free tiers, minimised prompts');
});
