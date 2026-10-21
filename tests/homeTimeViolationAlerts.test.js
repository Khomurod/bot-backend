'use strict';

/**
 * services/homeTime/violationAlerts.js and the Bitrix webhook route — the
 * reconciliation pass, the go-live baseline, exactly-once posting and the
 * webhook's secret, against an in-memory store with the real store's
 * guarantees (the Pg suite proves those on PostgreSQL).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const alerts = require('../services/homeTime/violationAlerts');
const { createHomeTimeViolationWebhookRoutes } = require('../server/routes/homeTimeViolationWebhookRoutes');

const FIELDS = {
  UF_CRM_HT_FROM: {}, UF_CRM_HT_UNTIL: {}, UF_CRM_HT_LAST_DAYS: {}, UF_CRM_HT_ROAD_BEFORE: {}, UF_CRM_HT_ALLOW: {},
};
const STAGES = ['C33:UC_HTEARLY', 'C33:UC_HTREDFLAG', 'C33:UC_HTEARLYOVER'].map((id) => ({ STATUS_ID: id }));

const card = (id, stage, from = '2026-10-03') => ({
  ID: String(id), TITLE: `Driver ${id}`, CATEGORY_ID: '33', STAGE_ID: stage,
  UF_CRM_HT_FROM: from, UF_CRM_HT_LAST_DAYS: '6', UF_CRM_HT_ROAD_BEFORE: '17', UF_CRM_HT_ALLOW: '4',
});

/** A store with the real one's rules: UNIQUE (deal, stay, violation), leases, write-once decisions. */
function fakeStore(settings) {
  const rows = [];
  let next = 1;
  return {
    rows,
    settings,
    baselined: 0,
    async getViolationSettings() { return this.settings; },
    async markBaselined() { this.baselined += 1; this.settings.violation_alerts_baselined_at = new Date(); },
    async listRecordedViolations(dealId, homeFrom) {
      return rows.filter((r) => r.deal_id === String(dealId) && r.home_from === homeFrom).map((r) => r.violation);
    },
    async recordViolations({ deal, violations, state }) {
      const out = [];
      for (const v of violations) {
        if (rows.some((r) => r.deal_id === String(deal.dealId) && r.home_from === deal.homeFrom && r.violation === v)) continue;
        const row = {
          id: next++, deal_id: String(deal.dealId), home_from: deal.homeFrom, violation: v, state,
          driver_name: deal.driverName, road_days: deal.roadDays, home_days: deal.homeDays, claimed: false,
        };
        rows.push(row);
        out.push({ ...row });
      }
      return out;
    },
    async claimForPosting(ids) {
      const got = rows.filter((r) => ids.includes(r.id) && ['pending', 'failed'].includes(r.state) && !r.claimed);
      for (const r of got) r.claimed = true;
      return got.map((r) => ({ ...r }));
    },
    async markPosted(ids, { chatId, messageId }) {
      for (const r of rows) if (ids.includes(r.id)) Object.assign(r, { state: 'posted', chat_id: chatId, telegram_message_id: messageId, claimed: false });
    },
    async markFailed(ids, error) {
      for (const r of rows) if (ids.includes(r.id)) Object.assign(r, { state: 'failed', last_error: error, claimed: false });
    },
    async listDue() { return rows.filter((r) => ['pending', 'failed'].includes(r.state) && !r.claimed).map((r) => ({ ...r })); },
  };
}

function fakeTelegram({ fail = false } = {}) {
  const sent = [];
  return {
    sent,
    async sendMessage(chatId, text, extra) {
      if (fail) throw new Error('400: Bad Request: chat not found');
      sent.push({ chatId, text, extra });
      return { message_id: 900 + sent.length };
    },
  };
}

function deps(store, cards, { fields = FIELDS, stages = STAGES } = {}) {
  const findings = { filed: [], resolved: [] };
  return {
    store,
    findings: {
      async upsertFinding(f) { findings.filed.push(f); return { id: findings.filed.length }; },
      async resolveClearedFindings(keys, keep) { findings.resolved.push({ keys, keep }); },
    },
    seen: findings,
    mentions: ['@cameron_acc', '@Ellaaccounting'],
    now: () => Date.now(),
    async bitrix(method, params) {
      if (method === 'crm.deal.fields') return fields;
      if (method === 'crm.status.list') return stages;
      if (method === 'crm.deal.list') return (params.start || 0) === 0 ? cards : [];
      if (method === 'crm.deal.get') return cards.find((c) => Number(c.ID) === Number(params.id)) || null;
      throw new Error(`unexpected ${method}`);
    },
  };
}

const ON = () => ({ violation_alerts_enabled: true, violation_alerts_chat_id: '-1009', violation_alerts_baselined_at: new Date() });

