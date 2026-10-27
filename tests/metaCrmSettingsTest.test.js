'use strict';

/**
 * Settings → Facebook ↔ Bitrix → Test, against a fake Meta and a fake Bitrix:
 * each check says pass / fail / not run in plain words, Meta's own error is
 * shown with the token taken out, a timeout is a failed check and not a
 * crash, a missing stage is named — and the Test NEVER sends a non-test
 * event: without a test event code nothing is sent at all.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { runSettingsTest, PLACEHOLDER_LEADGEN_ID } = require('../services/metaCrm/settingsTest');
const { readDataset, sendEvents } = require('../services/metaCrm/capiClient');

const TOKEN = 'EAAG-settings-test-token-123456';
const ALL_STAGES = ['NEW', 'EXECUTING', 'UC_PBR3LM', 'UC_DISPATCH', 'UC_SAFETY', 'WON', 'LOSE'].map((id) => ({ STATUS_ID: id }));
const values = (over = {}) => ({ datasetId: '987654', token: TOKEN, graphVersion: 'v25.0', testEventCode: '', ...over });
const preview = {
  dealsChanged: 12, complete: true, facebookDeals: 7, planned: 5, alreadyReported: 1,
  wouldSend: { Qualified: 3, Converted: 1, Lost: 0 },
  examples: [{ dealId: 5603, stageId: 'EXECUTING', eventName: 'Qualified' }],
};

function fakes(over = {}) {
  const sent = [];
  const deps = {
    readDataset: async () => ({ ok: true, id: '987654', name: 'Wenze CRM' }),
    sendEvents: async (args) => { sent.push(args); return { ok: true, received: 1 }; },
    listStageRows: async () => ALL_STAGES,
    preview: async () => preview,
    latestLeadgenId: async () => '1668864698200916',
    now: () => Date.parse('2026-10-27T15:00:00Z'),
    ...over,
  };
  return { deps, sent };
}

const byKey = (result) => Object.fromEntries(result.checks.map((c) => [c.key, c]));

test('everything in order, no test code: a, c and d pass, the test event is "not run" with where to get a code, and NOTHING is sent', async () => {
  const { deps, sent } = fakes();
  const result = await runSettingsTest(values(), deps);
  const c = byKey(result);
  assert.equal(result.passed, true);
  assert.equal(c.token.status, 'pass');
  assert.match(c.token.message, /Wenze CRM/);
  assert.equal(c.test_event.status, 'not_run');
  assert.match(c.test_event.message, /Events Manager → your CRM dataset → Test events/);
  assert.equal(c.bitrix.status, 'pass');
  assert.equal(c.dry_run.status, 'pass');
  assert.match(c.dry_run.message, /12 deal\(s\).*7 came from Facebook.*3 Qualified, 1 Converted, 0 Lost.*Nothing was recorded or sent/);
  assert.deepEqual(c.dry_run.detail.examples, preview.examples);
  assert.equal(sent.length, 0, 'no code, no send — of any kind');
});

test('with a test code: exactly ONE event, carrying test_event_code, about a real lead, with an id no real report uses', async () => {
  const { deps, sent } = fakes();
  const result = await runSettingsTest(values({ testEventCode: 'TEST12345' }), deps);
  assert.equal(byKey(result).test_event.status, 'pass');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].testEventCode, 'TEST12345');
  assert.equal(sent[0].events.length, 1);
  assert.equal(sent[0].events[0].user_data.lead_id, 1668864698200916);
  assert.match(sent[0].events[0].event_id, /^wenze-settings-test:/);
});

test('the wire itself: a Test send puts test_event_code in the body, the token never in the URL', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => { calls.push({ url, opts }); return { ok: true, status: 200, json: async () => ({ events_received: 1, id: '987654' }) }; };
  await sendEvents({ datasetId: '987654', token: TOKEN, graphVersion: 'v25.0', events: [{}], testEventCode: 'TEST1', fetchImpl });
  await readDataset({ datasetId: '987654', token: TOKEN, graphVersion: 'v25.0', fetchImpl });
  assert.equal(JSON.parse(calls[0].opts.body).test_event_code, 'TEST1');
  for (const call of calls) assert.ok(!call.url.includes(TOKEN), 'never in a URL');
  assert.equal(calls[1].opts.method, 'GET');
  assert.equal(calls[1].opts.headers.Authorization, `Bearer ${TOKEN}`);
});

test('Meta answering "0 events received" is a failed test event, not a pass', async () => {
  const { deps } = fakes({ sendEvents: async () => ({ ok: true, received: 0 }) });
  const c = byKey(await runSettingsTest(values({ testEventCode: 'TEST1' }), deps));
  assert.equal(c.test_event.status, 'fail');
  assert.match(c.test_event.message, /received no event/);
});

test('no Facebook lead on record yet: the one test event uses the placeholder lead id', async () => {
  const { deps, sent } = fakes({ latestLeadgenId: async () => null });
  await runSettingsTest(values({ testEventCode: 'TEST1' }), deps);
  assert.equal(String(sent[0].events[0].user_data.lead_id), PLACEHOLDER_LEADGEN_ID);
});

test('Meta refuses the token: a failed with Meta\'s code and words (token removed), b not run, Save not unlocked', async () => {
  const { deps, sent } = fakes({
    readDataset: async () => ({ ok: false, status: 400, code: 190, error: `Meta 400 (code 190): Invalid OAuth access token ${TOKEN}` }),
  });
  const result = await runSettingsTest(values({ testEventCode: 'TEST1' }), deps);
  const c = byKey(result);
  assert.equal(result.passed, false);
  assert.equal(c.token.status, 'fail');
  assert.match(c.token.message, /does not accept this access token/);
  assert.match(c.token.detail.metaError, /code 190/);
  assert.ok(!c.token.detail.metaError.includes(TOKEN));
  assert.equal(c.test_event.status, 'not_run');
  assert.equal(sent.length, 0);
});

test('Meta does not answer: a failed check in plain words, never a crash', async () => {
  const { deps } = fakes({ readDataset: async () => ({ ok: false, timedOut: true, retryable: true, error: 'Meta did not answer in 15000ms' }) });
  const c = byKey(await runSettingsTest(values(), deps));
  assert.equal(c.token.status, 'fail');
  assert.match(c.token.message, /did not answer in time/);
});

test('a missing pipeline stage is named; Bitrix not connected fails c and does not run d', async () => {
  const missing = fakes({ listStageRows: async () => ALL_STAGES.filter((s) => s.STATUS_ID !== 'UC_SAFETY' && s.STATUS_ID !== 'WON') });
  const c1 = byKey(await runSettingsTest(values(), missing.deps));
  assert.equal(c1.bitrix.status, 'fail');
  assert.match(c1.bitrix.message, /Sent to Safety \(UC_SAFETY\), Hired \(WON\)/);
  assert.deepEqual(c1.bitrix.detail.missing, ['UC_SAFETY', 'WON']);

  const offline = fakes({ listStageRows: async () => { const e = new Error('no'); e.reason = 'not_configured'; throw e; } });
  const result = await runSettingsTest(values(), offline.deps);
  const c2 = byKey(result);
  assert.equal(c2.bitrix.status, 'fail');
  assert.match(c2.bitrix.message, /not connected/);
  assert.equal(c2.dry_run.status, 'not_run');
  assert.equal(result.passed, false);
});

test('a dry run that breaks is a failed check with the reason, the token removed', async () => {
  const { deps } = fakes({ preview: async () => { throw new Error(`Bitrix crm.deal.list: boom ${TOKEN}`); } });
  const c = byKey(await runSettingsTest(values(), deps));
  assert.equal(c.dry_run.status, 'fail');
  assert.ok(!c.dry_run.message.includes(TOKEN));
});
