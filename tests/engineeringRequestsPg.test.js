'use strict';

/**
 * Things a person has to build, against the real schema.
 *
 * Three things here exist only in SQL:
 *   the redelivery guard is a PARTIAL unique index on `reply_id`, so two
 *   admin-filed requests are fine and two from one reply are not;
 *   the status set is a CHECK, not a JavaScript filter;
 *   nothing in the table could hold a patch — asserted structurally in
 *   `tests/controlNoCodeAccess.test.js`, and the column list here is what makes
 *   that assertion about something real.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { createPgHarness, skipWithoutPg, allMigrationsSql } = require('./helpers/pgHarness');

const ALL_MIGRATIONS = allMigrationsSql();

async function setup(t) {
  const h = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  const loaded = h.loadDataLayer(['engineeringRequests']);
  return { h, ...loaded };
}

test('an ask is recorded with the words somebody used', { skip: skipWithoutPg() }, async (t) => {
  const { engineeringRequests } = await setup(t);
  const { request, created } = await engineeringRequests.fileRequest({
    source: 'control_reply', replyId: 7, findingId: null,
    requestedBy: 'telegram:2117922421',
    requestText: 'the truck numbers come from the wrong place',
  });
  assert.equal(created, true);
  assert.equal(request.status, 'open');
  assert.equal(request.requestText, 'the truck numbers come from the wrong place');
  assert.equal(request.summary, null, 'an untriaged request has no summary, and says so');
});

test('A REDELIVERED COMPLAINT IS NOT A SECOND REQUEST', { skip: skipWithoutPg() }, async (t) => {
  const { engineeringRequests, h } = await setup(t);
  const first = await engineeringRequests.fileRequest({ replyId: 7, requestText: 'this is a bug' });
  const again = await engineeringRequests.fileRequest({ replyId: 7, requestText: 'this is a bug' });

  assert.equal(again.created, false);
  // THE ROW COMES BACK ANYWAY. The owner has to be told a number either way — a
  // redelivery should read as "that is request 1", not as a failure.
  assert.equal(again.request.id, first.request.id);

  const rows = await h.query('SELECT COUNT(*)::int AS n FROM engineering_requests');
  assert.equal(rows.rows[0].n, 1);
});

test('the guard is on the REPLY, so two admin-filed requests are both kept', {
  skip: skipWithoutPg(),
}, async (t) => {
  const { engineeringRequests, h } = await setup(t);
  await engineeringRequests.fileRequest({ source: 'admin', requestText: 'one' });
  await engineeringRequests.fileRequest({ source: 'admin', requestText: 'two' });
  const rows = await h.query('SELECT COUNT(*)::int AS n FROM engineering_requests');
  assert.equal(rows.rows[0].n, 2);
});

test('the status set is a CHECK in the database', { skip: skipWithoutPg() }, async (t) => {
  const { engineeringRequests } = await setup(t);
  const { request } = await engineeringRequests.fileRequest({ source: 'admin', requestText: 'x' });
  await assert.rejects(
    () => engineeringRequests.decideRequest(request.id, { status: 'shipped' }),
    /engineering_requests_status_check/,
  );
});

test('an empty ask is refused before it reaches the database', {
  skip: skipWithoutPg(),
}, async (t) => {
  const { engineeringRequests } = await setup(t);
  await assert.rejects(
    () => engineeringRequests.fileRequest({ source: 'admin', requestText: '   ' }),
    /needs something to say/,
  );
});

test('deciding records who and when, and the reference stays plain text', {
  skip: skipWithoutPg(),
}, async (t) => {
  const { engineeringRequests } = await setup(t);
  const { request } = await engineeringRequests.fileRequest({ source: 'admin', requestText: 'x' });
  const decided = await engineeringRequests.decideRequest(request.id, {
    status: 'accepted', linkedReference: 'PR #231', decidedBy: 'admin:1',
  });
  assert.equal(decided.status, 'accepted');
  assert.equal(decided.linkedReference, 'PR #231');
  assert.ok(decided.decidedAt);
  assert.equal(decided.decidedBy, 'admin:1');
});

test('ONLY OPEN REQUESTS REACH THE SWEEP, so a decided one stops being a finding', {
  skip: skipWithoutPg(),
}, async (t) => {
  const { engineeringRequests } = await setup(t);
  const a = await engineeringRequests.fileRequest({ source: 'admin', requestText: 'still waiting' });
  const b = await engineeringRequests.fileRequest({ source: 'admin', requestText: 'handled' });
  await engineeringRequests.decideRequest(b.request.id, { status: 'done', decidedBy: 'admin:1' });

  const open = await engineeringRequests.listOpenRequests();
  assert.deepEqual(open.map((r) => r.id), [a.request.id]);
});

test('the health summary counts and never returns what somebody wrote', {
  skip: skipWithoutPg(),
}, async (t) => {
  const { engineeringRequests } = await setup(t);
  await engineeringRequests.fileRequest({ source: 'admin', requestText: 'a secret sounding complaint' });
  const summary = await engineeringRequests.summariseRequests();
  assert.equal(summary.available, true);
  assert.equal(summary.open, 1);
  assert.ok(!JSON.stringify(summary).includes('secret sounding'));
});

test('a decided request resolves its finding, because the check only sees open ones', {
  skip: skipWithoutPg(),
}, async (t) => {
  const { engineeringRequests } = await setup(t);
  const { runEngineeringChecks } = require('../services/operations/checks/engineering');
  const { request } = await engineeringRequests.fileRequest({ source: 'admin', requestText: 'fix it' });

  let findings = runEngineeringChecks({
    now: new Date(), engineeringRequests: await engineeringRequests.listOpenRequests(),
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].subjectId, String(request.id));

  await engineeringRequests.decideRequest(request.id, { status: 'declined', decidedBy: 'admin:1' });
  findings = runEngineeringChecks({
    now: new Date(), engineeringRequests: await engineeringRequests.listOpenRequests(),
  });
  assert.deepEqual(findings, []);
});
