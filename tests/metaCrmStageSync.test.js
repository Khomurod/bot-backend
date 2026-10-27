'use strict';

/**
 * services/metaCrm/stageSync.js and services/metaCrm/capiClient.js — the pass
 * against a fake Bitrix, a fake Meta and an in-memory store with the real
 * store's guarantees (tests/metaCrmEventsPg.test.js proves those on
 * PostgreSQL): blocked until configured, each lead's event sent once, a
 * failure retried and then given up, the token never in a URL or an error.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { runStageSyncPass, __test } = require('../services/metaCrm/stageSync');
const { sendEvents } = require('../services/metaCrm/capiClient');

const NOW = Date.parse('2026-10-27T15:00:00Z');
const TOKEN = 'EAAG-secret-token';

const deal = (id, leadId, stage, moved = '2026-10-27T12:00:00Z') => ({
  ID: String(id), LEAD_ID: String(leadId), CATEGORY_ID: '0', STAGE_ID: stage, MOVED_TIME: moved, DATE_MODIFY: moved,
});

/** UNIQUE (leadgen_id, event_name); sent rows never pending again; five attempts. */
function fakeStore(leadgenByBitrix) {
  const rows = [];
  return {
    rows,
    async findLeadgenIdsByBitrixIds(ids) {
      return new Map(ids.filter((id) => leadgenByBitrix[id]).map((id) => [String(id), leadgenByBitrix[id]]));
    },
    async recordEvents(plan) {
      const inserted = [];
      for (const p of plan) {
        if (rows.some((r) => r.leadgen_id === p.leadgenId && r.event_name === p.eventName)) continue;
        const row = {
          id: rows.length + 1, leadgen_id: p.leadgenId, event_name: p.eventName, deal_id: String(p.dealId),
          stage_id: p.stageId, event_time: p.eventTime, state: 'pending', attempts: 0, last_error: null,
        };
        rows.push(row);
        inserted.push(row.id);
      }
      return inserted;
    },
    async listDue() { return rows.filter((r) => r.state === 'pending'); },
    async markSent(id) {
      const r = rows.find((x) => x.id === id && x.state === 'pending');
      if (!r) return false;
      Object.assign(r, { state: 'sent', attempts: r.attempts + 1 });
      return true;
    },
    async markFailed(id, error) {
      const r = rows.find((x) => x.id === id && x.state === 'pending');
      if (!r) return null;
      r.attempts += 1;
      r.last_error = error;
      if (r.attempts >= 5) r.state = 'gave_up';
      return r.state;
    },
  };
}

function setup({ deals, leads, meta = () => ({ ok: true, received: 1 }), cfg = {} } = {}) {
  const sent = [];
  const bitrixCalls = [];
  const store = fakeStore(leads || {});
  const deps = {
    config: () => ({ datasetId: '111222333', token: TOKEN, graphVersion: 'v25.0', ...cfg }),
    bitrixEntity: async () => cfg.entity || 'lead',
    store,
    bitrix: async (method, params) => {
      bitrixCalls.push({ method, params });
      return params.start === 0 ? deals : [];
    },
    sendEvents: async (args) => { sent.push(args); return meta(args); },
    now: () => NOW,
  };
  return { deps, store, sent, bitrixCalls };
}

test('not configured: blocked, and neither Bitrix nor Meta is asked anything', async () => {
  for (const cfg of [{ datasetId: '' }, { token: '' }]) {
    const { deps, sent, bitrixCalls } = setup({ deals: [deal(1, 10, 'WON')], cfg });
    const res = await runStageSyncPass({ deps });
    assert.match(res.blocked, /META_CRM_DATASET_ID/);
    assert.equal(bitrixCalls.length, 0);
    assert.equal(sent.length, 0);
  }
});

test('reads only pipeline 0 deals changed in the last seven days, and writes nothing to Bitrix', async () => {
  const { deps, bitrixCalls } = setup({ deals: [] });
  await runStageSyncPass({ deps });
  assert.deepEqual(bitrixCalls.map((c) => c.method), ['crm.deal.list']);
  assert.deepEqual(bitrixCalls[0].params.filter, { CATEGORY_ID: 0, '>=DATE_MODIFY': '2026-10-20T15:00:00+00:00' });
});

test("each Facebook lead's event reaches Meta once, however often its deal moves or the pass runs", async () => {
  const leads = { 10: '1668864698200916', 11: '1234567890123' };
  const { deps, store, sent } = setup({
    leads,
    deals: [deal(5603, 10, 'EXECUTING'), deal(5604, 11, 'LOSE'), deal(5605, 99, 'WON'), deal(5606, 10, 'PREPARATION')],
  });
  const first = await runStageSyncPass({ deps });
  assert.equal(first.recorded, 2);
  assert.equal(first.sent, 2);
  assert.deepEqual(sent.map((s) => s.events[0].event_name).sort(), ['Lost', 'Qualified']);
  assert.equal(sent[0].events.length, 1, 'one event per request');

  // The same lead moves on to Documents: still one "Qualified".
  const again = setup({ leads, deals: [deal(5603, 10, 'UC_PBR3LM')] });
  again.deps.store = store;
  const second = await runStageSyncPass({ deps: again.deps });
  assert.equal(second.recorded, 0);
  assert.equal(second.sent, 0);
  assert.equal(again.sent.length, 0);
  assert.equal(store.rows.filter((r) => r.state === 'sent').length, 2);
});

