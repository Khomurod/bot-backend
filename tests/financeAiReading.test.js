'use strict';

/**
 * A model may say what a finance message MEANS. It may not say what the
 * numbers are.
 *
 * WHY THIS IS A TEST AND NOT A PROMPT. "Do not invent a code" in a prompt is a
 * request, and a model asked to be helpful about a half-legible payment message
 * will eventually complete the pattern — a plausible ten-digit code for digits
 * that were never there. In a finance table that is a payment record for money
 * nobody sent. So every number comes back through `verifyAiReading`, which
 * looks for it in the captured text, and the tests below are the enforcement.
 *
 * AND THE DETERMINISTIC PATH KEEPS WORKING WITH NO PROVIDER AT ALL. The last
 * tests here pin that: the Finance Monitor is not allowed to depend on AI.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { verifyAiReading, AI_KIND } = require('../lib/finance/aiReading');
const { interpretMessage } = require('../services/finance/aiInterpret');

const MESSAGE = 'EFS 1491583146 amount 480.00 issued to WENZE INVESTMENTS LLC';

test('a reading whose numbers are all in the message is kept', () => {
  const out = verifyAiReading({
    kind: AI_KIND.ISSUE, code: '1491583146', amount: 480,
    issuedTo: 'WENZE INVESTMENTS LLC', confidence: 90,
  }, MESSAGE);
  assert.equal(out.ok, true);
  assert.equal(out.code, '1491583146');
  assert.equal(out.amount, 480);
  assert.deepEqual(out.dropped, []);
});

/** The failure this whole mechanism exists for. */
test('an INVENTED code is refused, however confident the model was', () => {
  const out = verifyAiReading({
    kind: AI_KIND.ISSUE, code: '9999999999', amount: 480, confidence: 99,
  }, MESSAGE);
  assert.equal(out.ok, false);
  assert.match(out.reason, /a code the message does not contain/);
  assert.equal(out.code, null);
});

/** The subtle one: digits that ARE in the text, but not as that number. */
test('a substring of a real code is not that code', () => {
  const out = verifyAiReading({ kind: AI_KIND.ISSUE, code: '4915831', confidence: 99 }, MESSAGE);
  assert.equal(out.ok, false, '"4915831" sits inside "1491583146" and is a different number');
});

test('an invented amount is dropped while the verified code survives', () => {
  const out = verifyAiReading({
    kind: AI_KIND.ISSUE, code: '1491583146', amount: 9999, confidence: 90,
  }, MESSAGE);
  assert.equal(out.ok, true);
  assert.equal(out.code, '1491583146');
  assert.equal(out.amount, null);
  assert.deepEqual(out.dropped, ['amount'], 'and the drop is recorded, not silent');
});

test('an invented recipient is dropped', () => {
  const out = verifyAiReading({
    kind: AI_KIND.ISSUE, code: '1491583146', issuedTo: 'SOME OTHER COMPANY', confidence: 80,
  }, MESSAGE);
  assert.equal(out.issuedTo, null);
  assert.ok(out.dropped.includes('issuedTo'));
});

test('a void pointing at a code the message never mentions is refused whole', () => {
  const out = verifyAiReading({
    kind: AI_KIND.VOID_COMPLETED, referencesCode: '8888888888', confidence: 95,
  }, 'voided that one');
  assert.equal(out.ok, false);
  assert.match(out.reason, /points at a code the message does not contain/);
});

test('a kind nobody defined is refused rather than passed through', () => {
  assert.equal(verifyAiReading({ kind: 'delete_everything' }, MESSAGE).ok, false);
  assert.equal(verifyAiReading(null, MESSAGE).ok, false);
  assert.equal(verifyAiReading('not an object', MESSAGE).ok, false);
});

test('confidence is clamped rather than trusted', () => {
  assert.equal(verifyAiReading({ kind: AI_KIND.UNRELATED, confidence: 5000 }, MESSAGE).confidence, 100);
  assert.equal(verifyAiReading({ kind: AI_KIND.UNRELATED, confidence: -7 }, MESSAGE).confidence, 0);
  assert.equal(verifyAiReading({ kind: AI_KIND.UNRELATED }, MESSAGE).confidence, 0);
});

// ── the model is a fallback, never the path ────────────────────────────────

test('a message the rules already settled never reaches a model', async () => {
  let called = false;
  const out = await interpretMessage({ text: MESSAGE, status: 'parsed' }, {
    isCapabilityEnabled: async () => { called = true; return true; },
    runCapability: async () => { called = true; return {}; },
  });
  assert.equal(out.used, false);
  assert.equal(called, false, 'the common case must cost nothing');
  assert.match(out.reason, /already settled/);
});

test('the capability switched off means the rules stand', async () => {
  const out = await interpretMessage({ text: MESSAGE, status: 'unparsed' }, {
    isCapabilityEnabled: async () => false,
    runCapability: async () => { throw new Error('must not be called'); },
  });
  assert.equal(out.used, false);
  assert.match(out.reason, /switched off/);
});

/** Item seven of the safety rules: AI is an accelerator, never a dependency. */
test('NO PROVIDER AT ALL is an unclear reading, not a failure', async () => {
  const out = await interpretMessage({ text: MESSAGE, status: 'unparsed' }, {
    isCapabilityEnabled: async () => true,
    runCapability: async () => { throw new Error('every provider is in cooldown'); },
  });
  assert.equal(out.used, false);
  assert.match(out.reason, /no reading available/);
});

test('a model that answers with an invented code is not used', async () => {
  const out = await interpretMessage({ text: MESSAGE, status: 'ambiguous' }, {
    isCapabilityEnabled: async () => true,
    runCapability: async () => ({ json: { kind: 'issue', code: '1234567890', confidence: 99 } }),
  });
  assert.equal(out.used, false, 'a reading that fails verification is not a reading');
});

test('a model that answers honestly is used', async () => {
  const out = await interpretMessage({ text: MESSAGE, status: 'unparsed' }, {
    isCapabilityEnabled: async () => true,
    runCapability: async () => ({ json: { kind: 'issue', code: '1491583146', amount: 480, confidence: 88 } }),
  });
  assert.equal(out.used, true);
  assert.equal(out.reading.code, '1491583146');
});
