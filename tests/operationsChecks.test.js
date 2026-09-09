/**
 * The pure consistency checks.
 *
 * Fixtures are the real production shapes — unit '001' on four active groups,
 * the RUSLAN ABDULLAEV twin pair, a home stay open since May — because those are
 * what the rules were written against. A change in the rules should show up here
 * as a changed number, not as silence.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const identity = require('../services/operations/checks/identity');
const homeTime = require('../services/operations/checks/homeTime');

const NOW = new Date('2026-09-09T00:00:00Z');

function group(id, name, extra = {}) {
  return {
    id,
    group_name: name,
    group_type: 'driver',
    active: true,
    status_source: 'ai',
    bot_member_status: 'member',
    last_message_seen_at: '2026-09-08T00:00:00Z',
    ...extra,
  };
}
function profile(groupId, first, last, extra = {}) {
  return {
    group_id: groupId, first_name: first, last_name: last,
    secondary_first_name: null, secondary_last_name: null,
    unit_number: null, status: 'active', telegram_user_id: null, ...extra,
  };
}
const keysOf = (findings) => findings.map((f) => f.checkKey);

// ─── identity ────────────────────────────────────────────────────────────────

test('status disagreement is auto-correctable only when the BOT observed the state', () => {
  const groups = [
    group(1, 'WENZE UNIT # 1 A', { active: true, status_source: 'bot' }),
    group(2, 'WENZE UNIT # 2 B', { active: true, status_source: 'ai' }),
    group(3, 'WENZE UNIT # 3 C', { active: true, status_source: 'manual' }),
  ];
  const profiles = [
    profile(1, 'A', 'ONE', { status: 'inactive' }),
    profile(2, 'B', 'TWO', { status: 'inactive' }),
    profile(3, 'C', 'THREE', { status: 'inactive' }),
  ];
  const found = identity.checkStatusDisagreement({ groups, profiles });

  assert.equal(found.length, 3);
  assert.equal(found.find((f) => f.subjectId === 1).tier, 'auto', 'Telegram told us — hard evidence');
  assert.equal(found.find((f) => f.subjectId === 2).tier, 'approval', 'an LLM decided — a human confirms');
  assert.equal(found.find((f) => f.subjectId === 3).tier, 'approval');
  assert.deepEqual(found[0].proposedChange, {
    table: 'driver_profiles', groupId: 1, field: 'status', from: 'inactive', to: 'active',
  });
});

test('agreeing rows produce nothing', () => {
  const groups = [group(1, 'WENZE UNIT # 1 A', { active: true })];
  const profiles = [profile(1, 'A', 'ONE', { status: 'active' })];
  assert.deepEqual(identity.checkStatusDisagreement({ groups, profiles }), []);
});

test("unit '001' on four active groups is one serious finding, never arbitrated", () => {
  const groups = [
    group(11, 'WENZE UNIT # 001 OLABODE OLUDAISI'),
    group(12, 'WENZE UNIT # 001A RALPH MICHEL'),
    group(13, 'WENZE UNIT # 001 STARKS DAYMON (COMPANY DRIVER)'),
    group(14, 'WENZE UNIT # 001 UROZALI TAJIBAEV'),
  ];
  const profiles = groups.map((g, i) => profile(g.id, `D${i}`, 'X', { unit_number: '001' }));
  const found = identity.checkDuplicateUnits({ groups, profiles });

  assert.equal(found.length, 1, 'one finding about the unit, not four about the groups');
  assert.equal(found[0].subjectId, '001');
  assert.equal(found[0].severity, 'serious', 'more than two claimants is a different problem');
  assert.equal(found[0].tier, 'warning', 'only a human knows which truck the driver is in');
  assert.equal(found[0].evidence.groups.length, 4);
});

test("'001', '01' and '1' are three different trucks, not a collision", () => {
  const groups = [
    group(21, 'WENZE UNIT # 001 A'), group(22, 'WENZE UNIT # 01 B'), group(23, 'WENZE UNIT # 1 C'),
  ];
  const profiles = [
    profile(21, 'A', 'X', { unit_number: '001' }),
    profile(22, 'B', 'Y', { unit_number: '01' }),
    profile(23, 'C', 'Z', { unit_number: '1' }),
  ];
  assert.deepEqual(identity.checkDuplicateUnits({ groups, profiles }), []);
});

test('an inactive group never contributes to a duplicate unit', () => {
  const groups = [group(31, 'WENZE UNIT # 7 A'), group(32, 'WENZE UNIT # 7 B', { active: false })];
  const profiles = [
    profile(31, 'A', 'X', { unit_number: '7' }),
    profile(32, 'B', 'Y', { unit_number: '7' }),
  ];
  assert.deepEqual(identity.checkDuplicateUnits({ groups, profiles }), []);
});

test('a profile unit that disagrees with the title names both readers', () => {
  const groups = [group(41, 'WENZE UNIT # 316 ANTONIE CAMPBELL')];
  const profiles = [profile(41, 'ANTONIE', 'CAMPBELL', { unit_number: '27065' })];
  const found = identity.checkUnitTitleMismatch({ groups, profiles });

  assert.equal(found.length, 1);
  assert.equal(found[0].evidence.profileUnit, '27065');
  assert.equal(found[0].evidence.titleUnit, '316');
  assert.ok(found[0].evidence.readsTitle.length && found[0].evidence.readsProfile.length);
});

test('an active group the bot has left is serious', () => {
  const groups = [
    group(51, 'WENZE UNIT # 102 RENAT SABIROV', { bot_member_status: 'left' }),
    group(52, 'WENZE UNIT # 103 OK', { bot_member_status: 'administrator' }),
  ];
  const found = identity.checkBotNotInActiveGroup({ groups });
  assert.equal(found.length, 1);
  assert.equal(found[0].severity, 'serious');
  assert.equal(found[0].subjectId, 51);
});

test('silence is measured against the threshold, and warns about document routing', () => {
  const groups = [
    group(61, 'WENZE UNIT # 9 QUIET', { last_message_seen_at: '2026-05-01T00:00:00Z' }),
    group(62, 'WENZE UNIT # 10 CHATTY', { last_message_seen_at: '2026-09-05T00:00:00Z' }),
  ];
  const found = identity.checkSilentActiveGroups({ groups, now: NOW });
  assert.equal(found.length, 1);
  assert.equal(found[0].subjectId, 61);
  assert.match(found[0].evidence.sideEffect, /BOL\/POD/);
});

test('an admin chat typed as a driver is flagged; a real driver group is not', () => {
  const groups = [
    group(71, 'Driver Feedback (Admin)'),
    group(72, 'Wenze Facebook Leads'),
    group(73, 'WENZE UNIT # 555 JAVLON TURAEV'),
  ];
  const found = identity.checkNonDriverChatsTypedAsDriver({ groups });
  assert.deepEqual(found.map((f) => f.subjectId).sort((a, b) => a - b), [71, 72]);
});

test('a unit number in the title protects a real driver group from the admin heuristic', () => {
  // "Automatic updating (Test)" has no unit; a driver group always does.
  const groups = [group(81, 'WENZE UNIT # 14097 TEST DRIVER')];
  assert.deepEqual(identity.checkNonDriverChatsTypedAsDriver({ groups }), []);
});

// ─── home time ───────────────────────────────────────────────────────────────

const GROUPS_BY_ID = new Map([
  [1, group(1, 'WENZE UNIT # 27 RUSLAN ABDULLAEV')],
  [2, group(2, 'WENZE UNIT # 5 STILL HOME')],
  [3, group(3, 'WENZE UNIT # 9 DEPARTED', { active: false })],
]);
const SETTINGS = { home_allowance_days: 4, road_allowance_weeks: 4 };

test('every open cycle classifies into A, B, C or N — the real production split', () => {
  const roadHistory = [
    { id: 10, group_id: 1, road_started_at: '2026-06-01', home_arrived_at: '2026-07-01', return_to_road_at: null },
    { id: 11, group_id: 1, road_started_at: '2026-07-08', home_arrived_at: '2026-08-25', return_to_road_at: null },
    { id: 12, group_id: 2, road_started_at: '2026-05-01', home_arrived_at: '2026-05-20', return_to_road_at: null },
  ];
  const homeStatus = [
    { group_id: 1, state: 'road', state_since: '2026-08-31' },
    { group_id: 2, state: 'home', state_since: '2026-05-20' },
  ];
  const classified = homeTime.classifyOpenCycles({ roadHistory, homeStatus });
  const byId = new Map(classified.map((c) => [c.cycle.id, c]));

  assert.equal(byId.get(10).evidenceClass, 'B', 'a later cycle exists — its road start IS this return');
  assert.equal(byId.get(10).returnAt.toISOString().slice(0, 10), '2026-07-08');
  assert.equal(byId.get(11).evidenceClass, 'A', 'group is on the road since after arriving home');
  assert.equal(byId.get(11).returnAt.toISOString().slice(0, 10), '2026-08-31');
  assert.equal(byId.get(12).evidenceClass, 'C', 'genuinely still at home — correctly open');
  assert.equal(byId.get(12).returnAt, null);
});

test('an already-closed cycle is never reclassified', () => {
  const roadHistory = [
    { id: 20, group_id: 1, road_started_at: '2026-06-01', home_arrived_at: '2026-07-01', return_to_road_at: '2026-07-05' },
  ];
  assert.deepEqual(homeTime.classifyOpenCycles({ roadHistory, homeStatus: [] }), []);
});

test('a closable cycle proposes the recorded timestamp and leaves the bonus alone', () => {
  const roadHistory = [
    { id: 30, group_id: 1, road_started_at: '2026-07-08', home_arrived_at: '2026-08-25', return_to_road_at: null, home_days: null },
  ];
  const homeStatus = [{ group_id: 1, state: 'road', state_since: '2026-08-31' }];
  const found = homeTime.checkClosableCycles({ roadHistory, homeStatus, groupsById: GROUPS_BY_ID });

  assert.equal(found.length, 1);
  assert.equal(found[0].tier, 'auto', 'the value is copied, not invented');
  assert.equal(found[0].evidence.evidenceClass, 'A');
  assert.equal(found[0].proposedChange.homeDays.to, 6);
  assert.ok(!('bonusUsd' in found[0].proposedChange), 'closing a cycle must be payout-neutral');
});

test('a Date from pg renders as a date, not "Wed Jul 01"', () => {
  // node-postgres hands back a Date for a timestamp column, and String(date)
  // on one begins "Wed Jul 01 2026" — slicing that produced a nonsense title.
  const roadHistory = [
    { id: 35, group_id: 1, road_started_at: new Date('2026-07-08T00:00:00Z'),
      home_arrived_at: new Date('2026-08-25T00:00:00Z'), return_to_road_at: null },
  ];
  const homeStatus = [{ group_id: 1, state: 'road', state_since: new Date('2026-08-31T00:00:00Z') }];
  const found = homeTime.checkClosableCycles({ roadHistory, homeStatus, groupsById: GROUPS_BY_ID });

  assert.equal(found.length, 1);
  assert.match(found[0].title, /home stay from 2026-08-25 /);
});

test('a hidden older cycle is reported as hidden', () => {
  const roadHistory = [
    { id: 40, group_id: 1, road_started_at: '2026-06-01', home_arrived_at: '2026-07-01', return_to_road_at: null },
    { id: 41, group_id: 1, road_started_at: '2026-07-08', home_arrived_at: '2026-08-25', return_to_road_at: null },
  ];
  const homeStatus = [{ group_id: 1, state: 'road', state_since: '2026-08-31' }];
  const found = homeTime.checkClosableCycles({ roadHistory, homeStatus, groupsById: GROUPS_BY_ID });
  const hidden = found.find((f) => f.subjectId === 40);
  assert.equal(hidden.evidence.hiddenByLaterCycle, true);
});

test('a driver genuinely at home past the allowance warns, and does not propose a close', () => {
  const roadHistory = [
    { id: 50, group_id: 2, road_started_at: '2026-05-01', home_arrived_at: '2026-05-20', return_to_road_at: null },
  ];
  const homeStatus = [{ group_id: 2, state: 'home', state_since: '2026-05-20' }];
  const args = { roadHistory, homeStatus, groupsById: GROUPS_BY_ID, settings: SETTINGS, now: NOW };

  assert.deepEqual(homeTime.checkClosableCycles(args), [], 'no evidence of a return exists');
  const warned = homeTime.checkHomeStayPastAllowance(args);
  assert.equal(warned.length, 1);
  assert.equal(warned[0].tier, 'warning');
  assert.equal(warned[0].severity, 'serious', '112 days against a 4-day allowance');
});

test('a day over the allowance is inside the grace and does not warn', () => {
  const roadHistory = [
    { id: 60, group_id: 2, road_started_at: '2026-08-01', home_arrived_at: '2026-09-04', return_to_road_at: null },
  ];
  const homeStatus = [{ group_id: 2, state: 'home', state_since: '2026-09-04' }];
  assert.deepEqual(
    homeTime.checkHomeStayPastAllowance({ roadHistory, homeStatus, groupsById: GROUPS_BY_ID, settings: SETTINGS, now: NOW }),
    []
  );
});

test('the road clock uses the configured allowance, not a hardcoded four weeks', () => {
  const homeStatus = [{ group_id: 1, state: 'road', state_since: '2026-07-01' }];
  const args = { homeStatus, groupsById: GROUPS_BY_ID, now: NOW };

  assert.equal(homeTime.checkRoadClockPastAllowance({ ...args, settings: { road_allowance_weeks: 4 } }).length, 1);
  assert.equal(homeTime.checkRoadClockPastAllowance({ ...args, settings: { road_allowance_weeks: 12 } }).length, 0);
});

test('a home-status row for a gone or inactive group is auto-retirable', () => {
  const homeStatus = [
    { group_id: 3, state: 'road', state_since: '2026-01-01' },
    { group_id: 999, state: 'home', state_since: '2026-01-01' },
    { group_id: 1, state: 'road', state_since: '2026-09-01' },
  ];
  const found = homeTime.checkGhostHomeStatus({ homeStatus, groupsById: GROUPS_BY_ID });

  assert.deepEqual(found.map((f) => f.subjectId).sort((a, b) => a - b), [3, 999]);
  assert.ok(found.every((f) => f.tier === 'auto'));
  assert.equal(found.find((f) => f.subjectId === 999).evidence.groupExists, false);
});

test('the road-clock check ignores departed drivers so they are counted once', () => {
  // Group 3 is inactive: it is a ghost-status finding, not a road-clock one.
  const homeStatus = [{ group_id: 3, state: 'road', state_since: '2026-01-01' }];
  assert.deepEqual(
    homeTime.checkRoadClockPastAllowance({ homeStatus, groupsById: GROUPS_BY_ID, settings: SETTINGS, now: NOW }),
    []
  );
});

test('every check declares its key, so the sweep can never resolve a key it did not run', () => {
  const declared = new Set([...identity.CHECK_KEYS, ...homeTime.CHECK_KEYS]);
  const roadHistory = [
    { id: 70, group_id: 1, road_started_at: '2026-07-08', home_arrived_at: '2026-08-25', return_to_road_at: null },
  ];
  const produced = [
    ...identity.runIdentityChecks({
      groups: [group(1, 'WENZE UNIT # 1 A', { bot_member_status: 'left' })],
      profiles: [profile(1, 'A', 'ONE', { status: 'inactive' })],
      now: NOW,
    }),
    ...homeTime.runHomeTimeChecks({
      roadHistory,
      homeStatus: [{ group_id: 1, state: 'road', state_since: '2026-08-31' }],
      groupsById: GROUPS_BY_ID, settings: SETTINGS, now: NOW,
    }),
  ];
  assert.ok(produced.length > 0);
  for (const key of keysOf(produced)) {
    assert.ok(declared.has(key), `${key} is produced but not declared in CHECK_KEYS`);
  }
});
