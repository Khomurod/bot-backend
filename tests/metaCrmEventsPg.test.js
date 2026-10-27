'use strict';

/**
 * database/metaCrmEvents.js on a real PostgreSQL — the guarantees the stage
 * sync rests on:
 *
 *   two passes recording the same lead's event at once → one row;
 *   a sent row is never pending again, so a success is never retried;
 *   the fifth failure, or Meta's seven-day window, closes a row as gave_up;
 *   only Facebook leads are matched back to a leadgen id.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createPgHarness, skipWithoutPg, allMigrationsSql } = require('./helpers/pgHarness');

const ALL_MIGRATIONS = allMigrationsSql();

const plan = (over = {}) => ({
  leadgenId: '1668864698200916', eventName: 'Qualified', dealId: 5603, stageId: 'EXECUTING',
  eventTime: new Date(Date.now() - 60 * 60 * 1000), ...over,
});

async function setup(t) {
  const h = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  const { metaCrmEvents: store } = h.loadDataLayer(['metaCrmEvents']);
  return { h, store };
}

test('TWO PASSES RACING: a lead\'s event is recorded once, by exactly one of them', { skip: skipWithoutPg() }, async (t) => {
  const { store } = await setup(t);
  const [a, b] = await Promise.all([
    store.recordEvents([plan(), plan({ eventName: 'Lost', stageId: 'LOSE' })]),
    store.recordEvents([plan({ stageId: 'UC_PBR3LM' }), plan({ eventName: 'Lost', stageId: 'LOSE' })]),
  ]);
  assert.equal(a.length + b.length, 2, 'Qualified and Lost, once each, whoever won');
  assert.equal((await store.recordEvents([plan({ stageId: 'UC_SAFETY' })])).length, 0, 'a later qualified stage adds nothing');
  assert.equal((await store.listDue()).length, 2);
});

test('a sent row is never pending again; markSent and markFailed on it change nothing', { skip: skipWithoutPg() }, async (t) => {
  const { store } = await setup(t);
  const [id] = await store.recordEvents([plan()]);
  assert.equal(await store.markSent(id), true);
  assert.equal(await store.markSent(id), false);
  assert.equal(await store.markFailed(id, 'late error'), null);
  assert.equal((await store.listDue()).length, 0);
});

test('the fifth failure gives up; a pending row older than seven days gives up without a send', { skip: skipWithoutPg() }, async (t) => {
  const { h, store } = await setup(t);
  const [id] = await store.recordEvents([plan()]);
  for (let i = 1; i < store.MAX_ATTEMPTS; i += 1) {
    assert.equal(await store.markFailed(id, `Meta 400: try ${i}`), 'pending'); // eslint-disable-line no-await-in-loop
  }
  assert.equal(await store.markFailed(id, 'Meta 400: last'), 'gave_up');
  const row = (await h.query('SELECT state, attempts, last_error FROM meta_crm_events WHERE id = $1', [id])).rows[0];
  assert.deepEqual(row, { state: 'gave_up', attempts: 5, last_error: 'Meta 400: last' });

  const [old] = await store.recordEvents([plan({ leadgenId: '1234567890123', eventTime: new Date(Date.now() - 8 * 86400000) })]);
  assert.deepEqual((await store.listDue()).map((r) => r.id), []);
  const aged = (await h.query('SELECT state, last_error FROM meta_crm_events WHERE id = $1', [old])).rows[0];
  assert.deepEqual(aged, { state: 'gave_up', last_error: 'older than seven days' });
});

test('only Facebook leads are matched from a Bitrix id to a leadgen id', { skip: skipWithoutPg() }, async (t) => {
  const { h, store } = await setup(t);
  await h.query(
    `INSERT INTO leads (source, external_id, bitrix_id, bitrix_status) VALUES
       ('facebook', '1668864698200916', '1839', 'created'),
       ('indeed', 'msg-abc', '1840', 'created'),
       ('facebook', '1234567890123', NULL, 'failed')`
  );
  const map = await store.findLeadgenIdsByBitrixIds(['1839', '1840', '9999', '1839']);
  assert.deepEqual([...map.entries()], [['1839', '1668864698200916']]);
  assert.equal((await store.findLeadgenIdsByBitrixIds([])).size, 0);
});
