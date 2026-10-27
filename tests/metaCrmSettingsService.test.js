'use strict';

/**
 * Settings → Facebook ↔ Bitrix: Save and the switch, over an in-memory settings
 * store with the real module's resolution. The server does not trust the
 * browser — a save is proven against Meta again and stores nothing that fails
 * — and a save with no new token keeps the stored one.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const service = require('../services/metaCrm/settingsService');
const { resolveMetaCrmConfig, adminView } = require('../database/metaCrmSettings');

const OLD = 'EAAG-old-stored-token-00000000-OLDT';
const NEW = 'EAAG-new-pasted-token-11111111-NEWT';

function fakeDeps({ proof = 'pass', row = {} } = {}) {
  const state = { row: { enabled: null, dataset_id: '111', token: OLD, ...row } };
  const proved = [];
  const tested = [];
  const settings = {
    async getMetaCrmConfig() {
      return resolveMetaCrmConfig({ ...state.row, token_encrypted: state.row.token ? 'enc' : null, token_last4: state.row.token?.slice(-4) },
        { metaCrmDatasetId: '', metaCrmCapiToken: '', metaGraphVersion: 'v25.0' }, () => state.row.token);
    },
    adminView,
    async saveMetaCrmSettings({ datasetId, token, updatedBy }) {
      state.row = { ...state.row, dataset_id: datasetId, enabled: true, updated_by: updatedBy, ...(token ? { token } : {}) };
    },
    async setMetaCrmEnabled(enabled, by) { state.row = { ...state.row, enabled, updated_by: by }; },
  };
  return {
    state,
    proved,
    tested,
    deps: {
      settings,
      getRun: async () => ({
        lastFinishedAt: '2026-10-27T15:00:00Z', lastStatus: 'error',
        lastError: `all 2 Meta send(s) failed — Meta 400 (code 190): bad token ${OLD}`,
        lastSummary: { deals: 9, recorded: 2, sent: 0, failed: 2, gave_up: 0 },
      }),
      runSettingsTest: async (v) => { tested.push(v); return { passed: true, checks: [] }; },
      checkTokenAndDataset: async (v) => {
        proved.push(v);
        return proof === 'pass'
          ? { key: 'token', status: 'pass', message: 'ok' }
          : { key: 'token', status: 'fail', message: 'Meta does not accept this access token.' };
      },
    },
  };
}

test('the view: dataset and its source, the token as ••••last4, the last run in plain numbers — never the token', async () => {
  const { deps } = fakeDeps();
  const view = await service.getSettingsView({ deps });
  assert.equal(view.datasetId, '111');
  assert.equal(view.datasetSource, 'database');
  assert.equal(view.tokenMasked, '••••OLDT');
  assert.equal(view.lastRun.sent, 0);
  assert.equal(view.lastRun.failed, 2);
  assert.match(view.lastRun.error, /code 190/);
  assert.ok(!JSON.stringify(view).includes(OLD), 'not in any field, not even inside the last error');
});

test('Save is refused when check (a) fails on the server, and nothing is stored', async () => {
  const f = fakeDeps({ proof: 'fail' });
  await assert.rejects(service.saveSettings({ datasetId: '222', token: NEW }, { by: 'owner', deps: f.deps }),
    (err) => err.statusCode === 400 && /Not saved/.test(err.message) && err.check.status === 'fail');
  assert.equal(f.state.row.dataset_id, '111');
  assert.equal(f.state.row.token, OLD);
  assert.deepEqual(f.proved[0], { datasetId: '222', token: NEW, graphVersion: 'v25.0' });
});

test('Save with a new token stores it, switches the sync on, and records who', async () => {
  const f = fakeDeps({ row: { enabled: false } });
  const view = await service.saveSettings({ datasetId: '222', token: NEW }, { by: 'owner', deps: f.deps });
  assert.equal(f.state.row.token, NEW);
  assert.equal(f.state.row.enabled, true);
  assert.equal(f.state.row.updated_by, 'owner');
  assert.equal(view.tokenMasked, '••••NEWT');
});

test('Save without a new token keeps the stored one — and proves THAT token against the new dataset', async () => {
  const f = fakeDeps();
  await service.saveSettings({ datasetId: '333', token: '' }, { by: 'owner', deps: f.deps });
  assert.equal(f.state.row.token, OLD);
  assert.equal(f.state.row.dataset_id, '333');
  assert.equal(f.proved[0].token, OLD);
});

test('nothing to save with: no token typed and none stored is a 400, not a call to Meta', async () => {
  const f = fakeDeps({ row: { token: null } });
  await assert.rejects(service.saveSettings({ datasetId: '333' }, { deps: f.deps }), { statusCode: 400 });
  await assert.rejects(service.testSettings({ datasetId: '333' }, { deps: f.deps }), { statusCode: 400 });
  assert.equal(f.proved.length + f.tested.length, 0);
});

test('bad input is refused before anything is asked', async () => {
  const f = fakeDeps();
  await assert.rejects(service.saveSettings({ datasetId: '12ab', token: NEW }, { deps: f.deps }), { statusCode: 400 });
  await assert.rejects(service.testSettings({ datasetId: '123', token: 'has a space in it 0000000000' }, { deps: f.deps }), { statusCode: 400 });
  await assert.rejects(service.testSettings({ datasetId: '123', testEventCode: 'TEST 1' }, { deps: f.deps }), { statusCode: 400 });
  assert.equal(f.proved.length + f.tested.length, 0);
});

test('Test with the token box empty uses the token in effect, and says so', async () => {
  const f = fakeDeps();
  const result = await service.testSettings({ datasetId: '444', testEventCode: 'TEST1' }, { deps: f.deps });
  assert.equal(result.usedStoredToken, true);
  assert.deepEqual(f.tested[0], { datasetId: '444', token: OLD, graphVersion: 'v25.0', testEventCode: 'TEST1' });
});

test('the switch: off keeps every stored value; it accepts only true or false', async () => {
  const f = fakeDeps();
  const view = await service.setEnabled(false, { by: 'owner', deps: f.deps });
  assert.equal(view.enabled, false);
  assert.equal(f.state.row.token, OLD);
  assert.equal(f.state.row.dataset_id, '111');
  await assert.rejects(service.setEnabled('no', { deps: f.deps }), { statusCode: 400 });
});
