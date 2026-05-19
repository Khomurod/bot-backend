const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildDriverCandidate,
  scoreDriverNameMatch,
  searchDriverGroupsByNameInList,
  formatDriverPickLabel,
} = require('../services/driverStatusLookupService');

const mockGroups = [
  {
    id: 1,
    group_name: 'WENZE UNIT # 2908 TESFAMARIAM YOSIEF (COMPANY DRIVER)',
    telegram_group_id: '-1001',
  },
  {
    id: 2,
    group_name: 'WENZE UNIT # 1204 JOHN SMITH',
    telegram_group_id: '-1002',
  },
  {
    id: 3,
    group_name: 'WENZE UNIT # 883 JOHN ADAMS (COMPANY DRIVER)',
    telegram_group_id: '-1003',
  },
  {
    id: 4,
    group_name: 'Automatic updating (Test)',
    telegram_group_id: '-5289094495',
  },
];

test('buildDriverCandidate extracts driver and unit from group title', () => {
  const c = buildDriverCandidate(mockGroups[0]);
  assert.equal(c.driverName, 'TESFAMARIAM YOSIEF');
  assert.equal(c.unitNumber, '2908');
});

test('searchDriverGroupsByNameInList matches full name and single tokens', () => {
  const full = searchDriverGroupsByNameInList(mockGroups, 'Tesfamariam Yosief');
  assert.equal(full.length, 1);
  assert.equal(full[0].groupId, 1);

  const last = searchDriverGroupsByNameInList(mockGroups, 'Yosief');
  assert.equal(last.length, 1);
  assert.equal(last[0].groupId, 1);

  const first = searchDriverGroupsByNameInList(mockGroups, 'Tesfamariam');
  assert.equal(first.length, 1);
  assert.equal(first[0].groupId, 1);
});

test('searchDriverGroupsByNameInList returns multiple matches for duplicate first names', () => {
  const matches = searchDriverGroupsByNameInList(mockGroups, 'John');
  assert.equal(matches.length, 2);
  assert.deepEqual(
    matches.map((m) => m.groupId).sort(),
    [2, 3]
  );
});

test('searchDriverGroupsByNameInList excludes test hub group', () => {
  const matches = searchDriverGroupsByNameInList(mockGroups, 'Automatic');
  assert.equal(matches.length, 0);
});

test('searchDriverGroupsByNameInList returns empty for unknown driver', () => {
  const matches = searchDriverGroupsByNameInList(mockGroups, 'Nobody Here');
  assert.equal(matches.length, 0);
});

test('formatDriverPickLabel includes unit and driver name', () => {
  const c = buildDriverCandidate(mockGroups[0]);
  assert.equal(formatDriverPickLabel(c), 'UNIT #2908 — TESFAMARIAM YOSIEF');
});

test('scoreDriverNameMatch ranks exact match highest', () => {
  const c = buildDriverCandidate(mockGroups[0]);
  assert.equal(scoreDriverNameMatch('TESFAMARIAM YOSIEF', c), 100);
  assert.equal(scoreDriverNameMatch('Yosief', c), 70);
});
