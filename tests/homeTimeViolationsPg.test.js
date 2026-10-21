'use strict';

/**
 * database/homeTime/violationNotices.js on a real PostgreSQL — the guarantees
 * the alerts rest on, under the races that produce duplicates:
 *
 *   the webhook and the reconciliation pass recording the same card at once;
 *   two posters claiming the same rows;
 *   two accountants pressing at once;
 *   a reason from somebody other than the person who pressed.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createPgHarness, skipWithoutPg, allMigrationsSql } = require('./helpers/pgHarness');

const ALL_MIGRATIONS = allMigrationsSql();

const deal = (over = {}) => ({
  dealId: 4512, homeFrom: '2026-10-03', stageId: 'C33:UC_HTEARLYOVER', driverName: 'John Potter',
  roadDays: 19, homeDays: 6, ...over,
});

async function setup(t) {
  const h = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  const { 'homeTime/violationNotices': store } = h.loadDataLayer(['homeTime/violationNotices']);
  return { h, store };
}

test('THE WEBHOOK AND THE PASS RACING: each violation is recorded once, by exactly one of them', { skip: skipWithoutPg() }, async (t) => {
  const { store } = await setup(t);
  const [a, b] = await Promise.all([
    store.recordViolations({ deal: deal(), violations: ['early', 'overstay'] }),
    store.recordViolations({ deal: deal(), violations: ['early', 'overstay'] }),
  ]);
  assert.equal(a.length + b.length, 2, 'two violations, two rows, whoever won');
  assert.deepEqual([...a, ...b].map((r) => r.violation).sort(), ['early', 'overstay']);
  assert.equal(a[0]?.home_from ?? b[0].home_from, '2026-10-03', 'the date as text, not moved by a timezone');

  // EARLY → EARLY & OVERSTAYED: only the new one is recorded.
  const again = await store.recordViolations({ deal: deal({ homeFrom: '2026-11-07' }), violations: ['early'] });
  const later = await store.recordViolations({ deal: deal({ homeFrom: '2026-11-07' }), violations: ['early', 'overstay'] });
  assert.equal(again.length, 1);
  assert.deepEqual(later.map((r) => r.violation), ['overstay']);
  assert.deepEqual((await store.listRecordedViolations(4512, '2026-11-07')).sort(), ['early', 'overstay']);
});

test('a baseline row is never claimed for posting', { skip: skipWithoutPg() }, async (t) => {
  const { store } = await setup(t);
  const rows = await store.recordViolations({ deal: deal(), violations: ['early'], state: 'baselined' });
  assert.deepEqual(await store.claimForPosting(rows.map((r) => r.id)), []);
  assert.deepEqual(await store.listDue(), []);
});

test('TWO POSTERS: only one holds the lease; a failure returns the rows; the sixth gives up', { skip: skipWithoutPg() }, async (t) => {
  const { h, store } = await setup(t);
  const rows = await store.recordViolations({ deal: deal(), violations: ['early', 'overstay'] });
  const ids = rows.map((r) => r.id);
  const [x, y] = await Promise.all([store.claimForPosting(ids), store.claimForPosting(ids)]);
  assert.equal(x.length + y.length, 2, 'every row claimed exactly once');
  assert.ok(x.length === 0 || y.length === 0, 'and by one poster');

  await store.markFailed(ids, 'chat not found');
  assert.equal((await store.listDue()).length, 2);
  await h.query('UPDATE home_time_violation_notices SET attempts = 6');
  await store.markFailed(ids, 'chat not found');
  assert.deepEqual(await store.listDue(), []);
  assert.equal(await store.countAbandoned(), 2);
});

test('TWO ACCOUNTANTS AT ONCE: one decision, written once for every row of the message', { skip: skipWithoutPg() }, async (t) => {
  const { store } = await setup(t);
  const rows = await store.recordViolations({ deal: deal(), violations: ['early', 'overstay'] });
  await store.markPosted(rows.map((r) => r.id), { chatId: '-1009', messageId: 901 });
  const [a, b] = await Promise.all([
    store.decide({ chatId: '-1009', messageId: 901, decision: 'charged', byId: 6504395610, byName: 'cameron_acc' }),
    store.decide({ chatId: '-1009', messageId: 901, decision: 'not_charging', byId: 8245947790, byName: 'Ellaaccounting' }),
  ]);
  assert.equal([a, b].filter((r) => r.alreadyDecided).length, 1, 'exactly one loses');
  const final = await store.listByMessage('-1009', 901);
  assert.equal(final.length, 2);
  assert.equal(new Set(final.map((r) => r.decision)).size, 1, 'both rows carry the same answer');
});

test('the reason is taken only from the person who pressed, and only once', { skip: skipWithoutPg() }, async (t) => {
  const { store } = await setup(t);
  const rows = await store.recordViolations({ deal: deal(), violations: ['early'] });
  await store.markPosted(rows.map((r) => r.id), { chatId: '-1009', messageId: 901 });
  await store.decide({ chatId: '-1009', messageId: 901, decision: 'not_charging', byId: 8245947790, byName: 'Ellaaccounting' });
  await store.setReasonPrompt({ chatId: '-1009', messageId: 901, promptMessageId: 950 });

  assert.deepEqual(await store.recordReason({ chatId: '-1009', promptMessageId: 950, byId: 6504395610, reason: 'no' }), []);
  const ok = await store.recordReason({ chatId: '-1009', promptMessageId: 950, byId: 8245947790, reason: 'family emergency' });
  assert.equal(ok[0].decision_reason, 'family emergency');
  assert.deepEqual(await store.recordReason({ chatId: '-1009', promptMessageId: 950, byId: 8245947790, reason: 'changed my mind' }), []);
});

test('the switch, the group and the baseline stamp live on the home-time settings row', { skip: skipWithoutPg() }, async (t) => {
  const { store } = await setup(t);
  const before = await store.getViolationSettings();
  assert.equal(before.violation_alerts_enabled, false, 'off until a person switches it on');
  assert.equal(before.violation_alerts_chat_id, null);
  assert.ok(await store.markBaselined());
  assert.equal(await store.markBaselined(), null, 'stamped once');
});

test('the webhook secret is stored on the settings row as written (encrypted), and replaced in place', { skip: skipWithoutPg() }, async (t) => {
  const { store } = await setup(t);
  assert.equal(await store.getWebhookSecretEncrypted(), null, 'none until created in the app');
  await store.setWebhookSecretEncrypted('iv.tag.first');
  await store.setWebhookSecretEncrypted('iv.tag.second');
  assert.equal(await store.getWebhookSecretEncrypted(), 'iv.tag.second');
});
