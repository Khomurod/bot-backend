'use strict';

/**
 * Settings → Facebook ↔ Bitrix → Test: four checks on values that are NOT
 * saved yet, each answering pass / fail / not run in plain words.
 *
 *   a. token    Meta accepts the token and it can see this dataset — a READ
 *               (GET /<dataset id>), nothing sent.
 *   b. test     only with an Events Manager test event code: ONE event sent
 *               with `test_event_code`, so it shows under Test events and does
 *               not count for ad optimization. Without a code it does not run.
 *               A real (non-test) event is never sent from here — there is no
 *               code path that could: the send is refused without a code.
 *   c. bitrix   Bitrix is connected and pipeline 0 still has the six stage ids
 *               the stage table maps (services/metaCrm/stageEvents.js).
 *   d. dryRun   what a pass would send now (previewStageSync): deals changed in
 *               seven days, the Facebook leads among them, events per name and
 *               five examples. Records nothing, sends nothing.
 *
 * Every error text leaves through redactSecret with the token it was made
 * with. Nothing here throws: a check that cannot run is a failed check.
 */
const { CHECK, explainGraphError, testPassed } = require('./settingsRules');
const { STAGE_EVENTS, buildCapiEvent, CATEGORY_ID } = require('./stageEvents');
const { redactSecret } = require('../../lib/security/redactSecret');

/** Used only when the leads table holds no Facebook lead yet. */
const PLACEHOLDER_LEADGEN_ID = '100000000000001';
const STAGE_NAMES = Object.freeze({
  EXECUTING: 'Interested',
  UC_PBR3LM: 'Documents',
  UC_DISPATCH: 'Talking to Dispatch',
  UC_SAFETY: 'Sent to Safety',
  WON: 'Hired',
  LOSE: 'Lost',
});

function defaultTestDeps() {
  /* eslint-disable global-require */
  const capi = require('./capiClient');
  const stageSync = require('./stageSync');
  return {
    readDataset: capi.readDataset,
    sendEvents: capi.sendEvents,
    listStageRows: require('../bitrix24DealStages').listStageRows,
    preview: () => stageSync.previewStageSync(),
    latestLeadgenId: () => require('../../database/metaCrmEvents').latestLeadgenId(),
    now: () => Date.now(),
  };
  /* eslint-enable global-require */
}

const check = (key, label, status, message, detail = null) => ({ key, label, status, message, detail });

/** a. Can this token see this dataset? Exported: the save re-runs it itself. */
async function checkTokenAndDataset({ datasetId, token, graphVersion }, deps) {
  const label = 'Token and dataset';
  const res = await deps.readDataset({ datasetId, token, graphVersion });
  if (res.ok && String(res.id) === String(datasetId)) {
    const named = res.name ? ` "${res.name}"` : '';
    return check('token', label, CHECK.PASS, `Meta accepts the token, and it can see dataset${named} (${datasetId}).`);
  }
  if (res.ok) {
    return check('token', label, CHECK.FAIL, `Meta answered for a different object (${res.id || 'no id'}) than the dataset ID entered. Check the number.`);
  }
  const plain = res.timedOut ? 'Meta did not answer in time. Test again in a minute.' : explainGraphError(res);
  return check('token', label, CHECK.FAIL, plain, { metaError: redactSecret(res.error, token), code: res.code ?? null });
}

