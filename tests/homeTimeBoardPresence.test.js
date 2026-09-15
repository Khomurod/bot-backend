'use strict';

/**
 * Home In and Home Out, decided from the Dispatcher Board.
 *
 * THE CASES THAT MATTER ARE THE ONES THAT DO NOTHING. Two integrations updating
 * at different speeds is the failure this has to survive, so most of these
 * tests assert silence: a board a few minutes behind, a state Wenze just set, a
 * word that means nothing either way. A feature that flips a driver home and
 * back within an hour is worse than one that is slow.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  decideBoardPresence, describeBoardPresence, ACTION, DEFAULTS,
} = require('../lib/homeTime/boardPresence');
const { boardEndsHomeStay, boardSaysWorking } = require('../lib/board/statusSemantics');
const { runBoardPresencePass, CHECK_DISAGREES, MAX_TRANSITIONS_PER_PASS } = require('../services/homeTime/boardPresenceWatch');

const NOW = '2026-09-15T12:00:00.000Z';
const ago = (minutes) => new Date(Date.parse(NOW) - minutes * 60000).toISOString();
const decide = (over = {}) => decideBoardPresence({ nowIso: NOW, lastSeenAt: ago(5), ...over });

const ON_ROAD = { wenzeState: 'road', wenzeStateSince: ago(60 * 24 * 30) };
const AT_HOME = { wenzeState: 'home', wenzeStateSince: ago(60 * 24 * 3) };

// ─── opening a home stay ───

test('the board saying HOME opens a home cycle, dated when the board said it', () => {
  const out = decide({ boardStatus: 'HOME', statusChangedAt: ago(90), ...ON_ROAD });
  assert.equal(out.action, ACTION.OPEN_HOME);
  // Not "when Wenze got round to reading it" — otherwise a driver who went home
  // on Friday has a road clock three days short.
  assert.equal(out.eventAt, ago(90));
});

test('VACATION is home too', () => {
  assert.equal(decide({ boardStatus: 'VACATION', statusChangedAt: ago(90), ...ON_ROAD }).action, ACTION.OPEN_HOME);
});

test('a home time request is nowhere in this decision', () => {
  // The signature is the guarantee: there is no way to hand this a request.
  const params = decideBoardPresence.toString().slice(0, decideBoardPresence.toString().indexOf('}'));
  assert.ok(!/request/i.test(params), 'a request must not be an input to home-in detection');
});

// ─── closing a home stay ───

test('READY ends a home stay without ever meaning the driver is working', () => {
  assert.equal(decide({ boardStatus: 'READY', statusChangedAt: ago(90), ...AT_HOME }).action, ACTION.CLOSE_HOME);
  assert.equal(boardEndsHomeStay('READY'), true);
  // The contradiction checks read `boardSaysWorking`, and READY must stay out
  // of it or a resting driver is accused of contradicting their own record.
  assert.equal(boardSaysWorking('READY'), false);
});

test('DISPATCHED and ENROUTE end a home stay', () => {
  for (const status of ['DISPATCHED', 'ENROUTE', 'RESERVED']) {
    assert.equal(decide({ boardStatus: status, statusChangedAt: ago(90), ...AT_HOME }).action, ACTION.CLOSE_HOME, status);
  }
});

test('REST and SHOP end nothing — a driver can rest at home, a truck can sit in a shop', () => {
  for (const status of ['REST', 'SHOP']) {
    assert.equal(decide({ boardStatus: status, statusChangedAt: ago(90), ...AT_HOME }).action, ACTION.NONE, status);
  }
});

test('READY never pushes a driver Wenze has on the road into anything', () => {
  assert.equal(decide({ boardStatus: 'READY', statusChangedAt: ago(90), ...ON_ROAD }).action, ACTION.NONE);
});

// ─── the three rules against flapping ───

test('a board that has only just changed is left to settle — not acted on, not reported', () => {
  const out = decide({ boardStatus: 'HOME', statusChangedAt: ago(DEFAULTS.confirmMinutes - 5), ...ON_ROAD });
  assert.equal(out.action, ACTION.NONE);
  assert.match(out.reason, /settle/);
});

test('a state Wenze set moments ago is not changed back', () => {
  const out = decide({
    boardStatus: 'HOME', statusChangedAt: ago(90),
    wenzeState: 'road', wenzeStateSince: ago(DEFAULTS.dwellMinutes - 5),
  });
  assert.equal(out.action, ACTION.HOLD);
});

test('a driver who just said the opposite outranks the board, and nobody is told', () => {
  const out = decide({
    boardStatus: 'HOME', statusChangedAt: ago(90), ...ON_ROAD,
    driverSaidState: 'road', driverSaidAt: ago(20),
  });
  assert.equal(out.action, ACTION.HOLD, 'a board minutes behind a driver is lag, not a problem');
});

test('a hold that never resolves becomes a question rather than silence for ever', () => {
  // The driver keeps saying road; the board has said HOME for twenty hours.
  // That is no longer lag, and nobody would ever hear about it otherwise.
  const out = decide({
    boardStatus: 'HOME', statusChangedAt: ago(60 * 20), ...ON_ROAD,
    driverSaidState: 'road', driverSaidAt: ago(20),
  });
  assert.equal(out.action, ACTION.REVIEW);
  assert.ok(out.evidence.disagreedHours >= DEFAULTS.reviewAfterHours);
});

test('a driver who spoke a day ago no longer outranks the board', () => {
  const out = decide({
    boardStatus: 'HOME', statusChangedAt: ago(90), ...ON_ROAD,
    driverSaidState: 'road', driverSaidAt: ago(60 * 24),
  });
  assert.equal(out.action, ACTION.OPEN_HOME);
});

test('HOME → ROAD → HOME cannot happen from two board reads a few minutes apart', () => {
  // The board flips; Wenze acts once, and the flip back is inside the dwell.
  const first = decide({ boardStatus: 'HOME', statusChangedAt: ago(90), ...ON_ROAD });
  assert.equal(first.action, ACTION.OPEN_HOME);
  const second = decideBoardPresence({
    nowIso: NOW, lastSeenAt: ago(1), boardStatus: 'ENROUTE', statusChangedAt: ago(1),
    wenzeState: 'home', wenzeStateSince: ago(1),
  });
  assert.equal(second.action, ACTION.NONE, 'the new status has not settled');
});

test('a board that agrees with Wenze costs nothing — no write, no finding, no message', () => {
  const out = decide({ boardStatus: 'HOME', statusChangedAt: ago(90), ...AT_HOME });
  assert.equal(out.action, ACTION.NONE);
  assert.equal(out.agrees, true);
});

test('a stale snapshot decides nothing, and is not an alarm', () => {
  const out = decideBoardPresence({
    nowIso: NOW, lastSeenAt: ago(DEFAULTS.freshMinutes + 60),
    boardStatus: 'HOME', statusChangedAt: ago(200), ...ON_ROAD,
  });
  assert.equal(out.action, ACTION.NONE);
  assert.match(out.reason, /too old/);
});

test('an unknown board word is never a conclusion in either direction', () => {
  assert.equal(decide({ boardStatus: 'PARKED?', statusChangedAt: ago(90), ...ON_ROAD }).action, ACTION.NONE);
  assert.equal(decide({ boardStatus: '', statusChangedAt: ago(90), ...AT_HOME }).action, ACTION.NONE);
});

test('the evidence sentence names the board and what it said', () => {
  const out = decide({ boardStatus: 'HOME', statusChangedAt: ago(90), ...ON_ROAD });
  assert.match(describeBoardPresence(out), /dispatcher board: HOME/);
  assert.match(describeBoardPresence(out), /held 90 min/);
});

// ─── the pass ───

function world(over = {}) {
  const calls = { transitions: [], findings: [], resolved: [] };
  const state = {
    settings: { enabled: true },
    boardRows: [{
      rowKey: '310|JOHN SMITH', present: true, cleanName: 'JOHN SMITH', fleetType: 'company',
      truckNorm: '310', truckDigits: '310', isTeam: false, teamMembers: [], personId: null,
      status: 'HOME', statusChangedAt: ago(90), lastSeenAt: ago(5),
    }],
    people: [{ id: 5, display_name: 'JOHN SMITH', merged_into_person_id: null }],
    units: [{ person_id: 5, unit_number: '310', fleet_type: 'company', seat: 1 }],
    states: [{
      group_id: 77, telegram_group_id: -100, group_name: 'WENZE UNIT # 310', group_type: 'driver',
      person_id: 5, state: 'road', state_since: ago(60 * 24 * 30), last_status_at: ago(60 * 24 * 30),
    }],
    ...over,
  };
  const rowPeople = require('../services/dispatchBoard/rowPeople');
  const deps = {
    boardSettings: { getDispatchBoardSettings: async () => state.settings },
    board: { listBoardRows: async () => state.boardRows },
    rowPeople: {
      loadPersonLayer: async () => ({ people: state.people, units: state.units }),
      resolveBoardRowsToPeople: rowPeople.resolveBoardRowsToPeople,
    },
    db: { query: async () => ({ rows: state.states }) },
    findings: {
      upsertFinding: async (f) => { calls.findings.push(f); return { id: calls.findings.length }; },
      resolveClearedFindings: async (keys, keep) => { calls.resolved.push({ keys, keep }); return 0; },
    },
    homeTime: {
      applyStateTransition: async (_t, group, opts) => {
        calls.transitions.push({ groupId: group.id, ...opts });
        return {
          changed: true,
          transition: opts.newState === 'home' ? 'road_to_home' : 'home_to_road',
          newState: opts.newState,
        };
      },
    },
  };
  return { state, deps, calls };
}

const run = (w) => runBoardPresencePass({ deps: w.deps, now: Date.parse(NOW) });

test('a board HOME opens the cycle through the state machine, never by a direct write', async () => {
  const w = world();
  const out = await run(w);
  assert.equal(out.opened, 1);
  assert.equal(w.calls.transitions.length, 1);
  const t = w.calls.transitions[0];
  assert.equal(t.groupId, 77);
  assert.equal(t.newState, 'home');
  assert.equal(t.detectedBy, 'dispatcher_board');
  assert.match(t.evidenceSummary, /dispatcher board: HOME/);
  assert.equal(t.announce, true, 'the managers are told, as they are for a driver message');
});

test('running the pass again after the state moved does nothing', async () => {
  const w = world();
  await run(w);
  w.state.states[0].state = 'home';
  w.state.states[0].state_since = ago(60);
  w.state.states[0].last_status_at = ago(60);
  const second = await run(w);
  assert.equal(second.opened, 0);
  assert.equal(w.calls.transitions.length, 1, 'repeated HOME is idempotent');
});

test('the board switched off blocks the pass honestly rather than reporting a clean run', async () => {
  const w = world({ settings: { enabled: false } });
  const out = await run(w);
  assert.match(out.blocked, /switched off/);
  assert.equal(w.calls.transitions.length, 0);
});

test('a driver with no person cannot be moved by a board row', async () => {
  const w = world({ states: [{ ...world().state.states[0], person_id: null }] });
  const out = await run(w);
  assert.equal(out.checked, 0);
  assert.equal(w.calls.transitions.length, 0);
});

test('one person on two active groups is left alone — that is a different question', async () => {
  const base = world().state.states[0];
  const w = world({ states: [base, { ...base, group_id: 78 }] });
  const out = await run(w);
  assert.equal(out.checked, 0);
  assert.equal(w.calls.transitions.length, 0);
});

test('the same person on a new truck keeps their state — the board row moves, the person does not', async () => {
  const w = world();
  // The driver changed trucks: new board row key and unit, same person.
  w.state.boardRows = [{
    ...w.state.boardRows[0], rowKey: '999|JOHN SMITH', truckNorm: '999', truckDigits: '999',
  }];
  w.state.units = [{ person_id: 5, unit_number: '999', fleet_type: 'company', seat: 1 }];
  const out = await run(w);
  assert.equal(out.opened, 1, 'a truck change is not a new driver');
  assert.equal(w.calls.transitions[0].groupId, 77);
});

test('a long-standing disagreement is filed as a question with no proposed change', async () => {
  const w = world();
  // The board has said HOME for twenty hours; the driver said road minutes ago.
  w.state.boardRows[0].statusChangedAt = ago(60 * 20);
  w.state.states[0].last_status_at = ago(20);
  const out = await run(w);
  assert.equal(out.reviews, 1);
  assert.equal(out.opened, 0);
  assert.equal(w.calls.findings[0].checkKey, CHECK_DISAGREES);
  assert.equal(w.calls.findings[0].proposedChange, null);
  assert.deepEqual(w.calls.resolved[0].keys, [CHECK_DISAGREES]);
});

test('a board claiming the whole fleet moved is capped rather than obeyed', async () => {
  const rows = [];
  const states = [];
  const people = [];
  const units = [];
  for (let i = 1; i <= MAX_TRANSITIONS_PER_PASS + 5; i += 1) {
    const unit = String(1000 + i);
    people.push({ id: i, display_name: `DRIVER ${i}`, merged_into_person_id: null });
    units.push({ person_id: i, unit_number: unit, fleet_type: 'company', seat: 1 });
    rows.push({
      rowKey: `${unit}|DRIVER ${i}`, present: true, cleanName: `DRIVER ${i}`, fleetType: 'company',
      truckNorm: unit, truckDigits: unit, isTeam: false, teamMembers: [], personId: null,
      status: 'HOME', statusChangedAt: ago(90), lastSeenAt: ago(5),
    });
    states.push({
      group_id: 1000 + i, telegram_group_id: -i, group_name: `UNIT ${unit}`, group_type: 'driver',
      person_id: i, state: 'road', state_since: ago(60 * 24 * 30), last_status_at: ago(60 * 24 * 30),
    });
  }
  const w = world({ boardRows: rows, people, units, states });
  const out = await run(w);
  assert.equal(out.opened, MAX_TRANSITIONS_PER_PASS);
  assert.ok(out.errors.some((e) => /cap/.test(e)));
});
