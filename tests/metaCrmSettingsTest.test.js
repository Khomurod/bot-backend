'use strict';

/**
 * Settings → Facebook ↔ Bitrix → Test, against a fake Meta and a fake Bitrix:
 * each check says pass / warning / fail / not run in plain words, Meta's own
 * error is shown with the token taken out, a timeout is a failed check and not
 * a crash, a missing stage is named — and the Test NEVER sends anything Meta
 * would count: without a test event code nothing is sent at all, and with one
 * the only send is an exact copy of an event Meta already received.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { runSettingsTest, TEST_EVENT_NAME } = require('../services/metaCrm/settingsTest');
const { readTokenOwner, readDatasetQuality, sendEvents } = require('../services/metaCrm/capiClient');

const TOKEN = 'EAAG-settings-test-token-123456';
const ALL_STAGES = ['NEW', 'EXECUTING', 'UC_PBR3LM', 'UC_DISPATCH', 'UC_SAFETY', 'WON', 'LOSE'].map((id) => ({ STATUS_ID: id }));
const values = (over = {}) => ({ datasetId: '987654', token: TOKEN, graphVersion: 'v25.0', testEventCode: '', ...over });
const preview = {
  dealsChanged: 12, complete: true, facebookDeals: 7, planned: 5, alreadyReported: 1,
  wouldSend: { Qualified: 3, Converted: 1, Lost: 0 },
  examples: [{ dealId: 5603, stageId: 'EXECUTING', eventName: 'Qualified' }],
};
// The Qualified event the sync already sent — check b may only ever repeat it.
const ALREADY_SENT = { leadgen_id: '1668864698200916', event_name: 'Qualified', event_time: new Date('2026-10-26T18:30:00Z') };
// Meta's real answer (27 Oct 2026) for an ID it cannot see OR a dataset with no events in 48 hours.
const CODE_24 = {
  ok: false, status: 400, code: 24, subcode: 2044055,
  error: 'Meta 400 (code 24): The requested resource does not exist. Make sure that Dataset is healthy and there are at least some events being sent in the last 48h',
};

function fakes(over = {}) {
  const sent = [];
  const deps = {
    readTokenOwner: async () => ({ ok: true, id: '122100000000000001' }),
    readDatasetQuality: async () => ({ ok: true }),
    sendEvents: async (args) => { sent.push(args); return { ok: true, received: 1 }; },
    listStageRows: async () => ALL_STAGES,
    preview: async () => preview,
    latestRecentlySent: async () => ALREADY_SENT,
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
  assert.match(c.token.message, /can see dataset 987654/);
  assert.equal(c.test_event.status, 'not_run');
  assert.match(c.test_event.message, /Events Manager → your CRM dataset → Test events/);
  assert.equal(c.bitrix.status, 'pass');
  assert.equal(c.dry_run.status, 'pass');
  assert.match(c.dry_run.message, /12 deal\(s\).*7 came from Facebook.*3 Qualified, 1 Converted, 0 Lost.*Nothing was recorded or sent/);
  assert.deepEqual(c.dry_run.detail.examples, preview.examples);
  assert.equal(sent.length, 0, 'no code, no send — of any kind');
});

test('a correct Events Manager token: /me and dataset quality — never a read of the dataset object, which that token is refused', async () => {
  const asked = [];
  const { deps } = fakes({
    readTokenOwner: async (a) => { asked.push(['me', a]); return { ok: true, id: '1' }; },
    readDatasetQuality: async (a) => { asked.push(['quality', a]); return { ok: true }; },
  });
  const c = byKey(await runSettingsTest(values(), deps));
  assert.equal(c.token.status, 'pass');
  assert.deepEqual(asked.map(([k]) => k), ['me', 'quality']);
  assert.equal(asked[1][1].datasetId, '987654');
  assert.equal(c.token.detail, null);
});

test('Meta\'s code 24 (wrong ID, or no events in 48 hours) is a WARNING that still allows Save, with Meta\'s words', async () => {
  const { deps } = fakes({ readDatasetQuality: async () => CODE_24 });
  const result = await runSettingsTest(values(), deps);
  const c = byKey(result);
  assert.equal(c.token.status, 'warn');
  assert.match(c.token.message, /no events in the last 48 hours/);
  assert.match(c.token.message, /you can still save/);
  assert.equal(c.token.detail.code, 24);
  assert.equal(c.token.detail.subcode, 2044055);
  assert.equal(result.passed, true, 'a new dataset must be savable');
});

test('a token made without the Dataset Quality API option is told apart, and is a warning', async () => {
  const { deps } = fakes({ readDatasetQuality: async () => ({ ok: false, status: 403, code: 200, error: 'Meta 403 (code 200): Permissions error' }) });
  const result = await runSettingsTest(values(), deps);
  assert.equal(byKey(result).token.status, 'warn');
  assert.match(byKey(result).token.message, /without the "Dataset Quality API" option/);
  assert.equal(result.passed, true);
});

test('dataset quality times out or Meta breaks: a failed check, Save stays locked', async () => {
  for (const quality of [{ ok: false, timedOut: true, error: 'x' }, { ok: false, status: 503, error: 'Meta 503' }]) {
    const { deps } = fakes({ readDatasetQuality: async () => quality });
    const result = await runSettingsTest(values(), deps);
    assert.equal(byKey(result).token.status, 'fail');
    assert.equal(result.passed, false);
  }
});

test('with a test code: exactly ONE event, carrying test_event_code, an EXACT copy of a Qualified Meta already received', async () => {
  const asked = [];
  const { deps, sent } = fakes({ latestRecentlySent: async (name, datasetId) => { asked.push([name, datasetId]); return ALREADY_SENT; } });
  const result = await runSettingsTest(values({ testEventCode: 'TEST12345' }), deps);
  assert.equal(byKey(result).test_event.status, 'pass');
  // Only an event THIS dataset received: Meta deduplicates within one dataset.
  assert.deepEqual(asked, [[TEST_EVENT_NAME, '987654']]);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].testEventCode, 'TEST12345');
  assert.equal(sent[0].events.length, 1);
  const event = sent[0].events[0];
  // The real report's own id and time: Meta deduplicates it into the original.
  assert.equal(event.event_id, 'bitrix:1668864698200916:Qualified');
  assert.equal(event.event_name, 'Qualified');
  assert.equal(event.event_time, Math.floor(ALREADY_SENT.event_time.getTime() / 1000));
  assert.equal(event.user_data.lead_id, 1668864698200916);
});

test('a test code but nothing sent to Meta recently: the test event is NOT run — no made-up lead, no send', async () => {
  const { deps, sent } = fakes({ latestRecentlySent: async () => null });
  const result = await runSettingsTest(values({ testEventCode: 'TEST1' }), deps);
  const c = byKey(result);
  assert.equal(c.test_event.status, 'not_run');
  assert.match(c.test_event.message, /47 hours/);
  assert.match(c.test_event.message, /does not keep an event out of ads/);
  assert.equal(sent.length, 0);
  assert.equal(result.passed, true);
});

test('a code-24 warning still lets the test event run; a ledger that cannot be read fails b without sending', async () => {
  const warned = fakes({ readDatasetQuality: async () => CODE_24 });
  await runSettingsTest(values({ testEventCode: 'TEST1' }), warned.deps);
  assert.equal(warned.sent.length, 1);
  const broken = fakes({ latestRecentlySent: async () => { throw new Error(`db down ${TOKEN}`); } });
  const c = byKey(await runSettingsTest(values({ testEventCode: 'TEST1' }), broken.deps));
  assert.equal(c.test_event.status, 'fail');
  assert.ok(!c.test_event.message.includes(TOKEN));
  assert.equal(broken.sent.length, 0);
});

test('Meta refusing the event\'s lead (subcode 2804036) is explained in plain words', async () => {
  const { deps } = fakes({ sendEvents: async () => ({ ok: false, status: 400, code: 100, subcode: 2804036, error: 'Meta 400 (code 100): Invalid lead ID' }) });
  const c = byKey(await runSettingsTest(values({ testEventCode: 'TEST1' }), deps));
  assert.equal(c.test_event.status, 'fail');
  assert.match(c.test_event.message, /does not recognise that lead ID/);
});

test('the wire itself: a Test send puts test_event_code in the body; the reads are GETs; the token never in a URL', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => { calls.push({ url, opts }); return { ok: true, status: 200, json: async () => ({ events_received: 1, id: '1' }) }; };
  await sendEvents({ datasetId: '987654', token: TOKEN, graphVersion: 'v25.0', events: [{}], testEventCode: 'TEST1', fetchImpl });
  await readTokenOwner({ token: TOKEN, graphVersion: 'v25.0', fetchImpl });
  await readDatasetQuality({ datasetId: '987654', token: TOKEN, graphVersion: 'v25.0', fetchImpl });
  assert.equal(JSON.parse(calls[0].opts.body).test_event_code, 'TEST1');
  for (const call of calls) assert.ok(!call.url.includes(TOKEN), 'never in a URL');
  assert.match(calls[1].url, /\/v25\.0\/me\?fields=id$/);
  assert.match(calls[2].url, /\/v25\.0\/dataset_quality\?dataset_id=987654$/);
  for (const call of calls.slice(1)) {
    assert.equal(call.opts.method, 'GET');
    assert.equal(call.opts.headers.Authorization, `Bearer ${TOKEN}`);
  }
});

test('Meta answering "0 events received" is a failed test event, not a pass', async () => {
  const { deps } = fakes({ sendEvents: async () => ({ ok: true, received: 0 }) });
  const c = byKey(await runSettingsTest(values({ testEventCode: 'TEST1' }), deps));
  assert.equal(c.test_event.status, 'fail');
  assert.match(c.test_event.message, /received no event/);
});

test('Meta refuses the token: a failed with Meta\'s code and words (token removed), dataset never asked, b not run', async () => {
  let qualityAsked = false;
  const { deps, sent } = fakes({
    readTokenOwner: async () => ({ ok: false, status: 400, code: 190, error: `Meta 400 (code 190): Invalid OAuth access token ${TOKEN}` }),
    readDatasetQuality: async () => { qualityAsked = true; return { ok: true }; },
  });
  const result = await runSettingsTest(values({ testEventCode: 'TEST1' }), deps);
  const c = byKey(result);
  assert.equal(result.passed, false);
  assert.equal(c.token.status, 'fail');
  assert.match(c.token.message, /does not accept this access token/);
  assert.match(c.token.detail.metaError, /code 190/);
  assert.ok(!c.token.detail.metaError.includes(TOKEN));
  assert.equal(qualityAsked, false);
  assert.equal(c.test_event.status, 'not_run');
  assert.equal(sent.length, 0);
});

test('Meta does not answer: a failed check in plain words, never a crash', async () => {
  const { deps } = fakes({ readTokenOwner: async () => ({ ok: false, timedOut: true, retryable: true, error: 'Meta did not answer in 15000ms' }) });
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