/** b. One TEST event, only with a test event code. */
async function checkTestEvent({ datasetId, token, graphVersion, testEventCode, tokenOk }, deps) {
  const label = 'Test event';
  if (!testEventCode) {
    return check('test_event', label, CHECK.NOT_RUN,
      'Not run: no test event code was given. To send one test event, open Events Manager → your CRM dataset → Test events, copy the code (e.g. TEST12345) and test again.');
  }
  if (!tokenOk) return check('test_event', label, CHECK.NOT_RUN, 'Not run, because the token check above did not pass.');
  let leadgenId = PLACEHOLDER_LEADGEN_ID;
  try { leadgenId = (await deps.latestLeadgenId()) || PLACEHOLDER_LEADGEN_ID; } catch { /* the placeholder is enough for a test */ }
  const event = {
    ...buildCapiEvent({ leadgenId, eventName: 'Qualified', eventTime: new Date(deps.now()) }),
    // Never the real events' `bitrix:<lead>:<event>` id, so a test cannot
    // stand in for — or be deduplicated against — a real report.
    event_id: `wenze-settings-test:${deps.now()}`,
  };
  const res = await deps.sendEvents({ datasetId, token, graphVersion, events: [event], testEventCode });
  if (res.ok && res.received > 0) {
    return check('test_event', label, CHECK.PASS,
      'Meta received the test event. Open Events Manager → Test events to see it; it does not count for ad optimization.');
  }
  if (res.ok) {
    return check('test_event', label, CHECK.FAIL, 'Meta answered, but says it received no event. Check the test event code and the dataset ID.');
  }
  const plain = res.timedOut ? 'Meta did not answer in time. Test again in a minute.' : explainGraphError(res);
  return check('test_event', label, CHECK.FAIL, plain, { metaError: redactSecret(res.error, token), code: res.code ?? null });
}

/** c. Bitrix connected, and pipeline 0 still has every mapped stage. */
async function checkBitrixStages(deps, token) {
  const label = 'Bitrix pipeline';
  let rows;
  try {
    rows = await deps.listStageRows(Number(CATEGORY_ID));
  } catch (err) {
    if (err?.reason === 'not_configured') {
      return { connected: false, result: check('bitrix', label, CHECK.FAIL, 'Bitrix24 is not connected. Connect it in Settings → RingCentral → Bitrix24.') };
    }
    return { connected: false, result: check('bitrix', label, CHECK.FAIL, `Bitrix could not be read: ${redactSecret(err?.message, token)}`) };
  }
  const present = new Set((rows || []).map((r) => String(r.STATUS_ID || '')));
  const missing = Object.keys(STAGE_EVENTS).filter((id) => !present.has(id));
  if (missing.length) {
    const named = missing.map((id) => `${STAGE_NAMES[id] || id} (${id})`).join(', ');
    return {
      connected: true,
      result: check('bitrix', label, CHECK.FAIL,
        `Bitrix is connected, but the hiring pipeline no longer has: ${named}. Those deals would report nothing until the stage table is updated.`,
        { missing }),
    };
  }
  return { connected: true, result: check('bitrix', label, CHECK.PASS, 'Bitrix is connected and the hiring pipeline has all six stages this sync reports.') };
}

/** d. What a pass would send now. */
async function checkDryRun(deps, { bitrixConnected }, token) {
  const label = 'Dry run';
  if (!bitrixConnected) return check('dry_run', label, CHECK.NOT_RUN, 'Not run, because Bitrix could not be read.');
  try {
    const p = await deps.preview();
    const sends = `${p.wouldSend.Qualified} Qualified, ${p.wouldSend.Converted} Converted, ${p.wouldSend.Lost} Lost`;
    const partial = p.complete ? '' : ' (Bitrix returned more deals than one pass reads; the count is a lower bound)';
    return check('dry_run', label, CHECK.PASS,
      `${p.dealsChanged} deal(s) changed in the last 7 days${partial}; ${p.facebookDeals} came from Facebook leads. A pass now would send ${sends}`
        + `${p.alreadyReported ? `, and skip ${p.alreadyReported} already reported` : ''}. Nothing was recorded or sent.`,
      p);
  } catch (err) {
    return check('dry_run', label, CHECK.FAIL, `The dry run could not finish: ${redactSecret(err?.message, token)}`);
  }
}

/** All four, in order. `{ passed, checks }` — `passed` is what unlocks Save. */
async function runSettingsTest({ datasetId, token, testEventCode = '', graphVersion }, deps = defaultTestDeps()) {
  const a = await checkTokenAndDataset({ datasetId, token, graphVersion }, deps);
  const b = await checkTestEvent({
    datasetId, token, graphVersion, testEventCode, tokenOk: a.status === CHECK.PASS,
  }, deps);
  const c = await checkBitrixStages(deps, token);
  const d = await checkDryRun(deps, { bitrixConnected: c.connected }, token);
  const checks = [a, b, c.result, d];
  return { passed: testPassed(checks), checks };
}

module.exports = {
  PLACEHOLDER_LEADGEN_ID,
  defaultTestDeps,
  checkTokenAndDataset,
  runSettingsTest,
};
