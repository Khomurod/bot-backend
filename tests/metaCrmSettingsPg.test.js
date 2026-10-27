'use strict';

/**
 * Migration 0086 and database/metaCrmSettings.js on a real PostgreSQL: one
 * settings row, NULL inheriting the environment, the token encrypted at rest
 * with only its last four characters in clear, a save without a token keeping
 * the stored one, the switch keeping everything, and a re-run migration
 * leaving a saved row alone.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { createPgHarness, skipWithoutPg, allMigrationsSql } = require('./helpers/pgHarness');

const ALL_MIGRATIONS = allMigrationsSql();
const MIGRATION_0086 = fs.readFileSync(path.join(__dirname, '..', 'database', 'migrations', '0086_meta_crm_settings.sql'), 'utf8');
const TOKEN = 'EAAG-pg-test-token-1234567890-LAST';
const NEWER = 'EAAG-pg-test-token-0987654321-NEWR';

async function setup(t) {
  const h = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  const { metaCrmSettings: settings } = h.loadDataLayer(['metaCrmSettings']);
  return { h, settings };
}

test('the migration creates one row with every value NULL — the environment answers, and the sync is on', { skip: skipWithoutPg() }, async (t) => {
  const { h, settings } = await setup(t);
  const rows = (await h.query('SELECT * FROM meta_crm_settings')).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 1);
  for (const col of ['enabled', 'dataset_id', 'token_encrypted', 'token_last4', 'updated_by']) assert.equal(rows[0][col], null, col);
  const cfg = await settings.getMetaCrmConfig();
  assert.equal(cfg.enabled, true);
  assert.notEqual(cfg.datasetSource, 'database');
});

test('the table holds one row and a dataset id of digits only', { skip: skipWithoutPg() }, async (t) => {
  const { h } = await setup(t);
  await assert.rejects(h.query('INSERT INTO meta_crm_settings (id) VALUES (2)'));
  await assert.rejects(h.query("UPDATE meta_crm_settings SET dataset_id = '12ab' WHERE id = 1"));
});

test('a save stores the token encrypted, its last four in clear, switches on, and the next read sees it at once', { skip: skipWithoutPg() }, async (t) => {
  const { h, settings } = await setup(t);
  await settings.setMetaCrmEnabled(false, 'owner');
  await settings.getMetaCrmConfig(); // warm the cache: the save must invalidate it
  await settings.saveMetaCrmSettings({ datasetId: '1234567', token: TOKEN, updatedBy: 'owner' });
  const row = (await h.query('SELECT * FROM meta_crm_settings WHERE id = 1')).rows[0];
  assert.equal(row.dataset_id, '1234567');
  assert.equal(row.enabled, true);
  assert.equal(row.token_last4, 'LAST');
  assert.equal(row.updated_by, 'owner');
  assert.ok(row.token_encrypted && !row.token_encrypted.includes(TOKEN), 'never stored in clear');
  const cfg = await settings.getMetaCrmConfig();
  assert.equal(cfg.token, TOKEN);
  assert.equal(cfg.datasetId, '1234567');
  assert.equal(cfg.tokenSource, 'database');
  assert.ok(!JSON.stringify(settings.adminView(cfg)).includes(TOKEN));
});

test('a save without a token keeps the stored one; a new token replaces it', { skip: skipWithoutPg() }, async (t) => {
  const { settings } = await setup(t);
  await settings.saveMetaCrmSettings({ datasetId: '111', token: TOKEN });
  await settings.saveMetaCrmSettings({ datasetId: '222', token: '' });
  let cfg = await settings.getMetaCrmConfig();
  assert.equal(cfg.datasetId, '222');
  assert.equal(cfg.token, TOKEN);
  await settings.saveMetaCrmSettings({ datasetId: '222', token: NEWER });
  cfg = await settings.getMetaCrmConfig();
  assert.equal(cfg.token, NEWER);
  assert.equal(cfg.tokenLast4, 'NEWR');
});

test('switching off keeps the credentials; switching on brings them back unchanged', { skip: skipWithoutPg() }, async (t) => {
  const { settings } = await setup(t);
  await settings.saveMetaCrmSettings({ datasetId: '333', token: TOKEN });
  await settings.setMetaCrmEnabled(false, 'owner');
  let cfg = await settings.getMetaCrmConfig();
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.token, TOKEN);
  await settings.setMetaCrmEnabled(true, 'owner');
  cfg = await settings.getMetaCrmConfig();
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.datasetId, '333');
});

test('the dry run\'s ledger reads which pairs are already recorded; the Test finds only a Qualified Meta received in the last 47 hours', { skip: skipWithoutPg() }, async (t) => {
  const h = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  const { metaCrmEvents: events } = h.loadDataLayer(['metaCrmEvents']);
  const at = new Date(Date.now() - 60 * 60 * 1000);
  await events.recordEvents([{ leadgenId: '1668864698200916', eventName: 'Qualified', dealId: 1, stageId: 'EXECUTING', eventTime: at }]);
  const keys = await events.findRecordedKeys([
    { leadgenId: '1668864698200916', eventName: 'Qualified' },
    { leadgenId: '1668864698200916', eventName: 'Converted' },
  ]);
  assert.deepEqual([...keys], ['1668864698200916|Qualified']);
  assert.equal((await events.findRecordedKeys([])).size, 0);

  assert.equal(await events.latestRecentlySent('Qualified'), null, 'pending is not sent');
  await events.recordEvents([
    { leadgenId: '222222222222', eventName: 'Qualified', dealId: 2, stageId: 'EXECUTING', eventTime: at },
    { leadgenId: '333333333333', eventName: 'Qualified', dealId: 3, stageId: 'EXECUTING', eventTime: at },
    { leadgenId: '444444444444', eventName: 'Converted', dealId: 4, stageId: 'WON', eventTime: at },
    { leadgenId: '555555555555', eventName: 'Qualified', dealId: 5, stageId: 'EXECUTING', eventTime: new Date(Date.now() - 7 * 86400000 + 60000) },
  ]);
  await h.query(`UPDATE meta_crm_events SET state = 'sent', sent_at = NOW() - INTERVAL '50 hours' WHERE leadgen_id = '222222222222'`);
  await h.query(`UPDATE meta_crm_events SET state = 'sent', sent_at = NOW() - INTERVAL '2 hours' WHERE leadgen_id IN ('1668864698200916', '444444444444')`);
  await h.query(`UPDATE meta_crm_events SET state = 'sent', sent_at = NOW() - INTERVAL '1 hour' WHERE leadgen_id = '555555555555'`);
  const found = await events.latestRecentlySent('Qualified');
  // 222… was sent too long ago to deduplicate, 333… is still pending, 444… is
  // not a Qualified, and 555…'s event time is about to leave the seven days.
  assert.equal(found.leadgen_id, '1668864698200916');
  assert.equal(found.event_name, 'Qualified');
  assert.equal(new Date(found.event_time).getTime(), at.getTime());
});

test('the migration is idempotent: re-running it leaves a saved row alone', { skip: skipWithoutPg() }, async (t) => {
  const { h, settings } = await setup(t);
  await settings.saveMetaCrmSettings({ datasetId: '444', token: TOKEN });
  await h.query(MIGRATION_0086);
  const rows = (await h.query('SELECT dataset_id, token_last4 FROM meta_crm_settings')).rows;
  assert.deepEqual(rows, [{ dataset_id: '444', token_last4: 'LAST' }]);
});
