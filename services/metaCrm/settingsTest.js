'use strict';

/**
 * Settings → Facebook ↔ Bitrix → Test: four checks on values that are NOT
 * saved yet, each answering pass / warning / fail / not run in plain words.
 *
 *   a. token    two READS, nothing sent: GET /me (Meta accepts the token) and
 *               the Dataset Quality API (the token can see this dataset).
 *               NOT GET /<dataset id>: the Events Manager "Generate access
 *               token" token cannot read the dataset object and gets "(#100)
 *               Missing Permission" even when it is exactly right. The verdict
 *               is settingsRules.judgeTokenAndDataset — the save re-runs it.
 *   b. test     only with an Events Manager test event code, and only as an
 *               exact copy (same event_id, same event_time) of a Qualified
 *               event THIS dataset ALREADY received in the last 47 hours
 *               (Meta deduplicates within one dataset only), so Meta
 *               deduplicates it rather than counting a second conversion. A
 *               test code does NOT keep an event out of ads: Meta may use
 *               test events for targeting and measurement. And Meta refuses
 *               an event about a lead it does not know, so there is no
 *               harmless made-up lead to send about. With no such event: not
 *               run, and why.
 *   c. bitrix   Bitrix is connected and pipeline 0 still has the six stage ids
 *               the stage table maps (services/metaCrm/stageEvents.js).
 *   d. dryRun   what a pass would send now (previewStageSync): deals changed in
 *               seven days, the Facebook leads among them, events per name and
 *               five examples. Records nothing, sends nothing.
 *
 * Every error text leaves through redactSecret with the token it was made
 * with. Nothing here throws: a check that cannot run is a failed check.
 */
const { CHECK, explainGraphError, judgeTokenAndDataset, testPassed } = require('./settingsRules');
const { STAGE_EVENTS, buildCapiEvent, CATEGORY_ID } = require('./stageEvents');
const { redactSecret } = require('../../lib/security/redactSecret');

/** The one event name check b may duplicate. */
const TEST_EVENT_NAME = 'Qualified';
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
    readTokenOwner: capi.readTokenOwner,
    readDatasetQuality: capi.readDatasetQuality,
    sendEvents: capi.sendEvents,
    listStageRows: require('../bitrix24DealStages').listStageRows,
    preview: () => stageSync.previewStageSync(),
    latestRecentlySent: (eventName, datasetId) => require('../../database/metaCrmEvents').latestRecentlySent(eventName, datasetId),
  };
  /* eslint-enable global-require */
}

const check = (key, label, status, message, detail = null) => ({ key, label, status, message, detail });
const metaDetail = (res, token) => ({ metaError: redactSecret(res.error, token), code: res.code ?? null, subcode: res.subcode ?? null });

/** a. Is the token alive, and can it see this dataset? Exported: the save re-runs it. */
async function checkTokenAndDataset({ datasetId, token, graphVersion }, deps) {
  const label = 'Token and dataset';
  const owner = await deps.readTokenOwner({ token, graphVersion });
  const quality = owner.ok ? await deps.readDatasetQuality({ datasetId, token, graphVersion }) : null;
  const { status, message } = judgeTokenAndDataset({ owner, quality, datasetId });
  // Meta's own words beside any answer that was not a plain yes.
  const refused = !owner.ok ? owner : (quality && !quality.ok ? quality : null);
  return check('token', label, status, message, refused ? metaDetail(refused, token) : null);
}

/** b. One TEST event, a duplicate of one Meta already counted — or not run. */
async function checkTestEvent({ datasetId, token, graphVersion, testEventCode, tokenOk }, deps) {
  const label = 'Test event';
  if (!testEventCode) {
    return check('test_event', label, CHECK.NOT_RUN,
      'Not run: no test event code was given. To send a test event, open Events Manager → your CRM dataset → Test events, copy the code (e.g. TEST12345) and test again.');
  }
  if (!tokenOk) return check('test_event', label, CHECK.NOT_RUN, 'Not run, because the token check above did not pass.');
  let sent = null;
  try {
    sent = await deps.latestRecentlySent(TEST_EVENT_NAME, datasetId);
  } catch (err) {
    return check('test_event', label, CHECK.FAIL, `The sent-events ledger could not be read: ${redactSecret(err?.message, token)}`);
  }
  if (!sent) {
    return check('test_event', label, CHECK.NOT_RUN,
      `Not run: no lead has been reported to dataset ${datasetId} as Qualified in the last 47 hours. A test event is only ever an exact copy of one Meta already received, so it changes nothing — Meta refuses made-up leads, and a test code does not keep an event out of ads. Test again after the sync has reported one.`);
  }
  const event = buildCapiEvent({ leadgenId: sent.leadgen_id, eventName: sent.event_name, eventTime: sent.event_time });
  const res = await deps.sendEvents({ datasetId, token, graphVersion, events: [event], testEventCode });
  if (res.ok && res.received > 0) {
    return check('test_event', label, CHECK.PASS,
      `Meta received the test event (a copy of lead ${sent.leadgen_id}'s Qualified, which Meta already had, so it counts once). Open Events Manager → Test events to see it.`);
  }
  if (res.ok) {
    return check('test_event', label, CHECK.FAIL, 'Meta answered, but says it received no event. Check the test event code and the dataset ID.');
  }
  const plain = res.timedOut ? 'Meta did not answer in time. Test again in a minute.' : explainGraphError(res);
  return check('test_event', label, CHECK.FAIL, plain, metaDetail(res, token));
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
    datasetId, token, graphVersion, testEventCode, tokenOk: a.status !== CHECK.FAIL,
  }, deps);
  const c = await checkBitrixStages(deps, token);
  const d = await checkDryRun(deps, { bitrixConnected: c.connected }, token);
  const checks = [a, b, c.result, d];
  return { passed: testPassed(checks), checks };
}

module.exports = {
  TEST_EVENT_NAME,
  defaultTestDeps,
  checkTokenAndDataset,
  runSettingsTest,
};