test.beforeEach(() => alerts.__resetSchemaCacheForTests());

test('NOTHING IS SENT until a group is saved and the switch is on', async () => {
  const off = await alerts.runViolationPass({ deps: deps(fakeStore({ violation_alerts_enabled: false }), []) });
  assert.deepEqual(off, { blocked: 'switched off' });
  const noGroup = await alerts.runViolationPass({ deps: deps(fakeStore({ violation_alerts_enabled: true }), []) });
  assert.deepEqual(noGroup, { blocked: 'no group saved' });
});

test('Bitrix without the fields or stages this reads: the pass stops and says which', async () => {
  const d = deps(fakeStore(ON()), [], { fields: { UF_CRM_HT_FROM: {} } });
  const res = await alerts.runViolationPass({ deps: d });
  assert.match(res.blocked, /missing fields UF_CRM_HT_UNTIL, UF_CRM_HT_LAST_DAYS, UF_CRM_HT_ROAD_BEFORE, UF_CRM_HT_ALLOW/);
});

test('THE GO-LIVE BASELINE: cards already in a violation stage are recorded, NOT posted', async () => {
  const store = fakeStore({ ...ON(), violation_alerts_baselined_at: null });
  const telegram = fakeTelegram();
  const res = await alerts.runViolationPass({
    telegram, deps: deps(store, [card(1, 'C33:UC_HTEARLY'), card(2, 'C33:UC_HTEARLYOVER')]),
  });
  assert.equal(res.baselined, 2, 'two cards');
  assert.equal(store.rows.length, 3, 'early, and early + overstay');
  assert.equal(telegram.sent.length, 0);
  assert.equal(store.baselined, 1);
  assert.ok(store.rows.every((r) => r.state === 'baselined'));

  // The next pass posts nothing for them either.
  const again = await alerts.runViolationPass({
    telegram, deps: deps(store, [card(1, 'C33:UC_HTEARLY'), card(2, 'C33:UC_HTEARLYOVER')]),
  });
  assert.equal(again.posted, 0);
  assert.equal(telegram.sent.length, 0);
});

test('a new violation is posted ONCE, with the buttons, however many passes see it', async () => {
  const store = fakeStore(ON());
  const telegram = fakeTelegram();
  const cards = [card(7, 'C33:UC_HTEARLY')];
  await alerts.runViolationPass({ telegram, deps: deps(store, cards) });
  await alerts.runViolationPass({ telegram, deps: deps(store, cards) });
  assert.equal(telegram.sent.length, 1);
  const [msg] = telegram.sent;
  assert.equal(msg.chatId, '-1009');
  assert.match(msg.text, /Came home early<\/b> — 17 days on the road/);
  assert.deepEqual(msg.extra.reply_markup.inline_keyboard[0].map((b) => b.callback_data), ['htv:c:1', 'htv:n:1']);
});

test('EARLY, then EARLY & OVERSTAYED: the second message names only the overstay', async () => {
  const store = fakeStore(ON());
  const telegram = fakeTelegram();
  await alerts.runViolationPass({ telegram, deps: deps(store, [card(7, 'C33:UC_HTEARLY')]) });
  await alerts.runViolationPass({ telegram, deps: deps(store, [card(7, 'C33:UC_HTEARLYOVER')]) });
  assert.equal(telegram.sent.length, 2);
  assert.match(telegram.sent[1].text, /Violation: <b>Overstayed<\/b>/);
  assert.doesNotMatch(telegram.sent[1].text, /Came home early/);
});

test('straight to EARLY & OVERSTAYED: ONE message naming both', async () => {
  const store = fakeStore(ON());
  const telegram = fakeTelegram();
  await alerts.runViolationPass({ telegram, deps: deps(store, [card(8, 'C33:UC_HTEARLYOVER')]) });
  assert.equal(telegram.sent.length, 1);
  assert.match(telegram.sent[0].text, /Violations:\n• <b>Came home early<\/b>[^\n]*\n• <b>Overstayed<\/b>/);
  assert.deepEqual(store.rows.map((r) => r.telegram_message_id), [901, 901], 'two rows, one message');
});

test('the NEXT home stay is a new alert', async () => {
  const store = fakeStore(ON());
  const telegram = fakeTelegram();
  await alerts.runViolationPass({ telegram, deps: deps(store, [card(9, 'C33:UC_HTEARLY', '2026-10-03')]) });
  await alerts.runViolationPass({ telegram, deps: deps(store, [card(9, 'C33:UC_HTEARLY', '2026-11-07')]) });
  assert.equal(telegram.sent.length, 2);
});

