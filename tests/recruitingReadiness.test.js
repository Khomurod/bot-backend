/**
 * Whether Wenze can answer a candidate after hours, and what is missing.
 *
 * Every blocker here is somebody's DECISION rather than a fault — hours nobody
 * set, nothing approved to say, a capability switched off. The point of
 * answering it before anybody texts is that by the time `afterHoursReply` has a
 * reason there is already a candidate waiting, and the gap should be visible on
 * a quiet Tuesday afternoon instead.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { afterHoursReadiness } = require('../lib/recruiting/readiness');

const READY = {
  afterHoursEnabled: true,
  hoursConfigured: true,
  approvedStatements: 5,
  capabilityEnabled: true,
  aiProviderEnabled: true,
  recruitersWithSms: 2,
};

test('everything set is ready, with nothing to do', () => {
  const v = afterHoursReadiness(READY);
  assert.equal(v.ready, true);
  assert.deepEqual(v.blockers, []);
});

test('nothing set names every one of them rather than stopping at the first', () => {
  const v = afterHoursReadiness({});
  assert.equal(v.ready, false);
  assert.deepEqual(v.blockers.map((b) => b.key).sort(), [
    'after_hours_enabled', 'ai_capability', 'ai_provider',
    'approved_knowledge', 'recruiter_sms', 'working_hours',
  ]);
});

test('each blocker says where to go, because a warning without an address is a mood', () => {
  for (const b of afterHoursReadiness({}).blockers) {
    assert.match(b.where, /Settings →/);
    assert.ok(b.what.endsWith('.'), 'and reads as a sentence');
  }
});

test('nothing approved is a blocker, however good the rest is', () => {
  const v = afterHoursReadiness({ ...READY, approvedStatements: 0 });
  assert.deepEqual(v.blockers.map((b) => b.key), ['approved_knowledge']);
  assert.match(v.blockers[0].what, /nothing it is allowed/,
    'the model may only speak from statements a person confirmed');
  assert.match(v.blockers[0].where, /Teach Wenze/);
});

test('a recruiter who cannot text blocks it — the reply comes from their own number', () => {
  const v = afterHoursReadiness({ ...READY, recruitersWithSms: 0 });
  assert.deepEqual(v.blockers.map((b) => b.key), ['recruiter_sms']);
});

test('no AI provider blocks it, and says why rather than only that', () => {
  const v = afterHoursReadiness({ ...READY, aiProviderEnabled: false });
  assert.match(v.blockers[0].what, /nothing to compose a reply/);
});

test('the summary counts, because "not configured" reads like an optional extra', () => {
  assert.match(afterHoursReadiness({ ...READY, approvedStatements: 0 }).summary, /^1 thing must/);
  assert.match(afterHoursReadiness({}).summary, /^6 things must/);
});

test('a missing field is treated as missing, never as satisfied', () => {
  // The honest default. A readiness check that defaults to ready is worse than
  // none: it reports a feature as working on the strength of an absent field.
  assert.equal(afterHoursReadiness({ approvedStatements: null }).ready, false);
  assert.equal(afterHoursReadiness({ afterHoursEnabled: 'yes' }).ready, false,
    'and only a real boolean counts, not a truthy string from a form');
});
