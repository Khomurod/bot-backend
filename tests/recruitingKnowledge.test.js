/**
 * Teaching Wenze what it may tell a candidate.
 *
 * The confirmation is not a formality. This is the only path by which a fact
 * reaches a candidate, and a candidate quoted a wrong pay rate is a real
 * problem for a real person. So: the person's own words are what gets stored,
 * the model's job ends at "here is what I think you mean", and nothing takes
 * effect until somebody agrees.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const teach = require('../services/recruiting/teach');

const EXAMPLES = {
  pay: 'Starting today, company driver pay is 77 CPM instead of 70 CPM.',
  boundary: 'Never tell candidates that orientation is paid.',
  sap: 'SAP-completed drivers are accepted if the rest of the background meets our requirements.',
};

function harness({ aiEnabled = true, parsed = null, aiThrows = false, active = [] } = {}) {
  const calls = { proposed: [], prompts: [] };
  const deps = {
    store: {
      async listActiveKnowledge() { return active; },
      async proposeKnowledge(row) { calls.proposed.push(row); return { id: 1, ...row }; },
    },
    async isCapabilityEnabled() { return aiEnabled; },
    async runCapability(req) {
      calls.prompts.push(req);
      if (aiThrows) throw new Error('every provider is down');
      return { parsed };
    },
  };
  return { deps, calls };
}

// ── it works with no model at all ────────────────────────────────────────────

test('the spec\'s own examples are read correctly with no AI', () => {
  const pay = teach.readDeterministically(EXAMPLES.pay);
  assert.equal(pay.kind, 'fact');
  assert.equal(pay.topic, 'pay');

  const boundary = teach.readDeterministically(EXAMPLES.boundary);
  assert.equal(boundary.kind, 'boundary', '"never tell" is a prohibition, not a fact');
  assert.equal(boundary.topic, 'orientation');

  const sap = teach.readDeterministically(EXAMPLES.sap);
  assert.equal(sap.kind, 'fact');
  assert.equal(sap.topic, 'hiring requirements');
});

test('every "do not" phrasing reads as a boundary', () => {
  for (const s of [
    'Never mention the referral bonus.',
    'Do not tell candidates we hire at 6 months.',
    "Don't say orientation is paid.",
    'We must not promise a specific truck.',
    'Stop saying we run to California.',
  ]) {
    assert.equal(teach.readDeterministically(s).kind, 'boundary', s);
  }
});

test('with AI down the administrator still gets a restatement to confirm', async () => {
  const { deps, calls } = harness({ aiThrows: true });
  const out = await teach.proposeFromStatement(EXAMPLES.pay, { proposedBy: 'admin' }, deps);
  assert.equal(out.reading.aiAssisted, false);
  assert.ok(out.reading.understoodAs.length > 20, 'and a real sentence, not a placeholder');
  assert.equal(calls.proposed[0].kind, 'fact');
});

test('with the capability off no model is asked at all', async () => {
  const { deps, calls } = harness({ aiEnabled: false, parsed: { kind: 'boundary' } });
  await teach.proposeFromStatement(EXAMPLES.pay, {}, deps);
  assert.equal(calls.prompts.length, 0);
  assert.equal(calls.proposed[0].kind, 'fact', 'the deterministic reading, not the ignored one');
});

// ── the person's words are the record ────────────────────────────────────────

test('what is STORED is exactly what was typed, never the model\'s rewording', async () => {
  const { deps, calls } = harness({
    parsed: {
      kind: 'fact', topic: 'pay',
      understood_as: 'Company drivers are now paid seventy-seven cents per mile.',
      replaces_id: null,
    },
  });
  await teach.proposeFromStatement(EXAMPLES.pay, { proposedBy: 'admin' }, deps);
  assert.equal(calls.proposed[0].statement, EXAMPLES.pay,
    'a paraphrase in its place would quietly become the record');
  assert.equal(
    calls.proposed[0].understoodAs,
    'Company drivers are now paid seventy-seven cents per mile.',
    'and the reading is kept separately, so a misunderstanding can be traced'
  );
});

test('nothing is active on proposal — a person still has to agree', async () => {
  const { deps, calls } = harness({ aiThrows: true });
  await teach.proposeFromStatement(EXAMPLES.pay, {}, deps);
  // proposeKnowledge writes status 'proposed'; the service never confirms.
  assert.equal('status' in calls.proposed[0], false, 'the service does not choose a status');
});

test('a statement too short to mean anything is refused', async () => {
  const { deps } = harness({ aiThrows: true });
  await assert.rejects(() => teach.proposeFromStatement('77 cpm', {}, deps), /a little more/);
});

// ── replacing an existing fact ───────────────────────────────────────────────

test('a claimed replacement is honoured only when it actually exists and is active', async () => {
  const active = [{ id: 42, kind: 'fact', topic: 'pay', statement: 'Company driver pay is 70 CPM.' }];
  const { deps, calls } = harness({
    active,
    parsed: { kind: 'fact', topic: 'pay', understood_as: 'Pay is now 77 CPM.', replaces_id: 42 },
  });
  const out = await teach.proposeFromStatement(EXAMPLES.pay, {}, deps);
  assert.equal(calls.proposed[0].supersedesId, 42);
  assert.equal(out.replaces.id, 42, 'and the administrator is shown what it replaces');
});

test('a replacement id that does not exist is ignored, not trusted', async () => {
  // A model naming a plausible id would otherwise retire a fact nobody meant
  // to touch — silently, since only the new one would then be visible.
  const { deps, calls } = harness({
    active: [{ id: 42, kind: 'fact', topic: 'pay', statement: 'Pay is 70 CPM.' }],
    parsed: { kind: 'fact', topic: 'pay', understood_as: 'Pay is now 77 CPM.', replaces_id: 999 },
  });
  const out = await teach.proposeFromStatement(EXAMPLES.pay, {}, deps);
  assert.equal(calls.proposed[0].supersedesId, null);
  assert.equal(out.replaces, null);
});

// ── the reading is validated ─────────────────────────────────────────────────

test('a malformed or empty model answer falls back rather than being stored', async () => {
  for (const parsed of [
    null, {}, { kind: 'maybe', understood_as: 'x'.repeat(30) },
    { kind: 'fact', understood_as: 'short' },
  ]) {
    const { deps, calls } = harness({ parsed });
    // eslint-disable-next-line no-await-in-loop
    await teach.proposeFromStatement(EXAMPLES.boundary, {}, deps);
    assert.equal(calls.proposed[0].kind, 'boundary', `fell back for ${JSON.stringify(parsed)}`);
  }
});

test('the prompt forbids adding anything the sentence does not say', () => {
  const prompt = teach.buildPrompt({ statement: EXAMPLES.pay, active: [] });
  assert.match(prompt, /Do NOT restate anything the sentence does not say/);
  assert.match(prompt, /Add no numbers, no conditions/);
  assert.match(prompt, /a person will confirm/);
});

// ── how it reaches a prompt ──────────────────────────────────────────────────

test('boundaries come after facts, and corrections after both', () => {
  const out = teach.renderForPrompt([
    { kind: 'fact', statement: 'Pay is 77 CPM.' },
    { kind: 'correction', statement: 'Do not say "guaranteed" about weekly miles.' },
    { kind: 'boundary', statement: 'Never say orientation is paid.' },
  ]);
  const factAt = out.indexOf('Pay is 77 CPM');
  const boundaryAt = out.indexOf('Never say orientation');
  const correctionAt = out.indexOf('guaranteed');
  assert.ok(factAt < boundaryAt, 'a model attends most to what it read last');
  assert.ok(boundaryAt < correctionAt, 'and a correction is about a real mistake it made');
  assert.match(out, /must NEVER say/);
  assert.match(out, /override the above/);
});

test('nothing known renders as nothing, not as an empty heading', () => {
  assert.equal(teach.renderForPrompt([]), '');
  assert.equal(teach.renderForPrompt(null), '');
});
