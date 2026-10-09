'use strict';

/**
 * Economy mode: the dated switch, the pause list, and how the roster honours it.
 *
 * October 2026 the database's monthly transfer allowance was nearly spent and
 * going over restricts the database outright. The owner chose what keeps
 * running; these pin that choice — which passes stand down, that only an
 * explicit future date turns it on, that a held service starts by itself when
 * the date passes, and that a pass sharing a timer with live work is refused
 * by the ledger wrapper rather than by not starting the timer.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  resolveEconomy, isEconomyPausedKey, economyPauseReason, economyIntervalMs,
  ECONOMY_PAUSED_KEYS, ECONOMY_SLOW_INTERVAL_MS, MAX_ECONOMY_DAYS,
} = require('../lib/operations/economyMode');
const { getServiceEntry } = require('../lib/operations/backgroundServiceCatalog');

const NOW = Date.parse('2026-10-09T18:00:00Z');
const UNTIL = '2026-10-21T00:00:00Z';
const ECONOMY_PATH = path.resolve(__dirname, '../services/operations/economy.js');

function withEnv(t, value) {
  const before = process.env.ECONOMY_MODE_UNTIL;
  if (value === undefined) delete process.env.ECONOMY_MODE_UNTIL;
  else process.env.ECONOMY_MODE_UNTIL = value;
  t.after(() => {
    if (before === undefined) delete process.env.ECONOMY_MODE_UNTIL;
    else process.env.ECONOMY_MODE_UNTIL = before;
  });
}

function freshEconomy() {
  delete require.cache[ECONOMY_PATH];
  // eslint-disable-next-line global-require
  return require(ECONOMY_PATH);
}

// ─── the switch ──────────────────────────────────────────────────────────────

test('OFF unless a future date is set — no hidden default in the code', () => {
  assert.equal(resolveEconomy({ env: {}, now: NOW }).active, false);
  assert.equal(resolveEconomy({ env: { ECONOMY_MODE_UNTIL: '' }, now: NOW }).active, false);
  assert.equal(resolveEconomy({ env: { ECONOMY_MODE_UNTIL: 'off' }, now: NOW }).active, false);
  assert.equal(resolveEconomy({ env: { ECONOMY_MODE_UNTIL: '2026-10-01T00:00:00Z' }, now: NOW }).active, false,
    'a past date has simply ended');
});

test('ON until the date, and says until when', () => {
  const state = resolveEconomy({ env: { ECONOMY_MODE_UNTIL: UNTIL }, now: NOW });
  assert.deepEqual(state, {
    active: true, until: '2026-10-21T00:00:00.000Z', untilMs: Date.parse(UNTIL), problem: null,
  });
  assert.equal(resolveEconomy({ env: { ECONOMY_MODE_UNTIL: UNTIL }, now: Date.parse(UNTIL) }).active, false,
    'it ends AT the date, not a tick after');
});

test('an unreadable value is OFF and says why', () => {
  const state = resolveEconomy({ env: { ECONOMY_MODE_UNTIL: 'next tuesday' }, now: NOW });
  assert.equal(state.active, false);
  assert.match(state.problem, /not a date/);
});

test(`A DATE MORE THAN ${MAX_ECONOMY_DAYS} DAYS AWAY IS A TYPO — off, loudly`, () => {
  // 2027 for 2026 would pause half the application for a year, and nothing that
  // would notice runs while economy mode is on.
  const state = resolveEconomy({ env: { ECONOMY_MODE_UNTIL: '2027-10-21T00:00:00Z' }, now: NOW });
  assert.equal(state.active, false);
  assert.match(state.problem, /typo/);
});

test('A REJECTED TYPO STAYS REJECTED as its date approaches — judged from when the process started', () => {
  // Measured from the moving clock, `2027-10-21` left in place would come of
  // age forty-five days before it and quietly switch itself on.
  const startedAt = NOW;
  const later = Date.parse('2027-09-30T00:00:00Z'); // 21 days before the typo'd date
  const state = resolveEconomy({ env: { ECONOMY_MODE_UNTIL: '2027-10-21T00:00:00Z' }, now: later, startedAt });
  assert.equal(state.active, false);
  assert.match(state.problem, /typo/);
  assert.equal(resolveEconomy({ env: { ECONOMY_MODE_UNTIL: UNTIL }, now: NOW + 1000, startedAt }).active, true,
    'a real date set at start is honoured as the clock moves');
});

// ─── the pause list ──────────────────────────────────────────────────────────

test('every paused key and every slowed key is a real catalogue entry', () => {
  for (const key of [...ECONOMY_PAUSED_KEYS, ...Object.keys(ECONOMY_SLOW_INTERVAL_MS)]) {
    assert.ok(getServiceEntry(key), `${key} must be a catalogued background service`);
  }
});

test('WHAT THE OWNER KEPT RUNNING is never on the pause list', () => {
  // Driver chats and home-time requests, Samsara, candidate leads and SMS,
  // money codes, scheduled broadcasts, and the delivery of every notice.
  for (const kept of [
    'scheduler', 'home_time_reminders', 'facebook_webhooks', 'recruiter_logins', 'recruiting_after_hours',
    'finance_document_reader', 'finance_weekly_report', 'notification_drain', 'raise_approval',
    'return_to_road', 'route_control', 'dispatch_eta', 'dispatch_board_poll', 'home_time_board_presence',
  ]) {
    assert.equal(isEconomyPausedKey(kept), false, `${kept} must keep running`);
  }
});

test('a paused pass gets a reason only while economy mode is on', () => {
  const on = resolveEconomy({ env: { ECONOMY_MODE_UNTIL: UNTIL }, now: NOW });
  const off = resolveEconomy({ env: {}, now: NOW });
  assert.equal(economyPauseReason('datatruck_documents', on),
    'paused to save database traffic until 2026-10-21T00:00:00.000Z');
  assert.equal(economyPauseReason('datatruck_documents', off), null);
  assert.equal(economyPauseReason('scheduler', on), null);
});

test('THE BOARD IS READ EVERY FOUR HOURS — the Sunday raise review needs one under six', () => {
  const on = resolveEconomy({ env: { ECONOMY_MODE_UNTIL: UNTIL }, now: NOW });
  assert.equal(economyIntervalMs('dispatch_board_poll', 5 * 60 * 1000, on), 4 * 60 * 60 * 1000);
  assert.ok(ECONOMY_SLOW_INTERVAL_MS.dispatch_board_poll < 6 * 60 * 60 * 1000);
  assert.equal(economyIntervalMs('dispatch_board_poll', 5 * 60 * 1000, { active: false }), 5 * 60 * 1000);
  assert.equal(economyIntervalMs('scheduler', 60 * 1000, on), 60 * 1000, 'nothing else is slowed');
  assert.equal(economyIntervalMs('dispatch_board_poll', 8 * 60 * 60 * 1000, on), 8 * 60 * 60 * 1000,
    'never faster than an operator configured');
});

test('A SLOWED PASS THAT FAILED retries at its normal pace — the raise review refuses a failed read', () => {
  const on = resolveEconomy({ env: { ECONOMY_MODE_UNTIL: UNTIL }, now: NOW });
  assert.equal(economyIntervalMs('dispatch_board_poll', 5 * 60 * 1000, on, { failed: true }), 5 * 60 * 1000);
  assert.equal(economyIntervalMs('dispatch_board_poll', 5 * 60 * 1000, on, { failed: false }), 4 * 60 * 60 * 1000);
});

// ─── holding a service, and letting it go ────────────────────────────────────

test('a service whose passes are all paused is held, and starts when the date passes', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  withEnv(t, new Date(Date.now() + 60_000).toISOString());
  const economy = freshEconomy();
  t.after(() => economy.cancelEconomyEnd());

  let started = 0;
  assert.equal(economy.launchUnlessPaused(['datatruck_documents'], () => { started += 1; }), true);
  assert.equal(started, 0, 'nothing that could reach the database runs');
  assert.equal(economy.launchUnlessPaused(['scheduler'], () => { started += 1; }), false);
  assert.equal(started, 1, 'a service that is not paused starts at once');

  economy.scheduleEconomyEnd();
  // The date passes (the switch is read again when the timer fires).
  process.env.ECONOMY_MODE_UNTIL = new Date(Date.now() - 1000).toISOString();
  t.mock.timers.tick(60_000);
  assert.equal(started, 2, 'the held service started by itself');
  assert.equal(economy.heldCount(), 0);
});

test('a service with even one pass that keeps running is started normally', (t) => {
  withEnv(t, UNTIL);
  const economy = freshEconomy();
  t.after(() => economy.cancelEconomyEnd());
  let started = 0;
  economy.launchUnlessPaused(['consistency_sweep', 'notification_drain'], () => { started += 1; });
  assert.equal(started, 1);
});

test('a shutdown cancels the release — nothing starts in a process that is going away', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  withEnv(t, new Date(Date.now() + 60_000).toISOString());
  const economy = freshEconomy();
  let started = 0;
  economy.launchUnlessPaused(['fuel_risk'], () => { started += 1; });
  economy.scheduleEconomyEnd();
  economy.cancelEconomyEnd();
  process.env.ECONOMY_MODE_UNTIL = 'off';
  t.mock.timers.tick(120_000);
  assert.equal(started, 0);
});

test('with the switch off, every service starts and nothing is written', async (t) => {
  withEnv(t, undefined);
  const economy = freshEconomy();
  let started = 0;
  assert.equal(economy.launchUnlessPaused(['datatruck_documents'], () => { started += 1; }), false);
  assert.equal(started, 1);
  const writes = [];
  const noted = await economy.notePausedServices({ runs: { async recordRunFinish(...a) { writes.push(a); return true; } } });
  assert.equal(noted, 0);
  assert.deepEqual(writes, []);
  assert.equal(economy.describeEconomyAtBoot(), null);
});

test('the ledger says "paused until …" once per paused pass, as blocked — never as a failure', async (t) => {
  withEnv(t, UNTIL);
  const economy = freshEconomy();
  const writes = [];
  const noted = await economy.notePausedServices({
    runs: { async recordRunFinish(key, args) { writes.push({ key, ...args }); return true; } },
  });
  assert.equal(noted, ECONOMY_PAUSED_KEYS.length);
  for (const w of writes) {
    assert.equal(w.status, 'blocked');
    assert.match(w.error, /^paused to save database traffic until 2026-10-21/);
  }
  assert.match(economy.describeEconomyAtBoot(), /^\[ECONOMY\] ON until 2026-10-21T00:00:00\.000Z/);
});

// ─── the roster honours it ───────────────────────────────────────────────────

const ROSTER = fs.readFileSync(path.resolve(__dirname, '../services/backgroundServices.js'), 'utf8');
const SERVICES_DIR = path.resolve(__dirname, '../services');

function serviceSources() {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) out.push(fs.readFileSync(full, 'utf8'));
    }
  };
  walk(SERVICES_DIR);
  return out.join('\n');
}

test('EVERY PAUSED KEY IS ACTUALLY STOOD DOWN — held at boot, or refused by the ledger wrapper', () => {
  const held = new Set([...ROSTER.matchAll(/launchUnlessPaused\(\['([a-z_]+)'\]/g)].map((m) => m[1]));
  const sources = serviceSources();
  for (const key of ECONOMY_PAUSED_KEYS) {
    const wrapped = new RegExp(`withRunRecord\\('${key}'`).test(sources);
    assert.ok(held.has(key) || wrapped,
      `${key} is on the pause list but neither held in the roster nor run through withRunRecord`);
  }
  for (const key of held) assert.ok(isEconomyPausedKey(key), `${key} is held but not on the pause list`);
});

test('the consistency timer is NOT held — it also drains the notification queue', () => {
  assert.match(ROSTER, /^\s*startConsistencyService\(\);/m);
  assert.match(ROSTER, /^\s*startScheduler\(\);/m);
  assert.match(ROSTER, /^\s*startDispatchBoardPoller\(\);/m);
});
