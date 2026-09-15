'use strict';

/**
 * Sunday's reconciliation: rebuilding every dispatch team's roster from the
 * Dispatcher Board, in the minutes before the review link is sent.
 *
 * THE TWO THINGS THAT MUST NOT MOVE:
 *   the roster is rebuilt BEFORE the round is minted and the link is posted, and
 *   a Board that cannot be trusted stops the round instead of producing one
 *   that is confidently wrong.
 * Everything else here is the no-guessing rule applied to real row shapes.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  reconcileRosterFromBoard, boardFreshness, boardRowsByDriver, MAX_BOARD_AGE_HOURS,
  CHECK_UNPLACED, CHECK_ROSTER_BLOCKED,
} = require('../services/raise/boardRoster');

const HOUR = 3600 * 1000;
const NOW = Date.UTC(2026, 8, 13, 12, 0, 0);

const JOHN = { id: 5, display_name: 'JOHN SMITH', merged_into_person_id: null };
const MARIA = { id: 6, display_name: 'MARIA GARCIA', merged_into_person_id: null };

function boardRow(over = {}) {
  return {
    rowKey: '310|JOHN SMITH', present: true, cleanName: 'JOHN SMITH',
    fleetType: 'company', truckNorm: '310', truckDigits: '310',
    isTeam: false, teamMembers: [], personId: null, dispatcher: 'Charles', ...over,
  };
}

function groupRow(over = {}) {
  return {
    group_type: 'driver', driver_type: 'company_driver', inactive: false,
    person_id: 5, profile_id: 105, group_id: 1005, unit_number: '310',
    display_name: 'JOHN SMITH', primary_display_name: 'JOHN SMITH', group_name: 'WENZE UNIT # 310',
    ...over,
  };
}

/** A whole world the reconciliation can run against, recording what it wrote. */
function world(over = {}) {
  const calls = { assigned: [], retired: [], findings: [], resolved: [] };
  const state = {
    settings: { enabled: true, configured: true, lastPollAt: new Date(NOW - HOUR).toISOString(), lastPollOk: true },
    teams: [{ id: 1, name: 'Charles', active: true }, { id: 2, name: 'Steven', active: true }],
    members: { 1: [{ name: 'Charles Whitfield' }], 2: [{ name: 'Steven Ruiz' }] },
    people: [JOHN],
    units: [{ person_id: 5, unit_number: '310', fleet_type: 'company', seat: 1 }],
    boardRows: [boardRow()],
    current: [],
    groups: [groupRow()],
    ...over,
  };
  const deps = {
    boardSettings: { getBoardConfig: async () => state.settings },
    board: { listBoardRows: async () => state.boardRows },
    ra: {
      listDispatchTeams: async () => state.teams,
      listTeamMembers: async (id) => state.members[id] || [],
      listRosterForReconciliation: async () => state.current,
      applyBoardAssignment: async (payload) => {
        calls.assigned.push(payload);
        return { moved: true, heldByOverride: false, fromTeamId: null };
      },
      retireBoardAssignment: async (id) => { calls.retired.push(id); return true; },
    },
    directory: { listCanonicalDriverGroups: async () => state.groups },
    findings: {
      upsertFinding: async (f) => { calls.findings.push(f); return { id: calls.findings.length }; },
      resolveClearedFindings: async (keys, keep) => { calls.resolved.push({ keys, keep }); return 0; },
    },
    db: {
      query: async (sql) => (/driver_people/.test(sql)
        ? { rows: state.people }
        : { rows: state.units }),
    },
  };
  return { state, deps, calls };
}

const run = (w) => reconcileRosterFromBoard({ deps: w.deps, now: NOW });

// ─── the board must be usable at all ───

test('a switched-off, unread, failed or stale board each say so in their own words', () => {
  const cases = [
    [{ enabled: false }, /switched off/],
    [{ enabled: true, lastPollAt: null }, /never been read/],
    [{ enabled: true, lastPollAt: new Date(NOW).toISOString(), lastPollOk: false }, /last .* read failed/],
    [{ enabled: true, lastPollAt: new Date(NOW - (MAX_BOARD_AGE_HOURS + 2) * HOUR).toISOString(), lastPollOk: true },
      new RegExp(`${MAX_BOARD_AGE_HOURS}h`)],
  ];
  for (const [settings, re] of cases) {
    const out = boardFreshness(settings, NOW);
    assert.equal(out.ok, false);
    assert.match(out.reason, re);
  }
  assert.equal(boardFreshness({ enabled: true, lastPollAt: new Date(NOW - HOUR).toISOString(), lastPollOk: true }, NOW).ok, true);
});

