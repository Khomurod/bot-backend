'use strict';

/**
 * After a restart, the last day's birthdays come back on the race boards from
 * what the birthday services recorded as sent — one read, the card drawn once,
 * and a failure costs nothing but the restore.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { restoreRaceBirthdays, readSends } = require('../services/grossRace/birthdayRestore');
const { createBirthdayBoard } = require('../services/grossRace/birthdays');

const NOW = Date.parse('2026-11-06T20:00:00Z');
const quiet = { log() {}, warn() {} };

function fakeDb(sends, { employees = [], faces = [] } = {}) {
  const asked = [];
  return {
    asked,
    getRecentBirthdaySends: async () => { asked.push('sends'); return sends; },
    getEmployeesForCards: async (ids) => { asked.push(['employees', ids]); return employees.filter((e) => ids.includes(e.id)); },
    getDriverFaces: async (ids) => { asked.push(['faces', ids]); return faces.filter((f) => ids.includes(f.id)); },
  };
}

test('only what was SENT counts: an employee claim without :sent, or an old day key, is not a birthday on the board', () => {
  const { employees, drivers } = readSends([
    { runKey: 'employee:2026-11-07:7:sent', ageSeconds: 3600 },
    { runKey: 'employee:2026-11-07:8', ageSeconds: 3600 },
    { runKey: 'employee:2026-11-07', ageSeconds: 3600 },
    { runKey: 'driver:42:2026-11-06', ageSeconds: 7200 },
    { runKey: 'driver:x:2026-11-06', ageSeconds: 7200 },
    { runKey: 'weekly:2026-11-02', ageSeconds: 10 },
  ], NOW);
  assert.deepEqual(employees, [{ id: 7, sentAt: NOW - 3600_000 }]);
  assert.deepEqual(drivers, [{ id: 42, sentAt: NOW - 7200_000 }]);
});

test('employees with their card drawn again, drivers with the truck on their profile', async () => {
  const board = createBirthdayBoard({ now: () => NOW });
  const db = fakeDb(
    [{ runKey: 'employee:2026-11-07:7:sent', ageSeconds: 3600 }, { runKey: 'driver:42:2026-11-06', ageSeconds: 7200 }],
    {
      employees: [{ id: 7, first_name: 'TESTBEK', last_name: 'X', american_name: 'Tom' }],
      faces: [{ id: 42, group_name: 'WENZE UNIT # 1109 JOHN SMITH', unit_number: '1109' }],
    },
  );
  const drawn = [];
  const card = Buffer.from([0xff, 0xd8]);
  const n = await restoreRaceBirthdays({
    db, board, now: () => NOW, log: quiet, prepareCard: async (e) => { drawn.push(e.id); return card; },
  });
  assert.equal(n, 2);
  assert.deepEqual(drawn, [7], 'each card drawn once');
  const held = board.todaysBirthdays();
  assert.deepEqual(held.map((b) => [b.kind, b.name, b.subtitle, b.truck]), [
    ['driver', 'John Smith', null, '1109'], ['employee', 'Testbek', 'Tom', null],
  ]);
  assert.equal(board.cardFor(held[1].key), card);
  assert.equal(held[0].sentAt, new Date(NOW - 7200_000).toISOString(), 'the send time, not the restart');
});

test('a card that cannot be drawn again: the employee is still on the board, without it', async () => {
  const board = createBirthdayBoard({ now: () => NOW });
  const db = fakeDb([{ runKey: 'employee:2026-11-07:7:sent', ageSeconds: 60 }], { employees: [{ id: 7, first_name: 'TESTBEK', american_name: '' }] });
  await restoreRaceBirthdays({ db, board, now: () => NOW, log: quiet, prepareCard: async () => { throw new Error('no font'); } });
  const [only] = board.todaysBirthdays();
  assert.equal(only.name, 'Testbek');
  assert.equal(only.card, null);
});

test('nothing sent in the last day: one read and nothing else', async () => {
  const db = fakeDb([]);
  assert.equal(await restoreRaceBirthdays({ db, board: createBirthdayBoard(), log: quiet }), 0);
  assert.deepEqual(db.asked, ['sends']);
});

test('a database that fails: no throw, nothing restored', async () => {
  const db = { getRecentBirthdaySends: async () => { throw new Error('connection refused'); } };
  assert.equal(await restoreRaceBirthdays({ db, board: createBirthdayBoard(), log: quiet }), 0);
});

test('a person deleted since is skipped, the rest are restored', async () => {
  const board = createBirthdayBoard({ now: () => NOW });
  const db = fakeDb(
    [{ runKey: 'driver:42:2026-11-06', ageSeconds: 60 }, { runKey: 'driver:43:2026-11-06', ageSeconds: 60 }],
    { faces: [{ id: 43, group_name: 'WENZE UNIT # 77 ANN LEE', unit_number: null }] },
  );
  assert.equal(await restoreRaceBirthdays({ db, board, now: () => NOW, log: quiet }), 1);
  assert.deepEqual(board.todaysBirthdays().map((b) => [b.name, b.truck]), [['Ann Lee', null]]);
});
