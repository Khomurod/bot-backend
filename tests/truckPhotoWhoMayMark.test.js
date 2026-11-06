'use strict';

/**
 * lib/truckPhotos/whoMayMark.js — the owner's rule: anybody marks a hand-over
 * except the group's own driver, and only where that can actually be told —
 * a solo group whose driver's account is known. A team group, an unlinked
 * driver and a group nobody could read all answer yes.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { mayMark } = require('../lib/truckPhotos/whoMayMark');

test('solo group: the driver may not mark their own hand-over; the fleet manager may', () => {
  const driver = { driverAccountIds: ['5001'], isTeam: false };
  assert.equal(mayMark({ authorId: 5001, ...driver }), false, 'a number and a string id are the same account');
  assert.equal(mayMark({ authorId: '5001', ...driver }), false);
  assert.equal(mayMark({ authorId: 7002, ...driver }), true, 'the fleet manager');
});

test('every known account of the driver counts — a second phone too', () => {
  const driver = { driverAccountIds: ['5001', '5009'], isTeam: false };
  assert.equal(mayMark({ authorId: 5009, ...driver }), false);
});

test('solo group with no linked account: anybody, because nobody can be told apart', () => {
  assert.equal(mayMark({ authorId: 5001, driverAccountIds: [], isTeam: false }), true);
  assert.equal(mayMark({ authorId: 5001, isTeam: false }), true);
});

test('team group: the drivers may mark too', () => {
  assert.equal(mayMark({ authorId: 5001, driverAccountIds: ['5001', '5002'], isTeam: true }), true);
});

test('unknown (the group could not be read): anybody', () => {
  assert.equal(mayMark({ authorId: 5001, driverAccountIds: ['5001'], isTeam: null }), true);
  assert.equal(mayMark({ authorId: 5001, driverAccountIds: ['5001'] }), true);
  assert.equal(mayMark({}), true);
  assert.equal(mayMark(), true);
});

test('an author with no id cannot be the driver', () => {
  assert.equal(mayMark({ authorId: null, driverAccountIds: ['5001'], isTeam: false }), true);
});
