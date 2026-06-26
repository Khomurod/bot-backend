const test = require('node:test');
const assert = require('node:assert');
const {
  computeReadingVerdict,
  RECENT_SEEN_DAYS,
  buildAdminGrantPayload,
  parseAdminGrantPayload,
} = require('../services/groupAccessConstants');

const NOW = Date.parse('2026-06-24T12:00:00Z');
const daysAgo = (n) => new Date(NOW - n * 24 * 60 * 60 * 1000).toISOString();

test('admin role always reads, even with no recent messages', () => {
  const v = computeReadingVerdict({ memberStatus: 'administrator', lastMessageSeenAt: null, now: NOW });
  assert.strictEqual(v.reading, 'reads_all');
  assert.strictEqual(v.level, 'ok');
});

test('left/kicked/not_found means the bot is not in the group', () => {
  for (const status of ['left', 'kicked', 'not_found']) {
    const v = computeReadingVerdict({ memberStatus: status, lastMessageSeenAt: daysAgo(0), now: NOW });
    assert.strictEqual(v.reading, 'not_in_group');
    assert.strictEqual(v.level, 'bad');
  }
});

test('member with recent messages is reading (ground truth wins)', () => {
  const v = computeReadingVerdict({ memberStatus: 'member', lastMessageSeenAt: daysAgo(1), now: NOW });
  assert.strictEqual(v.reading, 'reads_active');
  assert.strictEqual(v.level, 'ok');
});

test('member with no recent messages is flagged as maybe blocked', () => {
  const v = computeReadingVerdict({
    memberStatus: 'member',
    lastMessageSeenAt: daysAgo(RECENT_SEEN_DAYS + 5),
    now: NOW,
  });
  assert.strictEqual(v.reading, 'maybe_blocked');
  assert.strictEqual(v.level, 'warn');
});

test('member never seen is flagged as maybe blocked', () => {
  const v = computeReadingVerdict({ memberStatus: 'member', lastMessageSeenAt: null, now: NOW });
  assert.strictEqual(v.reading, 'maybe_blocked');
  assert.strictEqual(v.level, 'warn');
});

test('unchecked group with recent messages still counts as reading', () => {
  const v = computeReadingVerdict({ memberStatus: null, lastMessageSeenAt: daysAgo(2), now: NOW });
  assert.strictEqual(v.reading, 'reads_active');
  assert.strictEqual(v.level, 'ok');
});

test('unchecked group with no activity is unknown', () => {
  const v = computeReadingVerdict({ memberStatus: null, lastMessageSeenAt: null, now: NOW });
  assert.strictEqual(v.reading, 'unknown');
  assert.strictEqual(v.level, 'unknown');
});

test('admin-grant payload round-trips and rejects junk', () => {
  assert.strictEqual(buildAdminGrantPayload(42), 'htadmin_42');
  assert.strictEqual(parseAdminGrantPayload('htadmin_42'), 42);
  assert.strictEqual(parseAdminGrantPayload(buildAdminGrantPayload(7)), 7);
  assert.strictEqual(parseAdminGrantPayload('htadmin_0'), null);
  assert.strictEqual(parseAdminGrantPayload('htadmin_abc'), null);
  assert.strictEqual(parseAdminGrantPayload('other_5'), null);
  assert.strictEqual(parseAdminGrantPayload(''), null);
  assert.strictEqual(parseAdminGrantPayload(null), null);
});
