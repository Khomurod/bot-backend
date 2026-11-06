'use strict';

/**
 * The race boards' birthday list (services/grossRace/birthdays.js): what it
 * holds, for how long, how many, and that what the page is told is a name, an
 * American name or a truck number — never a Telegram account or a date of birth.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createBirthdayBoard, birthdayKey, HOLD_MS, MAX_HELD } = require('../services/grossRace/birthdays');

const T0 = Date.parse('2026-11-06T19:00:00Z');
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

function boardAt(start = T0) {
  let at = start;
  const board = createBirthdayBoard({ now: () => at });
  return { board, move: (ms) => { at += ms; } };
}

test('an employee and a driver: what the page is told, oldest send first', () => {
  const { board } = boardAt();
  board.noteBirthday({ kind: 'driver', id: 42, name: 'John  Smith', truck: ' 1109 ', sentAt: T0 });
  board.noteBirthday({ kind: 'employee', id: 7, name: 'Testbek', subtitle: 'Tom', sentAt: T0 - 1000, card: jpeg });
  assert.deepEqual(board.todaysBirthdays(), [
    { key: 'employee-7-2026-11-06', kind: 'employee', name: 'Testbek', subtitle: 'Tom', truck: null, sentAt: new Date(T0 - 1000).toISOString(), card: '/api/gross-race/birthday-card/employee-7-2026-11-06' },
    { key: 'driver-42-2026-11-06', kind: 'driver', name: 'John Smith', subtitle: null, truck: '1109', sentAt: new Date(T0).toISOString(), card: null },
  ]);
  assert.equal(board.cardFor('employee-7-2026-11-06'), jpeg);
  assert.equal(board.cardFor('driver-42-2026-11-06'), null, 'a driver has no card');
});

test('nothing else ever reaches the page, whatever a caller hands in', () => {
  const { board } = boardAt();
  board.noteBirthday({
    kind: 'employee', id: 7, name: 'Testbek', subtitle: 'Tom', card: jpeg, sentAt: T0,
    telegram_username: 'tg_handle_x', telegram_user_id: '123456', birthday: '1990-11-06', phone: '+1555',
  });
  const [only] = board.todaysBirthdays();
  assert.deepEqual(Object.keys(only).sort(), ['card', 'key', 'kind', 'name', 'sentAt', 'subtitle', 'truck']);
  assert.doesNotMatch(JSON.stringify(only), /tg_handle_x|123456|1990|555/i);
});

test('a birthday stays for a day from its send, then goes, card and all', () => {
  const { board, move } = boardAt();
  board.noteBirthday({ kind: 'employee', id: 7, name: 'Testbek', card: jpeg, sentAt: T0 });
  move(HOLD_MS - 1);
  assert.equal(board.todaysBirthdays().length, 1);
  assert.ok(board.cardFor('employee-7-2026-11-06'));
  move(1);
  assert.deepEqual(board.todaysBirthdays(), []);
  assert.equal(board.cardFor('employee-7-2026-11-06'), null);
});

test(`at most ${MAX_HELD}: the newest are kept`, () => {
  const { board } = boardAt();
  for (let i = 1; i <= MAX_HELD + 5; i += 1) board.noteBirthday({ kind: 'driver', id: i, name: `Driver ${i}`, sentAt: T0 - (MAX_HELD + 5 - i) * 1000 });
  const held = board.todaysBirthdays();
  assert.equal(held.length, MAX_HELD);
  assert.equal(held[0].name, 'Driver 6');
  assert.equal(held[held.length - 1].name, `Driver ${MAX_HELD + 5}`);
});

test('the same person noted twice the same day is one birthday', () => {
  const { board } = boardAt();
  board.noteBirthday({ kind: 'driver', id: 42, name: 'John', truck: '1', sentAt: T0 });
  board.noteBirthday({ kind: 'driver', id: 42, name: 'John', truck: '01', sentAt: T0 + 60_000 });
  assert.deepEqual(board.todaysBirthdays().map((b) => b.truck), ['01']);
});

test('refused, quietly: an unknown kind, no id, no name, a bad date', () => {
  const { board } = boardAt();
  assert.equal(board.noteBirthday({ kind: 'admin', id: 1, name: 'X' }), null);
  assert.equal(board.noteBirthday({ kind: 'driver', id: null, name: 'X' }), null);
  assert.equal(board.noteBirthday({ kind: 'driver', id: '1; drop', name: 'X' }), null);
  assert.equal(board.noteBirthday({ kind: 'driver', id: 1, name: '  ' }), null);
  assert.equal(board.noteBirthday({ kind: 'driver', id: 1, name: 'X', sentAt: 'never' }), null);
  assert.equal(board.noteBirthday(), null);
  assert.deepEqual(board.todaysBirthdays(), []);
});

test('the key names the person and the UTC day of the send', () => {
  assert.equal(birthdayKey('employee', 7, Date.parse('2026-11-06T23:59:59Z')), 'employee-7-2026-11-06');
  assert.equal(birthdayKey('driver', 42, Date.parse('2026-11-07T00:00:00Z')), 'driver-42-2026-11-07');
});