test('NO HOME-SINCE DATE: nothing posted, a finding filed, and it clears once the card is fixed', async () => {
  const store = fakeStore(ON());
  const telegram = fakeTelegram();
  const d = deps(store, [card(10, 'C33:UC_HTREDFLAG', '')]);
  const res = await alerts.runViolationPass({ telegram, deps: d });
  assert.equal(res.incomplete, 1);
  assert.equal(telegram.sent.length, 0);
  assert.equal(d.seen.filed[0].checkKey, 'home_time.violation_card_incomplete');
  assert.deepEqual(d.seen.resolved.at(-1), { keys: ['home_time.violation_card_incomplete'], keep: [1] });
});

test('a send that failed is retried by the next pass — still once', async () => {
  const store = fakeStore(ON());
  const cards = [card(11, 'C33:UC_HTEARLY')];
  await alerts.runViolationPass({ telegram: fakeTelegram({ fail: true }), deps: deps(store, cards) });
  assert.equal(store.rows[0].state, 'failed');
  const telegram = fakeTelegram();
  const res = await alerts.runViolationPass({ telegram, deps: deps(store, cards) });
  assert.equal(res.retried, 1);
  assert.equal(telegram.sent.length, 1);
});

test('the webhook re-reads the card, and posts nothing before the baseline', async () => {
  const before = fakeStore({ ...ON(), violation_alerts_baselined_at: null });
  const t1 = fakeTelegram();
  assert.deepEqual(await alerts.handleWebhookDeal(12, { telegram: t1, deps: deps(before, [card(12, 'C33:UC_HTEARLY')]) }),
    { outcome: 'awaiting_baseline' });
  assert.equal(t1.sent.length, 0);

  const store = fakeStore(ON());
  const telegram = fakeTelegram();
  // The robot fired on EARLY, but by now the card has moved back to the road: the stage decides.
  assert.deepEqual(await alerts.handleWebhookDeal(12, { telegram, deps: deps(store, [card(12, 'C33:UC_ROADU4W')]) }),
    { outcome: 'not_a_violation_stage' });
  assert.deepEqual(await alerts.handleWebhookDeal(12, { telegram, deps: deps(store, [card(12, 'C33:UC_HTEARLY')]) }),
    { outcome: 'posted' });
  // The pass that follows sees the same card and posts nothing more.
  await alerts.runViolationPass({ telegram, deps: deps(store, [card(12, 'C33:UC_HTEARLY')]) });
  assert.equal(telegram.sent.length, 1);
});

// ── the route ────────────────────────────────────────────────────────────────

async function hit(app, url, { method = 'POST', form = null } = {}) {
  const server = app.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${url}`, {
      method,
      headers: form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : undefined,
      body: form ? new URLSearchParams(form).toString() : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  } finally { server.close(); }
}

function appWith({ secret }) {
  const calls = [];
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.use('/api/integrations', createHomeTimeViolationWebhookRoutes({
    handle: async (dealId) => { calls.push(dealId); },
    resolveSecret: async () => secret || null,
  }));
  return { app, calls };
}

test('THE WEBHOOK: the right secret is accepted at once; a wrong or missing one is refused', async () => {
  const { app, calls } = appWith({ secret: 'long-random-secret' });
  const url = '/api/integrations/bitrix/home-time-violation';
  assert.equal((await hit(app, `${url}?token=nope`, { form: { 'document_id[2]': 'DEAL_5' } })).status, 401);
  assert.equal((await hit(app, url, { form: { 'document_id[2]': 'DEAL_5' } })).status, 401);
  assert.equal((await hit(app, `${url}?token=long-random-secret`, { form: { 'document_id[2]': 'DEAL_5' } })).status, 202);
  assert.equal((await hit(app, `${url}?token=long-random-secret&deal_id=6`, { method: 'GET' })).status, 202);
  assert.equal((await hit(app, `${url}?token=long-random-secret`, { form: { foo: 'bar' } })).status, 400);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(calls, [5, 6]);
});

test('no secret configured: the webhook refuses everything', async () => {
  const { app, calls } = appWith({ secret: '' });
  assert.equal((await hit(app, '/api/integrations/bitrix/home-time-violation?token=', { form: { deal_id: '5' } })).status, 401);
  assert.deepEqual(calls, []);
});

test('Bitrix not connected is a blocked pass, not a failure; Bitrix down is a failure', async () => {
  const notConnected = deps(fakeStore(ON()), []);
  notConnected.bitrix = async () => { throw Object.assign(new Error('Bitrix24 is not connected'), { reason: 'not_configured' }); };
  assert.deepEqual(await alerts.runViolationPass({ deps: notConnected }), { blocked: 'Bitrix24 is not connected' });

  const down = deps(fakeStore(ON()), []);
  down.bitrix = async () => { throw Object.assign(new Error('Bitrix unreachable'), { reason: 'network_error' }); };
  await assert.rejects(alerts.runViolationPass({ deps: down }), /unreachable/);
});
