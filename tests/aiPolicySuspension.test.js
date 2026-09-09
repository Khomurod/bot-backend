/**
 * What may take a provider out of rotation on its own. PURE.
 *
 * The rule under test is the one the user set: an AI model never disables a
 * provider because of what it thinks a change means. Only an enumerated,
 * deterministic rule matching the provider's OWN WORDS may suspend.
 *
 * The asymmetry is the reason. A model asked "is this serious?" will sometimes
 * say yes about a clarified indemnity clause, and the cost is that Wenze's AI
 * degrades for everyone until somebody notices — over a change that never
 * mattered. The cost of a rule being too narrow is an alert a human reads.
 * Those are not comparable, so the design is not symmetric either.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { evaluateSuspension, RULES } = require('../lib/ai/policySuspension');

const evaluate = (over = {}) => evaluateSuspension({
  freeOnlyMode: true, autoSuspendEnabled: true, ...over,
});

// ─── the four things that may suspend ────────────────────────────────────────

test('commercial use being withdrawn suspends', () => {
  const verdict = evaluate({
    topics: ['commercial_use'],
    passages: 'ADDED:\nThe API is provided for non-commercial use only.',
  });

  assert.equal(verdict.suspend, true);
  assert.equal(verdict.rule, 'commercial_use_withdrawn');
  assert.equal(verdict.severity, 'serious');
  assert.match(verdict.matched, /non-commercial use only/,
    'the alert quotes the provider back to itself');
});

test('a provider announcing it will train on submissions suspends', () => {
  const verdict = evaluate({
    topics: ['trains_on_data'],
    passages: 'ADDED:\nWe may use your data and prompts to train our models.',
  });

  assert.equal(verdict.suspend, true);
  assert.equal(verdict.rule, 'trains_on_submitted_data');
});

test('a discontinuation notice suspends', () => {
  const verdict = evaluate({
    topics: ['discontinuation'],
    passages: 'ADDED:\nThis service will be discontinued on 1 December.',
  });

  assert.equal(verdict.suspend, true);
  assert.equal(verdict.rule, 'discontinued');
});

test('losing the region suspends', () => {
  const verdict = evaluate({
    topics: ['geography'],
    passages: 'ADDED:\nThe service is not available in the United States.',
  });

  assert.equal(verdict.suspend, true);
  assert.equal(verdict.rule, 'region_excluded');
});

// ─── everything else must not ────────────────────────────────────────────────

test('a page merely MENTIONING commercial use does not suspend', () => {
  const verdict = evaluate({
    topics: ['commercial_use'],
    passages: 'ADDED:\nCommercial customers may request a dedicated endpoint.',
  });

  assert.equal(verdict.suspend, false);
  assert.equal(verdict.rule, null,
    'a page that mentions commercial use is not a page that just forbade it');
});

test('a change under a watched topic with no trigger phrasing does not suspend', () => {
  const verdict = evaluate({
    topics: ['retention', 'free_tier'],
    passages: 'ADDED:\nWe now retain request metadata for 14 days instead of 30.',
  });

  assert.equal(verdict.suspend, false);
  assert.match(verdict.reason, /for a person to read/);
});

test('trigger wording under the WRONG topic does not suspend', () => {
  // Both halves are required: the deterministic topic AND the phrasing. A
  // marketing page quoting a competitor's terms must not take a provider down.
  const verdict = evaluate({
    topics: ['free_tier'],
    passages: 'ADDED:\nUnlike others, we will never be discontinued.',
  });

  assert.equal(verdict.suspend, false);
});

test('no change at all does not suspend', () => {
  assert.equal(evaluate({ topics: [], passages: '' }).suspend, false);
});

// ─── the two switches an operator holds ──────────────────────────────────────

test('with auto-suspend off, the rule still fires — it just does not act', () => {
  const verdict = evaluate({
    autoSuspendEnabled: false,
    topics: ['commercial_use'],
    passages: 'ADDED:\nThe API is for non-commercial use only.',
  });

  assert.equal(verdict.suspend, false, 'the operator said do not act');
  assert.equal(verdict.rule, 'commercial_use_withdrawn', 'but they still get told which rule matched');
  assert.equal(verdict.severity, 'serious', 'and it is still serious');
  assert.match(verdict.reason, /automatic suspension is turned off/);
});

test('training terms only suspend while free-only mode is on', () => {
  const args = {
    topics: ['trains_on_data'],
    passages: 'ADDED:\nWe may use your prompts to train our models.',
  };

  assert.equal(evaluate({ ...args, freeOnlyMode: true }).suspend, true);
  assert.equal(evaluate({ ...args, freeOnlyMode: false }).suspend, false,
    'a paying operator has usually already excluded training deliberately — '
    + 'overriding that from a regex would be presumptuous');
});

// ─── the shape of the guarantee ──────────────────────────────────────────────

test('there is nowhere to pass a model an opinion through', () => {
  // A function that cannot receive a verdict cannot act on one. If this ever
  // grows an `aiSeverity` or `aiSaysSerious` argument, this test should be the
  // thing that makes somebody argue for it out loud.
  const accepted = ['topics', 'passages', 'freeOnlyMode', 'autoSuspendEnabled'];
  const source = evaluateSuspension.toString();
  const params = source
    .slice(source.indexOf('{') + 1, source.indexOf('}'))
    .split(',')
    .map((entry) => entry.split('=')[0].trim())
    .filter(Boolean);

  assert.deepEqual(params, accepted,
    'a new input here means a new way to influence a suspension — argue for it out loud');
});

test('every rule names a topic, a severity and at least one pattern', () => {
  assert.ok(RULES.length > 0);
  for (const rule of RULES) {
    assert.ok(rule.key && rule.label, 'a suspension has to be explainable');
    assert.ok(rule.topic, 'a rule fires only alongside a deterministic topic match');
    assert.equal(rule.severity, 'serious', 'nothing less than serious may suspend');
    assert.ok(Array.isArray(rule.patterns) && rule.patterns.length > 0);
  }
});
