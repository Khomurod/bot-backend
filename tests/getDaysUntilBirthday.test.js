const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getDaysUntilBirthday,
  sortBySoonestBirthday,
  parseDriverNameFromGroupTitle,
} = require('../utils/birthdaySort');

test('getDaysUntilBirthday returns Infinity for missing dates', () => {
  assert.equal(getDaysUntilBirthday(null), Infinity);
  assert.equal(getDaysUntilBirthday(undefined), Infinity);
  assert.equal(getDaysUntilBirthday(''), Infinity);
});

test('getDaysUntilBirthday returns Infinity for invalid dates', () => {
  assert.equal(getDaysUntilBirthday('not-a-date'), Infinity);
});

test('sortBySoonestBirthday orders soonest birthday first', () => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const nextMonth = new Date(today);
  nextMonth.setMonth(nextMonth.getMonth() + 1);

  const fmt = (d) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  };

  const items = [
    { id: 1, birthday: fmt(nextMonth) },
    { id: 2, birthday: fmt(tomorrow) },
    { id: 3, birthday: null },
  ];

  const sorted = sortBySoonestBirthday(items, (x) => x.birthday);
  assert.deepEqual(sorted.map((x) => x.id), [2, 1, 3]);
});

test('getDaysUntilBirthday rolls to next year when birthday passed this year', () => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const past = new Date(today);
  past.setDate(past.getDate() - 10);
  const y = past.getFullYear();
  const m = String(past.getMonth() + 1).padStart(2, '0');
  const d = String(past.getDate()).padStart(2, '0');
  const days = getDaysUntilBirthday(`${y}-${m}-${d}`);

  assert.ok(days > 300, `expected ~355 days until next occurrence, got ${days}`);
});

test('parseDriverNameFromGroupTitle extracts driver from WENZE-style titles', () => {
  assert.equal(
    parseDriverNameFromGroupTitle('WENZE UNIT # 2908 TESFAMARIAM YOSIEF (COMPANY DRIVER)'),
    'TESFAMARIAM YOSIEF',
  );
  assert.equal(parseDriverNameFromGroupTitle(''), null);
});

test('sortBySoonestBirthday does not mutate input array', () => {
  const items = [{ birthday: '2000-12-25' }, { birthday: '2000-01-01' }];
  const copy = [...items];
  sortBySoonestBirthday(items, (x) => x.birthday);
  assert.deepEqual(items, copy);
});
