'use strict';

/**
 * Settings → Facebook ↔ Bitrix: what the panel shows, its Test, its Save and
 * its ON/OFF switch. The routes (server/routes/settings/metaCrmRoutes.js) only
 * translate HTTP; the rules are here and in settingsRules.js.
 *
 * THE SERVER DOES NOT TRUST THE BROWSER. The panel keeps Save disabled until a
 * Test passed with the values in the form, but a save request is proven again
 * here: check (a) — Meta accepts the token and it can see the dataset — runs on
 * the values being saved, and a save that fails it stores nothing.
 *
 * A SAVE WITHOUT A NEW TOKEN KEEPS THE STORED ONE (or the environment's, if
 * none was ever stored). Test does the same, so a dataset ID can be corrected
 * without pasting the token again.
 */
const {
  normalizeDatasetId, normalizeToken, normalizeTestEventCode, maskLast4, invalid, CHECK,
} = require('./settingsRules');
const { redactSecret } = require('../../lib/security/redactSecret');

const SERVICE_KEY = 'meta_crm_stage_sync';

function defaultDeps() {
  /* eslint-disable global-require */
  const settingsTest = require('./settingsTest');
  return {
    settings: require('../../database/metaCrmSettings'),
    getRun: require('../../database/backgroundRuns').getRun,
    runSettingsTest: (values) => settingsTest.runSettingsTest(values),
    checkTokenAndDataset: (values) => settingsTest.checkTokenAndDataset(values, settingsTest.defaultTestDeps()),
  };
  /* eslint-enable global-require */
}

/** The last pass from the run ledger, in the panel's words — never the token. */
function lastRunView(run, token) {
  if (!run) return null;
  const s = run.lastSummary || {};
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
  return {
    finishedAt: run.lastFinishedAt || null,
    status: run.lastStatus || null,
    error: run.lastError ? redactSecret(run.lastError, token) : null,
    deals: num(s.deals),
    recorded: num(s.recorded),
    sent: num(s.sent),
    failed: num(s.failed),
    gaveUp: num(s.gave_up),
    lastOkAt: run.lastOkAt || null,
    consecutiveFailures: run.consecutiveFailures || 0,
  };
}

async function getSettingsView({ deps = defaultDeps() } = {}) {
  const cfg = await deps.settings.getMetaCrmConfig();
  const view = deps.settings.adminView(cfg);
  return {
    ...view,
    tokenMasked: maskLast4(view.tokenLast4),
    lastRun: lastRunView(await deps.getRun(SERVICE_KEY), cfg.token),
  };
}

/**
 * The values a Test or a Save works with: the dataset id typed, and the token
 * typed or — when the box was left empty — the one in effect now.
 */
async function effectiveValues(body, deps) {
  const datasetId = normalizeDatasetId(body?.datasetId);
  const typedToken = normalizeToken(body?.token);
  const cfg = await deps.settings.getMetaCrmConfig();
  const token = typedToken || cfg.token;
  if (!token) throw invalid('Paste the access token — none is stored yet.');
  return { datasetId, typedToken, token, graphVersion: cfg.graphVersion, usedStoredToken: !typedToken };
}

async function testSettings(body, { deps = defaultDeps() } = {}) {
  const values = await effectiveValues(body, deps);
  const testEventCode = normalizeTestEventCode(body?.testEventCode);
  const result = await deps.runSettingsTest({
    datasetId: values.datasetId, token: values.token, graphVersion: values.graphVersion, testEventCode,
  });
  return { ...result, usedStoredToken: values.usedStoredToken };
}

/** Save — only what passes check (a) here, on the server, now. */
async function saveSettings(body, { by = null, deps = defaultDeps() } = {}) {
  const values = await effectiveValues(body, deps);
  const proof = await deps.checkTokenAndDataset({
    datasetId: values.datasetId, token: values.token, graphVersion: values.graphVersion,
  });
  if (proof.status !== CHECK.PASS) {
    const err = invalid(`Not saved: ${proof.message}`);
    err.check = proof;
    throw err;
  }
  await deps.settings.saveMetaCrmSettings({ datasetId: values.datasetId, token: values.typedToken, updatedBy: by });
  return getSettingsView({ deps });
}

async function setEnabled(enabled, { by = null, deps = defaultDeps() } = {}) {
  if (typeof enabled !== 'boolean') throw invalid('enabled must be true or false');
  await deps.settings.setMetaCrmEnabled(enabled, by);
  return getSettingsView({ deps });
}

module.exports = {
  SERVICE_KEY,
  lastRunView,
  getSettingsView,
  testSettings,
  saveSettings,
  setEnabled,
};
