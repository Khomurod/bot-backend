/**
 * TRAILER_DEPARTMENT_ENABLED resolution: absent means enabled, `false` is the
 * kill switch, and an explicit typo must never silently enable the department.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { resolveTrailerDepartmentEnabled } = require('../config/trailerDepartmentFlag');

test('a missing TRAILER_DEPARTMENT_ENABLED enables the department', () => {
  assert.equal(resolveTrailerDepartmentEnabled(undefined), true);
  assert.equal(resolveTrailerDepartmentEnabled(null), true);
  assert.equal(resolveTrailerDepartmentEnabled(''), true);
  assert.equal(resolveTrailerDepartmentEnabled('   '), true);
});

test('true enables and false disables the department', () => {
  assert.equal(resolveTrailerDepartmentEnabled('true'), true);
  assert.equal(resolveTrailerDepartmentEnabled(' TRUE '), true);
  assert.equal(resolveTrailerDepartmentEnabled('false'), false);
  assert.equal(resolveTrailerDepartmentEnabled('False'), false);
});

test('explicit invalid values fail closed instead of enabling', (t) => {
  t.mock.method(console, 'error', () => {});
  for (const value of ['1', '0', 'yes', 'no', 'on', 'enabled', 'maybe']) {
    assert.equal(resolveTrailerDepartmentEnabled(value), false, `"${value}" must fail closed`);
  }
});

test('config.js resolves the flag through the shared resolver', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../config/config.js'), 'utf8');
  assert.ok(
    /trailerDepartmentEnabled:\s*resolveTrailerDepartmentEnabled\(process\.env\.TRAILER_DEPARTMENT_ENABLED\)/.test(src),
    'config must resolve the flag through resolveTrailerDepartmentEnabled',
  );
  assert.ok(
    !/TRAILER_DEPARTMENT_ENABLED\s*===\s*'true'/.test(src),
    'the old strict === "true" check must be gone (it disabled the department by default)',
  );
});