test('a stale board refuses to rebuild the roster instead of rebuilding it wrong', async () => {
  const w = world({ settings: { enabled: true, lastPollOk: true, lastPollAt: new Date(NOW - 30 * HOUR).toISOString() } });
  await assert.rejects(run(w), (err) => {
    assert.equal(err.code, 'BOARD_NOT_USABLE');
    assert.match(err.message, /roster could not be rebuilt/);
    return true;
  });
  assert.equal(w.calls.assigned.length, 0, 'nothing was written from a snapshot nobody trusts');
});

test('no active dispatch team is a refusal, not an empty roster', async () => {
  const w = world({ teams: [] });
  await assert.rejects(run(w), (err) => err.code === 'NO_TEAMS');
});

// ─── placing drivers ───

test('a board dispatcher places the driver on that dispatcher’s team', async () => {
  const w = world();
  const out = await run(w);
  assert.equal(out.ok, true);
  assert.equal(w.calls.assigned.length, 1);
  assert.equal(w.calls.assigned[0].teamId, 1);
  assert.equal(w.calls.assigned[0].personId, 5);
  assert.equal(w.calls.assigned[0].boardDispatcher, 'Charles');
  assert.equal(out.summary.placed, 1);
});

test('running the reconciliation twice places nobody a second time', async () => {
  const w = world();
  await run(w);
  // The first run's write is now the roster the second run reads.
  w.state.current = [{ id: 77, teamId: 1, personId: 5, assignmentSource: 'board' }];
  const second = await run(w);
  assert.equal(w.calls.assigned.length, 1, 'no duplicate assignment');
  assert.equal(second.summary.keep, 1);
  assert.equal(second.summary.placed, 0);
});

test('a driver whose board dispatcher changed is moved to the new team', async () => {
  const w = world({
    current: [{ id: 77, teamId: 1, personId: 5, assignmentSource: 'board' }],
    boardRows: [boardRow({ dispatcher: 'Steven' })],
  });
  await run(w);
  assert.equal(w.calls.assigned.length, 1);
  assert.equal(w.calls.assigned[0].teamId, 2);
});

test('a driver who left the fleet is retired from the roster', async () => {
  const w = world({
    groups: [],
    boardRows: [],
    current: [{ id: 88, teamId: 1, personId: 5, assignmentSource: 'board' }],
  });
  const out = await run(w);
  assert.deepEqual(w.calls.retired, [88]);
  assert.equal(out.summary.removed, 1);
});

test('a human override is left alone and never handed back to the board', async () => {
  const w = world({
    // A real override carries the mark a person's decision leaves; without it
    // this is a legacy row and the board is meant to reclaim it.
    current: [{
      id: 99, teamId: 2, personId: 5, assignmentSource: 'manual',
      manualOverrideAt: '2026-09-15T10:00:00.000Z', manualOverrideBy: 'admin:jane',
    }],
    boardRows: [boardRow({ dispatcher: 'Charles' })],
  });
  const out = await run(w);
  assert.equal(w.calls.assigned.length, 0);
  assert.equal(w.calls.retired.length, 0);
  assert.equal(out.summary.overrideHeld, 1);
  assert.equal(out.summary.overrideDisagrees, 1);
});

// ─── refusing rather than guessing ───

test('an unknown dispatcher becomes Needs Review, and the driver is not placed', async () => {
  const w = world({ boardRows: [boardRow({ dispatcher: 'Nobody Here' })] });
  const out = await run(w);
  assert.equal(w.calls.assigned.length, 0);
  assert.equal(out.reviews.length, 1);
  assert.equal(out.reviews[0].reason, 'unknown_dispatcher');
  assert.equal(w.calls.findings[0].checkKey, CHECK_UNPLACED);
  assert.match(w.calls.findings[0].title, /No dispatch team is named after/);
  assert.equal(w.calls.findings[0].proposedChange, null, 'a question, never a proposal');
});

test('an empty dispatcher cell is reported as its own problem', async () => {
  const w = world({ boardRows: [boardRow({ dispatcher: '' })] });
  const out = await run(w);
  assert.equal(out.reviews[0].reason, 'no_dispatcher');
  assert.match(w.calls.findings[0].title, /has no dispatcher/);
});

test('a driver the board does not carry is reported, not silently dropped', async () => {
  const w = world({ boardRows: [] });
  const out = await run(w);
  assert.equal(out.reviews[0].reason, 'no_board_row');
  assert.equal(w.calls.assigned.length, 0);
});