test('a refused send is retried on the next pass, then given up after five attempts — never a success turned into a retry', async () => {
  let fail = true;
  const { deps, store, sent } = setup({
    leads: { 10: '1668864698200916', 11: '1234567890123' },
    deals: [deal(1, 10, 'WON'), deal(2, 11, 'LOSE')],
    meta: (args) => (fail && args.events[0].event_name === 'Converted'
      ? { ok: false, retryable: false, error: 'Meta 400 (code 100): Invalid parameter' }
      : { ok: true, received: 1 }),
  });
  const first = await runStageSyncPass({ deps });
  assert.equal(first.sent, 1);
  assert.equal(first.failed, 1);
  // Only the refused one is left, so each of these passes fails as a whole.
  for (let i = 0; i < 5; i += 1) await runStageSyncPass({ deps }).catch(() => {}); // eslint-disable-line no-await-in-loop
  const converted = store.rows.find((r) => r.event_name === 'Converted');
  assert.equal(converted.state, 'gave_up');
  assert.equal(converted.attempts, 5);
  assert.equal(sent.filter((s) => s.events[0].event_name === 'Lost').length, 1, 'the sent one was never re-sent');
  fail = false;
});

test('every send failing is a failed pass (red on /api/health), with Meta\'s words and no token', async () => {
  const { deps } = setup({
    leads: { 10: '1668864698200916' },
    deals: [deal(1, 10, 'WON')],
    meta: () => ({ ok: false, retryable: false, error: 'Meta 401 (code 190): Invalid OAuth access token' }),
  });
  await assert.rejects(runStageSyncPass({ deps }), (err) => {
    assert.match(err.message, /Invalid OAuth access token/);
    assert.doesNotMatch(err.message, new RegExp(TOKEN));
    return true;
  });
});

test('Bitrix not connected is blocked, not a failure; Bitrix down is a failure', async () => {
  const notConnected = setup({ deals: [] });
  notConnected.deps.bitrix = async () => { const e = new Error('x'); e.reason = 'not_configured'; throw e; };
  assert.deepEqual(await runStageSyncPass({ deps: notConnected.deps }), { blocked: 'Bitrix24 is not connected' });
  const down = setup({ deals: [] });
  down.deps.bitrix = async () => { const e = new Error('Bitrix unreachable'); e.reason = 'network_error'; throw e; };
  await assert.rejects(runStageSyncPass({ deps: down.deps }), /Bitrix unreachable/);
});

test('leads created as deals (the saved Bitrix setting) are matched by the deal id', async () => {
  const { deps, sent } = setup({ cfg: { entity: 'deal' }, leads: { 5603: '1668864698200916' }, deals: [deal(5603, 0, 'WON')] });
  const res = await runStageSyncPass({ deps });
  assert.equal(res.sent, 1);
  assert.equal(sent[0].events[0].user_data.lead_id, 1668864698200916);
});

test('Bitrix is paged 50 at a time', async () => {
  const pages = [Array.from({ length: 50 }, (_, i) => deal(i + 1, i + 1, 'NEW')), [deal(99, 99, 'NEW')]];
  const calls = [];
  const res = await __test.listRecentDeals({ bitrix: async (m, p) => { calls.push(p.start); return pages[p.start / 50] || []; } }, NOW);
  assert.deepEqual(calls, [0, 50]);
  assert.equal(res.rows.length, 51);
  assert.equal(res.complete, true);
});

// ── the Conversions API client ───────────────────────────────────────────────

test('capiClient: the token goes in the body, never the URL; Meta\'s answer is read', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, body: JSON.parse(init.body) });
    return { ok: true, status: 200, json: async () => ({ events_received: 1, fbtrace_id: 'x' }) };
  };
  const res = await sendEvents({ datasetId: '111222333', token: TOKEN, graphVersion: 'v25.0', events: [{ a: 1 }], fetchImpl });
  assert.deepEqual(res, { ok: true, received: 1 });
  assert.equal(seen[0].url, 'https://graph.facebook.com/v25.0/111222333/events');
  assert.doesNotMatch(seen[0].url, new RegExp(TOKEN));
  assert.equal(seen[0].body.access_token, TOKEN);
  assert.deepEqual(seen[0].body.data, [{ a: 1 }]);
});

test('capiClient: an error carries Meta\'s words and status, a 5xx or 429 is retryable, a network error never throws', async () => {
  const refused = await sendEvents({
    datasetId: '1', token: TOKEN, graphVersion: 'v25.0', events: [],
    fetchImpl: async () => ({ ok: false, status: 400, json: async () => ({ error: { message: 'Invalid parameter', code: 100, error_user_msg: 'lead_id is not valid' } }) }),
  });
  assert.deepEqual(refused, { ok: false, retryable: false, error: 'Meta 400 (code 100): lead_id is not valid' });
  const busy = await sendEvents({
    datasetId: '1', token: TOKEN, graphVersion: 'v25.0', events: [],
    fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }),
  });
  assert.equal(busy.retryable, true);
  const offline = await sendEvents({
    datasetId: '1', token: TOKEN, graphVersion: 'v25.0', events: [],
    fetchImpl: async () => { throw new Error(`connect ECONNREFUSED ${TOKEN}`); },
  });
  assert.deepEqual(offline, { ok: false, retryable: true, error: 'Meta unreachable' });
});
