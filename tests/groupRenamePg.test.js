'use strict';

/**
 * database/groups.js upsertGroup — a renamed chat reports its previous title
 * ONCE, so a driver profile can follow it (services/driverGroupTitleSync.js);
 * a cached answer never looks like a rename again.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createPgHarness, skipWithoutPg } = require('./helpers/pgHarness');

test('a rename reports the previous title once; first sight and cached answers report none',
  { skip: skipWithoutPg() }, async (t) => {
    const h = await createPgHarness(t);
    const { groups } = h.loadDataLayer(['groups']);
    const first = await groups.upsertGroup(-100777, 'WENZE UNIT # 121 SAM DOE');
    assert.equal(first.previous_group_name, null, 'a chat seen the first time');

    const renamed = await groups.upsertGroup(-100777, 'WENZE UNIT # 121 SAM DOE ( COMPANY ) INACTIVE');
    assert.equal(renamed.previous_group_name, 'WENZE UNIT # 121 SAM DOE');
    assert.equal(renamed.group_name, 'WENZE UNIT # 121 SAM DOE ( COMPANY ) INACTIVE');

    const cached = await groups.upsertGroup(-100777, 'WENZE UNIT # 121 SAM DOE ( COMPANY ) INACTIVE');
    assert.equal(cached.previous_group_name, undefined, 'the cache never replays the rename');
  });
