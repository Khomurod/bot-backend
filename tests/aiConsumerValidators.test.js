/**
 * What the router is TOLD, at the call sites Stage 5c rewrote that are left.
 *
 * Deleting the hand-coded "try Groq, then Gemini" second legs was right — the
 * router owns cross-provider fallback now. But those legs also fired on a case
 * transport failure does not cover: a provider that answers HTTP 200 with an
 * empty, truncated or unusable body. The router records that as a SUCCESS and
 * returns, because as far as it can see the call worked; the consumer's parser
 * then rejects the text and the feature drops to its canned fallback WITHOUT
 * ever asking the next provider.
 *
 * `validateResult` is the seam that keeps the old behaviour: groqClient.js
 * forwards it to the router as `validate`, and the router treats a failed
 * verdict exactly like a provider failure and continues down the chain.
 *
 * These tests assert the ARGUMENTS, not a fabricated round trip. What matters
 * is that the validator exists and agrees with the parser standing behind it —
 * a validator that accepted what its parser then rejects would be worse than
 * none, because the router would stop looking.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const groqCalls = [];

require.cache[require.resolve('../services/groqClient')] = {
  exports: {
    callGroqWithFallback: async (prompt, opts) => {
      groqCalls.push({ prompt, opts });
      return { text: 'A perfectly usable answer that clears every length floor.', model: 'test-model' };
    },
    parseModelList: (raw, fallback) => (raw ? String(raw).split(',') : fallback),
    isAuthOrConfigError: () => false,
  },
};

const { classifyDriverGroups, parseClassificationResponse } = require('../services/groupStatusAiClassifier');

/** Run one generation and hand back the options the module passed the router. */
async function optsFrom(run) {
  groqCalls.length = 0;
  await run();
  assert.equal(groqCalls.length, 1, 'expected exactly one router call');
  return groqCalls[0].opts;
}

test('group status gives the router a validator, and it rejects what its parser rejects', async () => {
  // The Datatruck banter consumer carried this check until it was removed
  // (November 2026); the group-status classifier is the one left that hands
  // the router its parser as the validator.
  const group = { id: 1, group_name: 'WENZE UNIT # 01 JANE DOE' };
  const opts = await optsFrom(() => classifyDriverGroups([group]));
  assert.equal(typeof opts.validateResult, 'function',
    'without this, an empty 200 goes straight to the heuristic instead of the next provider');

  // Exactly the bodies the parser refuses: nothing, prose, and a row for a
  // group that was not in the batch. The validator has to refuse them too.
  for (const body of ['', 'I could not decide.', '[{"id": 99, "active": false}]']) {
    assert.deepEqual(parseClassificationResponse(body, [group]), []);
    assert.notEqual(opts.validateResult(body), true, `accepted ${JSON.stringify(body)}`);
  }
  const usable = '[{"id": 1, "active": true, "reason": "unit and name in the title"}]';
  assert.equal(parseClassificationResponse(usable, [group]).length, 1);
  assert.equal(opts.validateResult(usable), true);
});

test('the group-status model override still reaches the router', async () => {
  // GROUP_STATUS_AI_GROQ_MODEL is the feature's own model preference. Its
  // siblings went with their features: EMPLOYEE_BIRTHDAY_GROQ_MODEL with the AI
  // birthday message, DATATRUCK_BANTER_GROQ_MODEL with the Datatruck peer
  // reactions (November 2026). A deployment that sets this one and is silently
  // ignored has no way to discover that from the outside.
  const before = process.env.GROUP_STATUS_AI_GROQ_MODEL;
  process.env.GROUP_STATUS_AI_GROQ_MODEL = 'a-deliberately-chosen-model';
  try {
    groqCalls.length = 0;
    // The stub's text parses to no classifications, so the batch falls back to
    // the heuristic — irrelevant here. The call itself is what is under test.
    await classifyDriverGroups([{ id: 1, group_name: 'WENZE UNIT # 01 JANE DOE' }]);
    assert.equal(groqCalls.length, 1);
    assert.equal(groqCalls[0].opts.models[0], 'a-deliberately-chosen-model');
  } finally {
    if (before === undefined) delete process.env.GROUP_STATUS_AI_GROQ_MODEL;
    else process.env.GROUP_STATUS_AI_GROQ_MODEL = before;
  }
});
