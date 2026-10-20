'use strict';

/**
 * lib/drivers/titleSync.js — a driver profile follows its chat's title.
 * A rename is a person's act and is followed even over a manual setting, but
 * only for what it changed; the startup reconcile only brings profiles up to
 * an explicit claim, never over a manual setting, and never reactivates.
 * Unit numbers and names are made up.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { profilePatchFromTitle } = require('../lib/drivers/titleSync');
const { inferDriverType, titleFleetClaim } = require('../lib/drivers/driverProfileParse');

const owner = { driver_type: 'owner', driver_type_source: 'bot', status: 'active' };

test('"( COMPANY )" on its own is a company driver; LEASE a lease driver; nothing an owner', () => {
  assert.equal(inferDriverType('WENZE UNIT # 121 SAM DOE ( COMPANY )'), 'company_driver');
  assert.equal(inferDriverType('WENZE UNIT # 983 SAM DOE ( COMPANY ) INACTIVE'), 'company_driver');
  assert.equal(inferDriverType('WENZE UNIT # 9 SAM DOE (COMPANY DRIVER)'), 'company_driver');
  assert.equal(inferDriverType('WENZE UNIT # 9 SAM DOE (LEASE)'), 'lease');
  assert.equal(inferDriverType('WENZE UNIT # 757 SAM DOE'), 'owner');
  assert.equal(titleFleetClaim('WENZE UNIT # 757 SAM DOE'), null, 'no claim is not a claim');
});

test('RECONCILE: an explicit fleet word and "INACTIVE" are applied, unless a person set them', () => {
  const t = 'WENZE UNIT # 983 SAM DOE ( COMPANY ) INACTIVE';
  assert.deepEqual(profilePatchFromTitle(owner, { title: t }), {
    patch: { driver_type: 'company_driver', driver_type_source: 'bot', status: 'inactive' },
    changed: ['driver_type', 'status'],
  });
  assert.deepEqual(profilePatchFromTitle({ ...owner, driver_type_source: 'manual' }, { title: t, statusSource: 'manual' }),
    { patch: {}, changed: [] }, 'manual settings stand');
});

test('RECONCILE never reactivates, and never makes a set type "owner" for a title that says nothing', () => {
  const company = { driver_type: 'company_driver', driver_type_source: 'bot', status: 'inactive' };
  assert.deepEqual(profilePatchFromTitle(company, { title: 'WENZE UNIT # 40 SAM DOE' }), { patch: {}, changed: [] });
});

test('A RENAME is followed — even over a manual setting — for what it changed', () => {
  const manual = { driver_type: 'owner', driver_type_source: 'manual', status: 'active' };
  const out = profilePatchFromTitle(manual, {
    previousName: 'WENZE UNIT # 121 SAM DOE', title: 'WENZE UNIT # 121 SAM DOE ( COMPANY ) INACTIVE', statusSource: 'manual',
  });
  assert.deepEqual(out.changed, ['driver_type', 'status']);
  assert.equal(out.patch.status, 'inactive');

  const back = profilePatchFromTitle({ ...owner, status: 'inactive' }, {
    previousName: 'WENZE UNIT # 121 SAM DOE INACTIVE', title: 'WENZE UNIT # 121 SAM DOE',
  });
  assert.deepEqual(back.patch, { status: 'active' }, '"INACTIVE" removed: active again');

  const unrelated = profilePatchFromTitle({ ...owner, status: 'inactive' }, {
    previousName: 'WENZE UNIT # 121 SAM DOE', title: 'WENZE UNIT # 122 SAM DOE',
  });
  assert.deepEqual(unrelated.changed, [], 'a unit renumbered says nothing about status or fleet');
});
