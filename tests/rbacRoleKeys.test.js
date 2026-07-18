/**
 * Pure custom-role key helpers (blocker §11): unique key generation and
 * reserved-key protection, tested without a database.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { slugify, isReservedRoleKey, generateCustomRoleKey } = require('../services/rbac/roleKeys');

test('slugify normalizes a display name', () => {
  assert.equal(slugify('Yard Supervisor'), 'yard_supervisor');
  assert.equal(slugify('  Billing & Payments!! '), 'billing_payments');
  assert.equal(slugify(''), '');
});

test('reserved built-in keys and reserved prefixes are protected', () => {
  for (const k of ['super_admin', 'trailer_manager', 'trailer_viewer']) {
    assert.equal(isReservedRoleKey(k), true, `${k} should be reserved`);
  }
  assert.equal(isReservedRoleKey('admin_full_access'), true);
  assert.equal(isReservedRoleKey('super_duper'), true);
  assert.equal(isReservedRoleKey('custom_yard_supervisor'), false);
});

test('generated keys always carry the custom_ prefix and never a reserved key', () => {
  const key = generateCustomRoleKey('Super Admin', []);
  assert.ok(key.startsWith('custom_'));
  assert.equal(isReservedRoleKey(key), false);
});

test('collisions get a numeric suffix', () => {
  assert.equal(generateCustomRoleKey('Yard Supervisor', []), 'custom_yard_supervisor');
  assert.equal(
    generateCustomRoleKey('Yard Supervisor', ['custom_yard_supervisor']),
    'custom_yard_supervisor_2',
  );
  assert.equal(
    generateCustomRoleKey('Yard Supervisor', ['custom_yard_supervisor', 'custom_yard_supervisor_2']),
    'custom_yard_supervisor_3',
  );
});

test('a name with no usable characters is rejected', () => {
  assert.throws(() => generateCustomRoleKey('!!!', []), (e) => e.code === 'INVALID_ROLE_NAME');
});