test('two board rows about one person disqualify both — neither is a guess', () => {
  const rows = [
    boardRow({ rowKey: '310|JOHN SMITH' }),
    boardRow({ rowKey: '311|JOHN SMITH', truckNorm: '311', truckDigits: '311' }),
  ];
  const { byDriver } = boardRowsByDriver(rows, {
    people: [JOHN],
    units: [
      { person_id: 5, unit_number: '310', fleet_type: 'company', seat: 1 },
      { person_id: 5, unit_number: '311', fleet_type: 'company', seat: 1 },
    ],
  });
  assert.equal(byDriver.get('person:5').duplicate, true);
});

test('a board row whose person cannot be settled never reaches the plan', () => {
  const { byDriver, unresolved } = boardRowsByDriver([boardRow({ cleanName: 'SOMEBODY ELSE' })], {
    people: [JOHN, MARIA], units: [],
  });
  assert.equal(byDriver.size, 0);
  assert.equal(unresolved.length, 1);
});

// ─── the Needs Review list does not fossilise ───

test('a driver who is placed this week stops being a question', async () => {
  const w = world();
  await run(w);
  const unplaced = w.calls.resolved.find((r) => r.keys[0] === CHECK_UNPLACED);
  assert.ok(unplaced);
  assert.deepEqual(unplaced.keep, [], 'nothing unresolved, so every old question closes');
});

// ─── only company drivers are reviewed ───

test('owner-operators, lease drivers and inactive groups are not on a raise roster', async () => {
  const w = world({
    groups: [
      groupRow({ driver_type: 'owner_operator', person_id: 6 }),
      groupRow({ driver_type: 'company_driver', inactive: true, person_id: 7 }),
      groupRow({ group_type: 'admin', person_id: 8 }),
      groupRow(),
    ],
  });
  await run(w);
  assert.equal(w.calls.assigned.length, 1, 'only the active company driver');
  assert.equal(w.calls.assigned[0].personId, 5);
});

test('a refusal is filed where a person reads it, not only in the log', async () => {
  const w = world({ settings: { enabled: false } });
  await assert.rejects(run(w));
  assert.equal(w.calls.findings.length, 1);
  assert.equal(w.calls.findings[0].checkKey, CHECK_ROSTER_BLOCKED);
  assert.equal(w.calls.findings[0].severity, 'serious');
  assert.match(w.calls.findings[0].evidence.reason, /switched off/);
  assert.match(w.calls.findings[0].evidence.consequence, /no review round/);
});

test('a rebuild that works clears the blocked finding', async () => {
  const w = world();
  await run(w);
  assert.ok(w.calls.resolved.some((r) => r.keys[0] === CHECK_ROSTER_BLOCKED));
});

// ─── a partly-written roster never reaches a dispatcher (review finding) ───

test('a roster write that fails aborts the rebuild instead of reporting and continuing', async () => {
  const w = world();
  w.deps.ra.applyBoardAssignment = async () => { throw new Error('deadlock detected'); };
  await assert.rejects(run(w), (err) => {
    assert.equal(err.code, 'ROSTER_WRITE_FAILED');
    assert.match(err.message, /could not be written/);
    return true;
  });
  // Half old and half new is indistinguishable from correct on the review form,
  // which is exactly why the round must not be minted on it.
  const filed = w.calls.findings.find((f) => f.checkKey === CHECK_ROSTER_BLOCKED);
  assert.ok(filed, 'the operator is told why no review went out');
  assert.match(filed.evidence.reason, /deadlock detected/);
});

test('a retirement that fails aborts it too', async () => {
  const w = world({
    groups: [],
    boardRows: [],
    current: [{ id: 88, teamId: 1, personId: 5, assignmentSource: 'board' }],
  });
  w.deps.ra.retireBoardAssignment = async () => { throw new Error('connection terminated'); };
  await assert.rejects(run(w), (err) => err.code === 'ROSTER_WRITE_FAILED');
});

test('a finding that will not file is reported but does NOT abort — the roster is still right', async () => {
  const w = world({ boardRows: [boardRow({ dispatcher: 'Nobody Here' })] });
  w.deps.findings.upsertFinding = async () => { throw new Error('findings table is missing'); };
  const out = await run(w);
  assert.equal(out.ok, true, 'refusing the whole review over a warning row trades a real problem for a bigger one');
  assert.ok(out.errors.some((e) => /findings table/.test(e)));
});

test('a rebuild with nothing to write is not treated as a failed one', async () => {
  const w = world({
    current: [{ id: 77, teamId: 1, personId: 5, assignmentSource: 'board' }],
  });
  const out = await run(w);
  assert.equal(out.ok, true);
  assert.deepEqual(out.errors, []);
  assert.equal(out.summary.keep, 1);
});
