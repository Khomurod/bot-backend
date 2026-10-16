'use strict';

/**
 * lib/safetyApprovals/reading.js — a model's reading of a Safety reply, cut
 * down to what the messages prove. A wrong "APPROVED" posted in the recruiting
 * group is a refused driver being onboarded, so every guard here is pinned.
 *
 * Every name and number below is made up.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { verifyReading, driverKey, phonesIn } = require('../lib/safetyApprovals/reading');

// The shape of a real team post: two drivers who share a last name.
const TEAM_POST = [
  'Company team drivers 95 CPM',
  'Darnell Brooks (main)',
  '(555) 010-2233',
  'exp over 5',
  '',
  'Calvin Brooks',
  '(555) 010-4455',
  'exp over 5',
  '',
  'ready:',
].join('\n');
const SOLO_POST = 'Solo company driver\nRenata Ilves\n555-010-7788\nexp 3 years';

const read = (raw, ctx) => verifyReading(raw, { photoCount: 5, fileNames: [], ...ctx });

test('the team case: Safety names one driver, so only that driver is decided', () => {
  const out = read({
    candidates: [
      { name: 'Darnell Brooks', phone: '5550102233', cdl_photo: 3 },
      { name: 'Calvin Brooks', phone: '(555) 010-4455', cdl_photo: 0 },
    ],
    decisions: [
      { name: 'Darnell Brooks', decision: 'approved' },
      { name: 'Calvin Brooks', decision: 'approved' }, // a model over-reaching
    ],
  }, {
    postText: TEAM_POST,
    safetyText: 'We cah hire darnell brooks',
    fileNames: ['DARNELL BROOKS CLH.pdf', 'DARNELL BROOKS PSP.pdf', 'DARNELL BROOKS MVR.pdf'],
  });
  assert.equal(out.decisions.length, 1);
  assert.deepEqual(out.decisions[0], {
    key: 'darnell brooks', name: 'Darnell Brooks', phone: '(555) 010-2233', cdlPhoto: 3, decision: 'approved',
  });
  assert.deepEqual(out.dropped.map((d) => d.why), ['not_named_by_safety']);
});

test('a shared last name does not name both drivers', () => {
  const out = read({
    candidates: [{ name: 'Darnell Brooks' }, { name: 'Calvin Brooks' }],
    decisions: [{ name: 'Darnell Brooks', decision: 'approved' }, { name: 'Calvin Brooks', decision: 'approved' }],
  }, { postText: TEAM_POST, safetyText: 'Brooks is good to go' });
  assert.equal(out.decisions.length, 0, '"Brooks" alone is either of them, so neither');
});

test('"both" decides for the whole team', () => {
  const out = read({
    candidates: [{ name: 'Darnell Brooks' }, { name: 'Calvin Brooks' }],
    decisions: [{ name: 'Darnell Brooks', decision: 'approved' }, { name: 'Calvin Brooks', decision: 'approved' }],
  }, { postText: TEAM_POST, safetyText: 'We can hire both of them' });
  assert.deepEqual(out.decisions.map((d) => d.name), ['Darnell Brooks', 'Calvin Brooks']);
});

test('one approved and one refused in a single reply', () => {
  const out = read({
    candidates: [{ name: 'Darnell Brooks' }, { name: 'Calvin Brooks' }],
    decisions: [
      { name: 'Darnell Brooks', decision: 'approved' },
      { name: 'Calvin Brooks', decision: 'not_approved' },
    ],
  }, { postText: TEAM_POST, safetyText: 'Darnell approved, Calvin not approved - 2 accidents' });
  assert.deepEqual(out.decisions.map((d) => [d.name, d.decision]), [
    ['Darnell Brooks', 'approved'], ['Calvin Brooks', 'not_approved'],
  ]);
});

test('an "approved" next to refusal words is not a plain yes', () => {
  for (const safetyText of [
    "We can't hire Renata",
    'Renata is not eligible',
    'denied',
    'cannot be approved, too many violations',
    'do not hire',
  ]) {
    const out = read({ candidates: [{ name: 'Renata Ilves' }], decisions: [{ name: 'Renata Ilves', decision: 'approved' }] },
      { postText: SOLO_POST, safetyText });
    assert.equal(out.decisions.length, 0, safetyText);
    assert.equal(out.dropped[0].why, 'approval_with_refusal_words', safetyText);
  }
});

test('a question is not an approval, but a refusal still reads as one', () => {
  const asked = read({ candidates: [{ name: 'Renata Ilves' }], decisions: [{ name: 'Renata Ilves', decision: 'approved' }] },
    { postText: SOLO_POST, safetyText: 'Can we hire her?' });
  assert.equal(asked.decisions.length, 0);
  assert.equal(asked.dropped[0].why, 'approval_phrased_as_question');

  const refused = read({ candidates: [{ name: 'Renata Ilves' }], decisions: [{ name: 'Renata Ilves', decision: 'not_approved' }] },
    { postText: SOLO_POST, safetyText: "can't hire her, 3 speeding tickets" });
  assert.equal(refused.decisions[0].decision, 'not_approved');
});

test('"no violations" is not a refusal', () => {
  const out = read({ candidates: [{ name: 'Renata Ilves' }], decisions: [{ name: 'Renata Ilves', decision: 'approved' }] },
    { postText: SOLO_POST, safetyText: 'Clean MVR, no violations. Approved' });
  assert.equal(out.decisions[0].decision, 'approved');
});

test('unclear, pending and made-up decisions post nothing', () => {
  const out = read({
    candidates: [{ name: 'Renata Ilves' }],
    decisions: [{ name: 'Renata Ilves', decision: 'unclear' }, { name: 'Renata Ilves', decision: 'maybe' }],
  }, { postText: SOLO_POST, safetyText: 'let me check her clearinghouse' });
  assert.equal(out.decisions.length, 0);
});

test('a name from nowhere is dropped, with its decision', () => {
  const out = read({
    candidates: [{ name: 'Joseph Abbott' }],
    decisions: [{ name: 'Joseph Abbott', decision: 'approved' }],
  }, { postText: SOLO_POST, safetyText: 'approved' });
  assert.equal(out.decisions.length, 0);
  assert.deepEqual(out.dropped.map((d) => d.why), ['name_not_in_messages', 'decision_without_candidate']);
});

test('a name only Safety\'s file names carry is still a name the messages show', () => {
  const out = read({ candidates: [{ name: 'Renata Ilves' }], decisions: [{ name: 'Renata Ilves', decision: 'approved' }] },
    { postText: 'solo driver, 555-010-7788', safetyText: 'approved', fileNames: ['RENATA ILVES MVR.pdf'] });
  assert.equal(out.decisions[0].name, 'Renata Ilves');
});

test('the phone is the one the recruiter wrote, or none', () => {
  const ok = read({ candidates: [{ name: 'Renata Ilves', phone: '+1 555 010 7788' }], decisions: [] },
    { postText: SOLO_POST, safetyText: 'ok' });
  assert.equal(ok.candidates[0].phone, '555-010-7788');
  const invented = read({ candidates: [{ name: 'Renata Ilves', phone: '555-010-9999' }], decisions: [] },
    { postText: SOLO_POST, safetyText: 'ok' });
  assert.equal(invented.candidates[0].phone, null);
});

test('a photo index outside what the model was shown is no photo', () => {
  const out = read({ candidates: [{ name: 'Renata Ilves', cdl_photo: 7 }, { name: 'Darnell Brooks', cdl_photo: -1 }], decisions: [] },
    { postText: `${SOLO_POST}\n${TEAM_POST}`, safetyText: '' });
  assert.deepEqual(out.candidates.map((c) => c.cdlPhoto), [null, null]);
});

test('two different answers for one driver are no answer', () => {
  const out = read({
    candidates: [{ name: 'Renata Ilves' }],
    decisions: [{ name: 'Renata Ilves', decision: 'not_approved' }, { name: 'Renata', decision: 'approved' }],
  }, { postText: SOLO_POST, safetyText: 'Renata ok' });
  assert.equal(out.decisions.length, 0);
  assert.equal(out.dropped.at(-1).why, 'conflicting_decisions');
});

test('garbage from a model is no decision, never an exception', () => {
  for (const raw of [null, undefined, 'approved', { candidates: 'x', decisions: 7 }, { decisions: [null, 5] }]) {
    assert.deepEqual(read(raw, { postText: SOLO_POST, safetyText: 'approved' }).decisions, []);
  }
});

test('driverKey and phonesIn', () => {
  assert.equal(driverKey('  RENATA  ilves '), 'renata ilves');
  assert.deepEqual([...phonesIn('a (555) 010-2233 b 555.010.4455 c 15550104455').keys()], ['5550102233', '5550104455']);
});

test('in a team, Safety\'s file names do not name a driver — only Safety\'s words do', () => {
  const out = read({
    candidates: [{ name: 'Darnell Brooks' }, { name: 'Calvin Brooks' }],
    decisions: [{ name: 'Darnell Brooks', decision: 'approved' }, { name: 'Calvin Brooks', decision: 'approved' }],
  }, {
    postText: TEAM_POST,
    safetyText: 'We can hire Darnell',
    fileNames: ['DARNELL BROOKS PSP.pdf', 'CALVIN BROOKS MVR.pdf'],
  });
  assert.deepEqual(out.decisions.map((d) => d.name), ['Darnell Brooks']);
});
