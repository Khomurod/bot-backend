'use strict';

/**
 * Who a company-driver broadcast reaches.
 *
 * This is the one user-visible behaviour change in Stage A3, and the costly
 * mistake is asymmetric: a driver who quietly STOPS receiving company
 * broadcasts produces no error and no complaint until something important is
 * missed. So the rule is shaped so that no parsing change can exclude a group
 * the previous rule included — only an explicit human decision can — and these
 * tests are mostly about that floor.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { isCompanyDriverGroup } = require('../services/broadcastTargetService');

const g = (group_name, driver_type = null) => ({ group_name, driver_type });

test('the production title forms all still reach the broadcast', () => {
  // Both real shapes quoted in the Phase 2 findings.
  assert.equal(isCompanyDriverGroup(g('WENZE UNIT # 008 ABDINASIR / IBRAHIM (COMPANY DRIVERS)')), true);
  assert.equal(isCompanyDriverGroup(g('WENZE UNIT # 2614 TERRELL DALTON (COMPANY DRIVER)')), true);
});

test('a title WITHOUT brackets is not dropped', () => {
  // The strict Board parser wants a parenthesised label; a Telegram title does
  // not have to have one. Requiring the strict form would silently drop this
  // group from every company broadcast — the exact failure this rule prevents.
  assert.equal(isCompanyDriverGroup(g('WENZE COMPANY DRIVERS 310 X')), true);
  assert.equal(isCompanyDriverGroup(g('WENZE COMPANY DRIVER 310 X')), true);
});

test('an unlabelled title is an owner operator and is not reached', () => {
  assert.equal(isCompanyDriverGroup(g('WENZE UNIT # 310 JAKHONGIR ABDUNABIEV')), false);
});

test('a lease group is not a company group', () => {
  assert.equal(isCompanyDriverGroup(g('WENZE UNIT # 771 A DRIVER (LEASE DRIVERS)')), false);
});

test('a recorded decision beats the chat name, in both directions', () => {
  // The ONE case that can newly exclude somebody — and the point of recording
  // a driver type at all.
  assert.equal(isCompanyDriverGroup(g('WENZE UNIT # 8 A (COMPANY DRIVERS)', 'owner')), false);
  assert.equal(isCompanyDriverGroup(g('WENZE UNIT # 8 A (COMPANY DRIVERS)', 'lease')), false);
  // And the one that can newly include somebody.
  assert.equal(isCompanyDriverGroup(g('WENZE UNIT # 310 X', 'company_driver')), true);
});

test('an unreadable column is not a decision, so the title still decides', () => {
  assert.equal(isCompanyDriverGroup(g('WENZE UNIT # 8 A (COMPANY DRIVERS)', 'contractor')), true);
  assert.equal(isCompanyDriverGroup(g('WENZE UNIT # 310 X', 'contractor')), false);
});

test('every group the OLD rule reached is still reached unless a person said otherwise', () => {
  // The floor, stated as a property rather than a list. `inferDriverType` is
  // the rule that shipped before this change.
  const { inferDriverType } = require('../lib/drivers/driverProfileParse');
  const titles = [
    'WENZE UNIT # 008 A / B (COMPANY DRIVERS)',
    'WENZE UNIT # 2614 T DALTON (COMPANY DRIVER)',
    'WENZE COMPANY DRIVERS 310 X',
    'WENZE UNIT # 310 JAKHONGIR',
    'WENZE UNIT # 771 A (LEASE DRIVERS)',
    'WENZE UNIT # 27 GOCHYYEV INACTIVE',
    'Employee Feedback (Admin)',
    'WENZE UNIT # 001A RALPH MICHEL',
  ];
  for (const title of titles) {
    const wasReached = inferDriverType(title) === 'company_driver';
    if (wasReached) {
      assert.equal(isCompanyDriverGroup(g(title)), true,
        `the old rule reached "${title}" and nobody decided otherwise`);
    }
  }
});
