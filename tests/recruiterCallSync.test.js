const test = require('node:test');
const assert = require('node:assert/strict');

const { attributeCalls } = require('../services/recruiterCallSyncService');
const { normalizePhone } = require('../database/ringcentral');

const recruiters = [
  { id: 1, name: 'Jane', phone_number_normalized: '4704804679' },
  { id: 2, name: 'Bob', phone_number_normalized: '2125551234' },
];

test('normalizePhone reduces to last 10 digits', () => {
  assert.equal(normalizePhone('+1 (470) 480-4679'), '4704804679');
  assert.equal(normalizePhone('4704804679'), '4704804679');
  assert.equal(normalizePhone('14704804679'), '4704804679');
  assert.equal(normalizePhone(''), '');
});

test('outbound call attributes to the caller (from) number', () => {
  const rows = attributeCalls([
    { id: 'a', direction: 'Outbound', duration: 90, result: 'Accepted', type: 'Voice',
      from: { phoneNumber: '+14704804679' }, to: { phoneNumber: '+15559998888' }, startTime: '2026-07-02T15:00:00Z' },
  ], recruiters);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].recruiterId, 1);
  assert.equal(rows[0].durationSeconds, 90);
  assert.equal(rows[0].direction, 'Outbound');
});

test('inbound call attributes to the callee (to) number', () => {
  const rows = attributeCalls([
    { id: 'b', direction: 'Inbound', duration: 200, type: 'Voice',
      from: { phoneNumber: '+15551112222' }, to: { phoneNumber: '2125551234' }, startTime: '2026-07-02T15:05:00Z' },
  ], recruiters);
  assert.equal(rows[0].recruiterId, 2);
});

test('calls on unknown numbers are stored but unattributed', () => {
  const rows = attributeCalls([
    { id: 'c', direction: 'Outbound', duration: 30, type: 'Voice',
      from: { phoneNumber: '+19998887777' }, to: { phoneNumber: '+15551112222' }, startTime: '2026-07-02T15:10:00Z' },
  ], recruiters);
  assert.equal(rows[0].recruiterId, null);
  assert.equal(rows[0].id, 'c');
});

test('non-Voice records are skipped', () => {
  const rows = attributeCalls([
    { id: 'd', type: 'Fax', direction: 'Outbound', from: { phoneNumber: '+14704804679' }, to: { phoneNumber: '+1555' }, startTime: '2026-07-02T15:10:00Z' },
  ], recruiters);
  assert.equal(rows.length, 0);
});

test('missing duration defaults to 0', () => {
  const rows = attributeCalls([
    { id: 'e', direction: 'Outbound', type: 'Voice', from: { phoneNumber: '+14704804679' }, to: { phoneNumber: '+1555' }, startTime: '2026-07-02T15:10:00Z' },
  ], recruiters);
  assert.equal(rows[0].durationSeconds, 0);
});
