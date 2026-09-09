/**
 * Who the people are — the pure planning decision.
 *
 * The fixtures are the real production shapes, because that is what the rules
 * were written against: RUSLAN ABDULLAEV on two live chats with one Telegram
 * account, unit '001' claimed by four groups at once, and 20 name collisions
 * that are NOT evidence of anything.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { planPersonBackfill } = require('../services/identity/personBackfillPlan');

function group(id, name, extra = {}) {
  return {
    group_id: id,
    group_name: name,
    first_name: null, last_name: null,
    secondary_first_name: null, secondary_last_name: null,
    unit_number: null, telegram_user_id: null, date_of_birth: null,
    ...extra,
  };
}

test('a group with no twin is one person', () => {
  const plan = planPersonBackfill([
    group(1, 'WENZE UNIT # 555 JAVLON TURAEV', { first_name: 'JAVLON', last_name: 'TURAEV', unit_number: '555' }),
  ]);
  assert.equal(plan.people.length, 1);
  assert.equal(plan.people[0].displayName, 'JAVLON TURAEV');
  assert.equal(plan.people[0].unitNumber, '555');
  assert.equal(plan.people[0].groups[0].associationSource, 'backfill');
});

test('a shared telegram_user_id is a hard anchor: two chats, one person', () => {
  // The real case: group 49 holds the history, 541877 is the recreated chat.
  const plan = planPersonBackfill([
    group(49, 'WENZE UNIT # 27 RUSLAN ABDULLAEV', {
      first_name: 'RUSLAN', last_name: 'ABDULLAEV', unit_number: '27', telegram_user_id: 8606595680,
    }),
    group(541877, 'WENZE UNIT # 27 RUSLAN ABDULLAEV', {
      first_name: 'RUSLAN', last_name: 'ABDULLAEV', unit_number: '27', telegram_user_id: 8606595680,
    }),
  ]);

  assert.equal(plan.people.length, 1, 'one human, not two');
  const person = plan.people[0];
  assert.deepEqual(person.groups.map((g) => g.groupId).sort((a, b) => a - b), [49, 541877]);
  assert.equal(person.groups[0].associationSource, 'telegram_user_id');
  assert.equal(person.groups[0].confidence, 100);
  assert.equal(person.unitNumber, '27');
  assert.equal(plan.stats.anchoredClusters, 1);
  assert.equal(plan.mergeCandidates.length, 0, 'already merged — not also a candidate');
});

test('a shared NAME is only a candidate — never an automatic merge', () => {
  const plan = planPersonBackfill([
    group(61, 'WENZE UNIT # 310 OMAR ALAWAD', { first_name: 'OMAR', last_name: 'ALAWAD', unit_number: '310' }),
    group(71, 'WENZE UNIT # 005 OMAR ALAWAD', { first_name: 'OMAR', last_name: 'ALAWAD', unit_number: '005' }),
  ]);

  assert.equal(plan.people.length, 2, 'a name is not an identity');
  assert.equal(plan.mergeCandidates.length, 1);
  assert.deepEqual(
    plan.mergeCandidates[0].people.map((p) => p.groupIds).flat().sort((a, b) => a - b),
    [61, 71]
  );
});

test('a unit claimed by more than one person is left unclaimed, not arbitrated', () => {
  // Production: unit '001' sits on four active driver groups.
  const rows = [
    group(11, 'WENZE UNIT # 001 OLABODE OLUDAISI', { first_name: 'OLABODE', last_name: 'OLUDAISI', unit_number: '001' }),
    group(12, 'WENZE UNIT # 001A RALPH MICHEL', { first_name: 'RALPH', last_name: 'MICHEL', unit_number: '001' }),
    group(13, 'WENZE UNIT # 001 STARKS DAYMON', { first_name: 'STARKS', last_name: 'DAYMON', unit_number: '001' }),
    group(14, 'WENZE UNIT # 001 UROZALI TAJIBAEV', { first_name: 'UROZALI', last_name: 'TAJIBAEV', unit_number: '001' }),
  ];
  const plan = planPersonBackfill(rows);

  assert.equal(plan.people.length, 4);
  assert.equal(plan.contestedUnits.length, 1);
  assert.equal(plan.contestedUnits[0].unitNumber, '001');
  assert.equal(plan.contestedUnits[0].people.length, 4);
  for (const person of plan.people) {
    assert.equal(person.unitNumber, null, 'picking a winner would invent a fact');
  }
  assert.equal(plan.stats.unitsClaimed, 0);
});

test("leading zeros are NOT normalized away — '001', '01' and '1' are different trucks", () => {
  const plan = planPersonBackfill([
    group(21, 'WENZE UNIT # 001 A', { first_name: 'A', last_name: 'ONE', unit_number: '001' }),
    group(22, 'WENZE UNIT # 01 B', { first_name: 'B', last_name: 'TWO', unit_number: '01' }),
    group(23, 'WENZE UNIT # 1 C', { first_name: 'C', last_name: 'THREE', unit_number: '1' }),
  ]);
  assert.equal(plan.contestedUnits.length, 0, 'tidying zeros would fabricate a collision');
  assert.equal(plan.stats.unitsClaimed, 3);
});

test('an anchored cluster takes its name and unit from the NEWEST group', () => {
  const plan = planPersonBackfill([
    group(100, 'WENZE UNIT # 320 SIROJIDDIN DAVUROV', {
      first_name: 'SIROJIDDIN', last_name: 'DAVUROV', unit_number: '320', telegram_user_id: 777,
    }),
    group(900, 'WENZE UNIT # 322 SIROJIDDIN DAVUROV', {
      first_name: 'SIROJIDDIN', last_name: 'DAVUROV', unit_number: '322', telegram_user_id: 777,
    }),
  ]);
  assert.equal(plan.people.length, 1);
  assert.equal(plan.people[0].unitNumber, '322', 'the current truck, not the old one');
  assert.equal(plan.people[0].groups[0].groupId, 900, 'newest first');
});

test('a null telegram_user_id never anchors anything', () => {
  const plan = planPersonBackfill([
    group(31, 'WENZE UNIT # 7 A', { first_name: 'A', last_name: 'X', telegram_user_id: null }),
    group(32, 'WENZE UNIT # 8 B', { first_name: 'B', last_name: 'Y', telegram_user_id: null }),
  ]);
  assert.equal(plan.people.length, 2);
  assert.equal(plan.stats.anchoredClusters, 0);
});

test('a date of birth is carried onto the person when any group has one', () => {
  const plan = planPersonBackfill([
    group(41, 'WENZE UNIT # 9 A', { first_name: 'A', last_name: 'X', telegram_user_id: 5, date_of_birth: null }),
    group(42, 'WENZE UNIT # 9 A', { first_name: 'A', last_name: 'X', telegram_user_id: 5, date_of_birth: '1990-04-01' }),
  ]);
  assert.equal(plan.people.length, 1);
  assert.equal(plan.people[0].dateOfBirth, '1990-04-01');
});

test('a group with no parseable name still becomes a person', () => {
  const plan = planPersonBackfill([group(51, 'Some Admin Chat')]);
  assert.equal(plan.people.length, 1);
  assert.ok(plan.people[0].displayName, 'a person always needs a label');
  assert.equal(plan.stats.peopleWithoutNameKey, 1);
});

test('rows without a group id are ignored rather than crashing the run', () => {
  const plan = planPersonBackfill([null, undefined, { group_name: 'orphan' }, group(61, 'WENZE UNIT # 2 A')]);
  assert.equal(plan.people.length, 1);
  assert.equal(plan.stats.groups, 1);
});
