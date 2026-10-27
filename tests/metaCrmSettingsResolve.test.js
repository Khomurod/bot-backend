'use strict';

/**
 * Settings → Facebook ↔ Bitrix: which value is in effect (the saved row over
 * the environment, NULL inheriting it), what the panel may see of the token
 * (its last four characters, never more), and the input rules.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveMetaCrmConfig, adminView } = require('../database/metaCrmSettings');
const rules = require('../services/metaCrm/settingsRules');
const { redactSecret } = require('../lib/security/redactSecret');

const ENV_TOKEN = 'EAAG-env-token-0000000000-ENVT';
const DB_TOKEN = 'EAAG-db-token-11111111111111-DBTK';
const env = (over = {}) => ({ metaCrmDatasetId: '555', metaCrmCapiToken: ENV_TOKEN, metaGraphVersion: 'v25.0', ...over });
const decrypt = (payload) => (payload === 'enc:db' ? DB_TOKEN : '');

test('no row, or a row never saved: the environment answers, and the sync is on', () => {
  for (const row of [null, { id: 1, enabled: null, dataset_id: null, token_encrypted: null }]) {
    const cfg = resolveMetaCrmConfig(row, env(), decrypt);
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.datasetId, '555');
    assert.equal(cfg.token, ENV_TOKEN);
    assert.equal(cfg.datasetSource, 'environment');
    assert.equal(cfg.tokenSource, 'environment');
    assert.equal(cfg.tokenLast4, 'ENVT');
  }
});

test('a saved value wins over the environment, field by field', () => {
  const cfg = resolveMetaCrmConfig({ enabled: true, dataset_id: '777', token_encrypted: 'enc:db', token_last4: 'DBTK' }, env(), decrypt);
  assert.equal(cfg.datasetId, '777');
  assert.equal(cfg.token, DB_TOKEN);
  assert.equal(cfg.datasetSource, 'database');
  assert.equal(cfg.tokenSource, 'database');
  const onlyDataset = resolveMetaCrmConfig({ dataset_id: '777', token_encrypted: null }, env(), decrypt);
  assert.equal(onlyDataset.token, ENV_TOKEN, 'a token never saved still comes from the environment');
});

test('switched off is off even with both values; nothing anywhere is "none"', () => {
  assert.equal(resolveMetaCrmConfig({ enabled: false, dataset_id: '777', token_encrypted: 'enc:db' }, env(), decrypt).enabled, false);
  const bare = resolveMetaCrmConfig(null, env({ metaCrmDatasetId: '', metaCrmCapiToken: '' }), decrypt);
  assert.equal(bare.datasetSource, 'none');
  assert.equal(bare.tokenSource, 'none');
  assert.equal(adminView(bare).configured, false);
});

test('a stored token this server cannot decrypt is reported, and the environment answers', () => {
  const cfg = resolveMetaCrmConfig({ dataset_id: '777', token_encrypted: 'enc:other-key' }, env(), decrypt);
  assert.equal(cfg.tokenUnreadable, true);
  assert.equal(cfg.token, ENV_TOKEN);
  assert.equal(cfg.tokenSource, 'environment');
});

test('the row read: only "table not there yet" falls back to the environment; any other failure is thrown', async () => {
  const { getMetaCrmSettingsRow } = require('../database/metaCrmSettings');
  const original = console.warn;
  console.warn = () => {};
  try {
    const missingTable = Object.assign(new Error('relation "meta_crm_settings" does not exist'), { code: '42P01' });
    assert.equal(await getMetaCrmSettingsRow(async () => { throw missingTable; }), null);
  } finally { console.warn = original; }
  const outage = Object.assign(new Error('Connection terminated unexpectedly'), { code: 'ECONNRESET' });
  await assert.rejects(getMetaCrmSettingsRow(async () => { throw outage; }), /Connection terminated/);
  const row = { id: 1, enabled: false };
  assert.deepEqual(await getMetaCrmSettingsRow(async () => ({ rows: [row] })), row);
});

test('the admin view carries the last four characters and never the token', () => {
  const view = adminView(resolveMetaCrmConfig({ dataset_id: '777', token_encrypted: 'enc:db', token_last4: 'DBTK' }, env(), decrypt));
  assert.equal(view.tokenLast4, 'DBTK');
  assert.equal(rules.maskLast4(view.tokenLast4), '••••DBTK');
  assert.ok(!JSON.stringify(view).includes(DB_TOKEN));
  assert.ok(!('token' in view));
});

test('inputs: dataset digits only; token one piece with no whitespace; blank token means "keep"', () => {
  assert.equal(rules.normalizeDatasetId(' 123456 '), '123456');
  for (const bad of ['', 'abc', '12 34', '12-34', '1.2']) assert.throws(() => rules.normalizeDatasetId(bad), { statusCode: 400 });
  assert.equal(rules.normalizeToken(''), '');
  assert.equal(rules.normalizeToken('   '), '');
  assert.equal(rules.normalizeToken(` ${DB_TOKEN} `), DB_TOKEN);
  for (const bad of ['EAAG token with spaces in it', 'EAAG\nsecond-line-0000000000', 'short']) {
    assert.throws(() => rules.normalizeToken(bad), { statusCode: 400 });
  }
  assert.equal(rules.normalizeTestEventCode(' TEST12345 '), 'TEST12345');
  assert.throws(() => rules.normalizeTestEventCode('TEST 1'), { statusCode: 400 });
});

test('a Test passes only when the token check passed and nothing that ran failed; "not run" is not a failure', () => {
  const c = (key, status) => ({ key, status });
  assert.equal(rules.testPassed([c('token', 'pass'), c('test_event', 'not_run'), c('bitrix', 'pass'), c('dry_run', 'pass')]), true);
  assert.equal(rules.testPassed([c('token', 'fail'), c('test_event', 'not_run')]), false);
  assert.equal(rules.testPassed([c('token', 'pass'), c('bitrix', 'fail')]), false);
  assert.equal(rules.testPassed([]), false);
});

test('Meta error codes are explained in plain words', () => {
  assert.match(rules.explainGraphError({ code: 190 }), /does not accept this access token/);
  assert.match(rules.explainGraphError({ code: 100 }), /cannot see a dataset with this ID/);
  assert.match(rules.explainGraphError({ code: 200 }), /missing a permission/);
  assert.match(rules.explainGraphError({ code: 4 }), /limiting requests/);
  assert.match(rules.explainGraphError({ status: 502 }), /problem of its own/);
});

test('redactSecret takes the token out of any text, and any access_token= pair', () => {
  const text = `failed for ${DB_TOKEN} at https://x/?access_token=abc123&y=1`;
  const out = redactSecret(text, DB_TOKEN);
  assert.ok(!out.includes(DB_TOKEN));
  assert.ok(!out.includes('abc123'));
  assert.equal(redactSecret('ordinary words', ''), 'ordinary words');
});
