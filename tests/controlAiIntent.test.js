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

/**
 * A FAITHFUL STAND-IN FOR `runCapability`, and the fidelity is the test.
 *
 * The first draft of this file stubbed the contract the way the code under test
 * assumed it worked — validator called with the parsed object, the parsed object
 * returned directly — and so it passed against a module that was wrong on both
 * counts. In production every provider would have been marked failed and the
 * whole AI path would have degraded to `unclear` for ever, looking exactly like
 * an outage.
 *
 * So this mirrors `services/ai/router.js` exactly: the answer is serialised the
 * way a provider would return it, JSON.parse'd back, the validator is called as
 * `(text, parsed)`, and the result is the `{text, parsed, provider, model}`
 * wrapper. A consumer that reads the wrong half now fails here.
 */
function router(answer) {
  const calls = [];
  const run = async (args) => {
    calls.push(args);
    if (answer instanceof Error) throw answer;
    const text = JSON.stringify(answer);
    const parsed = JSON.parse(text);
    const verdict = args.validate ? args.validate(text, parsed) : true;
    // A failed verdict is treated exactly like a provider failure: the chain
    // moves on, and with one provider it ends in AiUnavailableError.
    if (verdict !== true) throw new AiUnavailableError(`validate refused: ${verdict.message}`);
    return { text, parsed, provider: 'stub', model: 'stub-1', attempts: 1 };
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

test('THE VALIDATOR READS THE PARSED OBJECT, NOT THE RAW TEXT', async () => {
  // The bug this pins: a validator handed `result.text` refuses every
  // well-formed answer as "not an object", every provider is marked failed, and
  // the feature degrades to `unclear` for ever while looking like an outage.
  const { run, calls } = router({ action: 'dismiss', reason_text: 'team driver' });
  const got = await readReplyWithAi('u team driver', { offered: OFFERED, run });
  assert.strictEqual(got.intent, 'dismiss', 'a valid answer was accepted');

  const [text, parsed] = [null, null];
  assert.ok(calls[0].validate, 'a validator was supplied');
  assert.strictEqual(calls[0].validate('not json at all', { action: 'dismiss' }), true,
    'it judges the SECOND argument');
  assert.notStrictEqual(calls[0].validate('{"action":"dismiss"}', 'a string'), true,
    'and refuses when the second argument is not an object');
  assert.deepStrictEqual([text, parsed], [null, null]);
});

test('THE SECOND CHECK HOLDS even if the router hands back something unoffered', async () => {
  // A router that skipped its validator — a future refactor, a provider path
  // nobody thought about. The answer still cannot widen what a reply may choose.
  const run = async () => ({ text: '{}', parsed: { action: 'approve' } });
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
