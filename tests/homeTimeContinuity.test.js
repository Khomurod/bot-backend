/**
 * The road clock across a truck change — the pure check, on the production case.
 *
 * RUSLAN ABDULLAEV: group 49 on the road since 2026-08-31, last message that
 * day; group 541877 created and on the road since 2026-09-01, zero history.
 * One driver, two chats, four weeks of accrual lost to a recreated chat.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { checkClockResetOnGroupChange, CHECK_KEYS } = require('../services/operations/checks/homeTimeContinuity');

const group = (id, name, active = true) => ({ id, group_name: name, group_type: 'driver', active });
function snapshot({ groups, homeStatus, personGroupHistory, people = [{ id: 7, display_name: 'RUSLAN ABDULLAEV' }] }) {
  return { groups, groupsById: new Map(groups.map((g) => [g.id, g])), homeStatus, personGroupHistory, people };
}
const RUSLAN = {
  groups: [group(49, 'WENZE UNIT # 27 RUSLAN ABDULLAEV', false), group(541877, 'WENZE UNIT # 27 RUSLAN ABDULLAEV')],
  homeStatus: [
    { group_id: 49, state: 'road', state_since: '2026-08-03T00:00:00Z', last_status_at: '2026-08-31T18:00:00Z', road_bonus_weeks_notified: 0 },
    { group_id: 541877, state: 'road', state_since: '2026-09-01T00:00:00Z', last_status_at: '2026-09-08T00:00:00Z', road_bonus_weeks_notified: 0 },
  ],
  personGroupHistory: [
    { person_id: 7, group_id: 49, started_at: '2026-06-01T00:00:00Z', ended_at: '2026-09-01T00:00:00Z' },
    { person_id: 7, group_id: 541877, started_at: '2026-09-01T00:00:00Z', ended_at: null },
  ],
};

test('a clock that restarted on the new chat while the old chat was already on the road is proposed for carrying', () => {
  const [finding] = checkClockResetOnGroupChange(snapshot(RUSLAN));
  assert.ok(finding);
  assert.equal(finding.checkKey, 'home_time.clock_reset_on_group_change');
  assert.equal(finding.subjectId, 541877);
  assert.equal(finding.tier, 'approval', 'it changes a future payout; a person confirms');
  assert.equal(finding.evidence.lostDays, 29);
  assert.deepEqual(
    [finding.proposedChange.from, finding.proposedChange.to, finding.proposedChange.fromGroupId],
    ['2026-09-01T00:00:00Z', '2026-08-03T00:00:00Z', 49]
  );
  assert.match(finding.title, /RUSLAN ABDULLAEV.*29 days/);
});

test('a genuine home→road on the new chat — the clock started well after the chat did — is left alone', () => {
  const later = structuredClone(RUSLAN);
  later.homeStatus[1].state_since = '2026-09-20T00:00:00Z'; // 19 days after the chat began
  assert.deepEqual(checkClockResetOnGroupChange(snapshot(later)), []);
});

test('the old chat still talking after the new clock began means two parallel chats, not a move', () => {
  const parallel = structuredClone(RUSLAN);
  parallel.homeStatus[0].last_status_at = '2026-09-05T00:00:00Z';
  assert.deepEqual(checkClockResetOnGroupChange(snapshot(parallel)), []);
});

test('an old chat that was HOME, or a new chat that is home, proposes nothing', () => {
  const home = structuredClone(RUSLAN);
  home.homeStatus[0].state = 'home';
  assert.deepEqual(checkClockResetOnGroupChange(snapshot(home)), []);
  const newHome = structuredClone(RUSLAN);
  newHome.homeStatus[1].state = 'home';
  assert.deepEqual(checkClockResetOnGroupChange(snapshot(newHome)), []);
});

test('the watermark carried is the larger of the two, so announced weeks are not announced again', () => {
  const notified = structuredClone(RUSLAN);
  notified.homeStatus[0].road_bonus_weeks_notified = 2;
  const [finding] = checkClockResetOnGroupChange(snapshot(notified));
  assert.deepEqual(finding.proposedChange.roadBonusWeeksNotified, { from: 0, to: 2 });
});

test('a person with one chat, or with no status rows, is silence', () => {
  assert.deepEqual(checkClockResetOnGroupChange(snapshot({
    groups: [group(1, 'A')], homeStatus: [{ group_id: 1, state: 'road', state_since: '2026-09-01T00:00:00Z' }],
    personGroupHistory: [{ person_id: 7, group_id: 1, started_at: '2026-09-01T00:00:00Z', ended_at: null }],
  })), []);
  assert.deepEqual(CHECK_KEYS, ['home_time.clock_reset_on_group_change']);
});

test('with several previous chats, the MOST RECENT one is the clock proposed — not the oldest', () => {
  // The snapshot lists associations oldest first; picking the first closed
  // chat would carry a clock from several truck changes ago.
  const [finding] = checkClockResetOnGroupChange(snapshot({
    groups: [group(10, 'FIRST', false), group(49, 'SECOND', false), group(541877, 'NOW')],
    homeStatus: [
      { group_id: 10, state: 'road', state_since: '2026-03-01T00:00:00Z', last_status_at: '2026-05-30T00:00:00Z', road_bonus_weeks_notified: 0 },
      { group_id: 49, state: 'road', state_since: '2026-08-03T00:00:00Z', last_status_at: '2026-08-31T18:00:00Z', road_bonus_weeks_notified: 0 },
      { group_id: 541877, state: 'road', state_since: '2026-09-01T00:00:00Z', last_status_at: '2026-09-08T00:00:00Z', road_bonus_weeks_notified: 0 },
    ],
    personGroupHistory: [
      { person_id: 7, group_id: 10, started_at: '2026-01-01T00:00:00Z', ended_at: '2026-06-01T00:00:00Z' },
      { person_id: 7, group_id: 49, started_at: '2026-06-01T00:00:00Z', ended_at: '2026-09-01T00:00:00Z' },
      { person_id: 7, group_id: 541877, started_at: '2026-09-01T00:00:00Z', ended_at: null },
    ],
  }));
  assert.equal(finding.proposedChange.fromGroupId, 49);
  assert.equal(finding.proposedChange.to, '2026-08-03T00:00:00Z');
  assert.equal(finding.proposedChange.personId, 7, 'the person is part of the proposal, so apply can re-check them');
});
