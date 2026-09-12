'use strict';

/**
 * Picking the driver out of a room that also contains their dispatcher.
 *
 * A wrong link puts one person's Telegram account on another person's record,
 * after which every "who is this" lookup through that account answers with the
 * wrong human. So most of this file is about the cases the rule refuses.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  decideTelegramLink, plausibleCandidates, isStaff, CHECKS, LINK_CONFIDENCE, STAFF_GROUP_COUNT,
} = require('../lib/identity/telegramResolution');

function member(over = {}) {
  return {
    telegramUserId: 501, firstName: 'JOHN', lastName: 'SMITH',
    username: 'jsmith', isBot: false, source: 'driver', driverGroupCount: 1, ...over,
  };
}

// ── the only case that links ────────────────────────────────────────────────

test('one person in the chat whose name matches the driver', () => {
  const got = decideTelegramLink({ driverName: 'JOHN SMITH', members: [member()] });
  assert.equal(got.action, 'link');
  assert.equal(got.telegramUserId, '501');
  assert.equal(got.confidence, LINK_CONFIDENCE);
});

test('a Telegram display name that is a nickname still matches', () => {
  // A driver's Telegram name is a nickname as often as a legal name. Demanding
  // an exact match here would refuse almost every true link — and unlike the
  // board rule, the field is ONE person in this driver's own chat.
  const got = decideTelegramLink({
    driverName: 'JOHN SMITH', members: [member({ firstName: 'John', lastName: 'Smith 🚛' })],
  });
  assert.equal(got.action, 'link');
});

// ── the refusals ────────────────────────────────────────────────────────────

test('A USERNAME IS NEVER EVIDENCE', () => {
  // Reassignable: its owner can change it and a stranger can claim the old one
  // the next day. A member whose ONLY resemblance is the username must not link.
  const got = decideTelegramLink({
    driverName: 'JOHN SMITH',
    members: [member({ firstName: 'Ivan', lastName: 'Petrov', username: 'johnsmith' })],
  });
  assert.equal(got.action, 'ask');
  assert.equal(got.checkKey, CHECKS.UNNAMED);
  assert.equal(got.telegramUserId, null);
});

test('TWO CANDIDATES IS A QUESTION, NOT A CHOICE', () => {
  const got = decideTelegramLink({
    driverName: 'JOHN SMITH',
    members: [member(), member({ telegramUserId: 502, firstName: 'ANN', lastName: 'LEE' })],
  });
  assert.equal(got.action, 'ask');
  assert.equal(got.checkKey, CHECKS.AMBIGUOUS);
  assert.equal(got.candidates, 2);
});

test('A TEAM CHAT IS NEVER RESOLVED AUTOMATICALLY', () => {
  // Two drivers, and which account is which cannot be told without reading
  // messages — which is not something this does.
  const got = decideTelegramLink({
    driverName: 'JOHN SMITH', members: [member()], isTeamChat: true,
  });
  assert.equal(got.action, 'ask');
  assert.equal(got.checkKey, CHECKS.AMBIGUOUS);
});

test('a person who already has an account is left alone', () => {
  const got = decideTelegramLink({
    driverName: 'JOHN SMITH', members: [member()], alreadyLinked: true,
  });
  assert.equal(got.action, 'none');
});

test('a profile naming nobody has nothing to match against', () => {
  for (const name of ['', '   ', null, undefined]) {
    assert.equal(decideTelegramLink({ driverName: name, members: [member()] }).action, 'none');
  }
});

test('an empty chat is silence, not a question', () => {
  const got = decideTelegramLink({ driverName: 'JOHN SMITH', members: [] });
  assert.equal(got.action, 'none');
  assert.match(got.reason, /nobody has been seen/);
});

// ── who is filtered out before any matching ─────────────────────────────────

test('A DISPATCHER IS IN EVERY DRIVER CHAT and is never a candidate', () => {
  // Without this they would be the "one candidate" in dozens of chats.
  for (const source of ['dispatcher', 'admin', 'ADMIN']) {
    const got = decideTelegramLink({
      driverName: 'JOHN SMITH', members: [member({ source })],
    });
    assert.equal(got.action, 'none', source);
    assert.equal(got.candidates, 0, source);
  }
});

test('AN UNLABELLED MANAGER IS CAUGHT BY HOW MANY CHATS THEY ARE IN', () => {
  // The signal that does not depend on anybody having labelled them. A driver
  // is in one driver chat.
  assert.equal(isStaff({ source: 'driver', driverGroupCount: STAFF_GROUP_COUNT }), true);
  assert.equal(isStaff({ source: 'driver', driverGroupCount: STAFF_GROUP_COUNT - 1 }), false);

  const got = decideTelegramLink({
    driverName: 'JOHN SMITH', members: [member({ driverGroupCount: 5 })],
  });
  assert.equal(got.action, 'none');
});

test('a bot is never a candidate', () => {
  const got = decideTelegramLink({ driverName: 'JOHN SMITH', members: [member({ isBot: true })] });
  assert.equal(got.action, 'none');
});

test('AN ACCOUNT ALREADY LINKED TO SOMEBODY ELSE IS NOT OFFERED', () => {
  // One human per account at a time is the schema's anchor. Offering a taken
  // account would propose a correction the database then refuses.
  const got = decideTelegramLink({
    driverName: 'JOHN SMITH', members: [member({ alreadyLinked: true })],
  });
  assert.equal(got.action, 'none');
  assert.equal(got.candidates, 0);
});

test('the filter is shared, so a check can explain itself the same way', () => {
  const members = [
    member(),
    member({ telegramUserId: 502, isBot: true }),
    member({ telegramUserId: 503, source: 'dispatcher' }),
    member({ telegramUserId: 504, alreadyLinked: true }),
    member({ telegramUserId: 505, driverGroupCount: 9 }),
  ];
  assert.deepEqual(plausibleCandidates(members).map((m) => m.telegramUserId), [501]);
});

test('a member row with no account id is not a candidate', () => {
  assert.deepEqual(plausibleCandidates([member({ telegramUserId: null }), null, undefined]), []);
});
