'use strict';

/**
 * Wenze decides home-time violations itself (owner, 11 November 2026):
 * lib/homeTime/ownViolations.js, lib/homeTime/cardMatch.js and the pass in
 * services/homeTime/ownViolations.js. Pinned: early (< 28 days on the road)
 * and overstay (> 4 days home) for company drivers; a flap of a few hours is
 * no stay and does not cut a road leg; a driver's own rule; an approved
 * request is agreed; nothing before Wenze started; one alert per violation
 * per stay; the pipeline-33 card moved when exactly one matches by the
 * one-letter rule. Names are made up.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { violationsFor, ruleFor } = require('../lib/homeTime/ownViolations');
const { sameDriver, matchCard } = require('../lib/homeTime/cardMatch');
const { runOwnViolationPass, stageFor } = require('../services/homeTime/ownViolations');

const T = (iso) => new Date(iso).getTime();
const cycle = (road, home, back, over = {}) => ({
  roadStartedAt: road, homeArrivedAt: home, returnToRoadAt: back, driverType: 'company_driver', driverName: 'Kwame Asante', ...over,
});
const SINCE = T('2026-11-11T00:00:00Z');

test('EARLY: home after fewer than 28 days on the road; OVERSTAY: more than 4 days home', () => {
  const now = T('2026-11-30T12:00:00Z');
  const early = violationsFor([
    cycle('2026-10-01T00:00:00Z', '2026-10-20T00:00:00Z', '2026-10-23T00:00:00Z'),
    cycle('2026-10-23T00:00:00Z', '2026-11-12T00:00:00Z', '2026-11-14T00:00:00Z'),
  ], { now, since: SINCE });
  assert.deepEqual(early.map((s) => [s.homeFrom, s.violations, s.roadDays, s.homeDays]), [['2026-11-11', ['early'], 20, 2]]);

  const over = violationsFor([cycle('2026-10-10T00:00:00Z', '2026-11-12T00:00:00Z', null)], { now: T('2026-11-17T06:00:00Z'), since: SINCE });
  assert.deepEqual(over[0].violations, ['overstay']);
  assert.equal(over[0].homeDays, 5);
  assert.deepEqual(violationsFor([cycle('2026-10-10T00:00:00Z', '2026-11-12T00:00:00Z', null)], { now: T('2026-11-16T06:00:00Z'), since: SINCE }), [],
    '4 days home is within the policy');
});

test('A FLAP of a few hours is no home stay, and does not cut the road leg', () => {
  const now = T('2026-11-30T00:00:00Z');
  const out = violationsFor([
    cycle('2026-10-01T00:00:00Z', '2026-10-05T00:00:00Z', '2026-10-05T03:00:00Z'), // a flap
    cycle('2026-10-05T03:00:00Z', '2026-11-12T00:00:00Z', '2026-11-14T00:00:00Z'),
  ], { now, since: T('2026-10-01T00:00:00Z') });
  assert.deepEqual(out, [], '42 days on the road counted from Oct 1 — not 38 from the flap, and the flap judged as nothing');
});

test('owner-operators, stays before Wenze started, and approved requests are not judged', () => {
  const now = T('2026-11-30T00:00:00Z');
  const rows = [cycle('2026-11-01T00:00:00Z', '2026-11-12T00:00:00Z', '2026-11-20T00:00:00Z')];
  assert.equal(violationsFor(rows, { now, since: SINCE }).length, 1);
  assert.equal(violationsFor([{ ...rows[0], driverType: 'owner_operator' }], { now, since: SINCE }).length, 0);
  assert.equal(violationsFor(rows, { now, since: T('2026-11-13T00:00:00Z') }).length, 0, 'no backlog');
  assert.equal(violationsFor([{ ...rows[0], linkedRequestStatus: 'approved' }], { now, since: SINCE }).length, 0, 'agreed');
});

test("A DRIVER'S OWN RULE replaces the policy while it is valid", () => {
  const now = T('2026-11-30T00:00:00Z');
  const rows = [cycle('2026-10-20T00:00:00Z', '2026-11-12T00:00:00Z', '2026-11-15T12:00:00Z')];
  const threeAndThree = { roadDays: 21, homeDays: 3, validUntil: null };
  assert.deepEqual(violationsFor(rows, { now, since: SINCE }).map((s) => s.violations), [['early']]);
  assert.deepEqual(violationsFor(rows, { now, since: SINCE, exception: threeAndThree }), [], '23 days road, 3 days home: fine for them');
  assert.equal(ruleFor({ roadDays: 21, homeDays: 3, validUntil: '2026-11-01' }, '2026-11-12').roadDays, 28, 'an expired rule no longer applies');
});

test('THE CARD by name: same words any order, or ONE letter in one word; two matching is no match', () => {
  assert.equal(sameDriver('GOOWIN LEAH ANN', 'Leah Ann Goodwin'), true);
  assert.equal(sameDriver('Leah Goodwin', 'Lea Godwin'), false, 'two letters');
  assert.equal(sameDriver('Ali Khan', 'Aly Khan'), false, 'a short word must match exactly');
  assert.deepEqual(matchCard('Kwame Asante', [{ id: 1, title: 'KWAME ASANTE' }, { id: 2, title: 'Kwame Asanti' }]), { ambiguous: 2 });
  assert.equal(stageFor(['early', 'overstay']), 'C33:UC_HTEARLYOVER');
});

function passDeps({ cards = [{ ID: '77', TITLE: 'ASANTE KWAME', STAGE_ID: 'C33:UC_ROADU4W' }] } = {}) {
  const rows = [];
  const calls = { bitrix: [], sent: [] };
  const store = {
    startOwnViolations: async () => '2026-11-11T00:00:00Z',
    recordOwnViolations: async ({ groupId, homeFrom, violations, driverName, roadDays, homeDays }) => {
      const fresh = violations.filter((v) => !rows.some((r) => r.group_id === groupId && r.home_from === homeFrom && r.violation === v));
      const made = fresh.map((v) => ({
        id: rows.length + 1, source: 'wenze', group_id: groupId, home_from: homeFrom, violation: v, driver_name: driverName,
        road_days: roadDays, home_days: homeDays, state: 'pending',
      }));
      rows.push(...made.map((r) => ({ ...r })));
      return made;
    },
    claimForPosting: async (ids) => rows.filter((r) => ids.includes(r.id) && r.state === 'pending'),
    markPosted: async (ids) => { for (const r of rows) if (ids.includes(r.id)) r.state = 'posted'; },
    markFailed: async () => {},
    listDue: async () => rows.filter((r) => r.state === 'pending'),
    setBitrixNote: async (ids, card) => { for (const r of rows) if (ids.includes(r.id)) Object.assign(r, { deal_id: card.dealId, bitrix_note: card.note }); },
  };
  return {
    rows,
    calls,
    telegram: { sendMessage: async (chatId, text) => { calls.sent.push(text); return { message_id: 500 + calls.sent.length }; } },
    deps: {
      store,
      now: () => T('2026-11-18T00:00:00Z'),
      mentions: ['@acc'],
      cycles: async () => new Map([[5, [cycle('2026-10-25T00:00:00Z', '2026-11-12T00:00:00Z', null)]]]),
      exceptions: async () => [],
      bitrix: async (method, params) => {
        calls.bitrix.push({ method, params });
        return method === 'crm.deal.list' ? cards : true;
      },
    },
  };
}

test('THE PASS: the first one only records when Wenze started — nothing is judged or posted', async () => {
  const { deps, telegram, calls } = passDeps();
  const out = await runOwnViolationPass({ telegram, chatId: '-1009', settings: {}, deps });
  assert.equal(out.started, true);
  assert.equal(calls.sent.length, 0);
});

test('THE PASS: early AND overstay posted to accounting ONCE, and the card moved with its fields', async () => {
  const { deps, telegram, calls, rows } = passDeps();
  const settings = { own_violations_since: '2026-11-11T00:00:00Z' };
  const out = await runOwnViolationPass({ telegram, chatId: '-1009', settings, deps });
  assert.equal(out.posted, 1);
  assert.equal(calls.sent.length, 1, 'one message naming both');
  assert.match(calls.sent[0], /KWAME ASANTE[\s\S]*18 days on the road \(policy: 28\)[\s\S]*6 days at home \(policy: 4\)/);
  const update = calls.bitrix.find((c) => c.method === 'crm.deal.update');
  assert.deepEqual(update.params, {
    id: 77,
    fields: {
      STAGE_ID: 'C33:UC_HTEARLYOVER', UF_CRM_HT_FROM: '2026-11-11', UF_CRM_HT_LAST_DAYS: 6, UF_CRM_HT_ROAD_BEFORE: 18,
    },
    params: { REGISTER_SONET_EVENT: 'Y' },
  });
  assert.equal(rows[0].deal_id, 77);

  await runOwnViolationPass({ telegram, chatId: '-1009', settings, deps });
  assert.equal(calls.sent.length, 1, 'a second pass posts nothing new');
});

test('no card, or two, matching: the alert still goes; the card is not moved and the row says why', async () => {
  const { deps, telegram, calls, rows } = passDeps({ cards: [] });
  await runOwnViolationPass({ telegram, chatId: '-1009', settings: { own_violations_since: '2026-11-11T00:00:00Z' }, deps });
  assert.equal(calls.sent.length, 1);
  assert.equal(calls.bitrix.filter((c) => c.method === 'crm.deal.update').length, 0);
  assert.match(rows[0].bitrix_note, /no Bitrix card/);
});

const { buildViolationMessage } = require('../lib/homeTime/violations');
const admin = require('../services/homeTime/policyExceptionsAdmin');

test("the alert names the driver's own rule when that was the yardstick", () => {
  const text = buildViolationMessage({
    driverName: 'Kwame Asante', violations: ['overstay'], homeDays: 4, homeFrom: '2026-11-12', policy: { roadDays: 21, homeDays: 3 },
  });
  assert.match(text, /4 days at home \(their own rule: 3\)/);
});

test('A RULE is saved only for a driver, with whole numbers; nothing set is refused', async () => {
  const saved = [];
  const deps = { store: { setException: async (rule, by) => { saved.push({ rule, by }); return rule; } } };
  await admin.save({ groupId: '5', roadDays: '21', homeDays: '3', validUntil: '2026-12-31', note: 'agreed' }, 'amelia', deps);
  assert.deepEqual(saved[0], {
    rule: {
      groupId: 5, roadDays: 21, homeDays: 3, validUntil: '2026-12-31', note: 'agreed',
    },
    by: 'amelia',
  });
  await assert.rejects(admin.save({ groupId: '5' }, null, deps), /Set the days on the road/);
  await assert.rejects(admin.save({ groupId: '', roadDays: 21 }, null, deps), /Choose the driver/);
  await assert.rejects(admin.save({ groupId: 5, homeDays: 2.5 }, null, deps), /whole number/);
});

test('THE OLD BITRIX EXCEPTIONS are listed with the driver each card names — never imported by themselves', async () => {
  const deps = {
    call: async () => [
      { ID: '1', TITLE: 'KWAME ASANTE', STAGE_ID: 'C33:UC_ROADU4W', UF_CRM_HT_ALLOW: '7', UF_CRM_HT_UNTIL: '2026-11-20T00:00:00+03:00' },
      { ID: '2', TITLE: 'YAW BOATENG', STAGE_ID: 'C33:UC_HTAGREED' },
      { ID: '3', TITLE: 'NO RULE', STAGE_ID: 'C33:UC_ROADU4W' },
    ],
    store: { listDriverGroups: async () => [{ id: 5, name: 'WENZE UNIT 012', driverName: 'Kwame Asante' }] },
  };
  const cards = await admin.bitrixPreview(deps);
  assert.deepEqual(cards.map((c) => [c.dealId, c.allowDays, c.homeUntil, c.agreed, c.groupId]), [
    [1, '7', '2026-11-20', false, 5],
    [2, null, null, true, null],
  ]);
});
