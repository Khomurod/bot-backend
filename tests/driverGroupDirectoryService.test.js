const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildCanonicalDriverGroups,
} = require('../services/driverGroupDirectoryService');

test('canonical projection suppresses inactive duplicates when one active match exists', () => {
  const rows = buildCanonicalDriverGroups([
    {
      group_id: 7,
      group_name: 'WENZE UNIT # 07 EL HADJI THIAM (COMPANY DRIVER)',
      group_type: 'driver',
      group_active: true,
      status_source: 'bot',
      first_name: 'EL',
      last_name: 'HADJI THIAM',
      driver_type: 'company_driver',
      profile_status: 'active',
      unit_number: '07',
    },
    {
      group_id: 8,
      group_name: 'WENZE UNIT # 008 EL HADJI THIAM (COMPANY DRIVER) INACTIVE',
      group_type: 'driver',
      group_active: false,
      status_source: 'ai',
      first_name: 'EL',
      last_name: 'HADJI THIAM',
      driver_type: 'company_driver',
      profile_status: 'inactive',
      unit_number: '008',
    },
  ], { operational: true });

  const active = rows.find((row) => row.group_id === 7);
  const inactive = rows.find((row) => row.group_id === 8);

  assert.equal(active.operational_visible, true);
  assert.equal(active.canonical_group_id, 7);
  assert.equal(active.duplicate_resolution, 'active_wins');
  assert.equal(inactive.operational_visible, false);
  assert.equal(inactive.suppressed_duplicate, true);
  assert.equal(inactive.canonical_group_id, 7);
});

test('canonical projection keeps multiple active duplicates visible and flags review', () => {
  const rows = buildCanonicalDriverGroups([
    {
      group_id: 101,
      group_name: 'WENZE UNIT # 1 ABDINASIR / IBRAHIM (COMPANY DRIVERS)',
      group_type: 'driver',
      group_active: true,
      first_name: 'ABDINASIR',
      secondary_first_name: 'IBRAHIM',
      driver_type: 'company_driver',
      profile_status: 'active',
      unit_number: '1',
    },
    {
      group_id: 102,
      group_name: 'WENZE UNIT # 2 ABDINASIR / IBRAHIM (COMPANY DRIVERS)',
      group_type: 'driver',
      group_active: true,
      first_name: 'ABDINASIR',
      secondary_first_name: 'IBRAHIM',
      driver_type: 'company_driver',
      profile_status: 'active',
      unit_number: '2',
    },
  ], { operational: true });

  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.operational_visible, true);
    assert.equal(row.duplicate_conflict, true);
    assert.equal(row.duplicate_review_required, true);
    assert.equal(row.duplicate_resolution, 'multiple_active_conflict');
  }
});

test('canonical projection builds consistent team-driver display names', () => {
  const [row] = buildCanonicalDriverGroups([
    {
      group_id: 201,
      group_name: 'WENZE UNIT # 1 RUDOLPH FREDERIC / JOHN ELISEE',
      group_type: 'driver',
      group_active: true,
      first_name: 'RUDOLPH',
      last_name: 'FREDERIC',
      secondary_first_name: 'JOHN',
      secondary_last_name: 'ELISEE',
      driver_type: 'owner',
      profile_status: 'active',
      unit_number: '1',
    },
  ]);

  assert.equal(row.display_name, 'RUDOLPH FREDERIC / JOHN ELISEE');
  assert.equal(row.normalized_driver_key, 'john elisee|rudolph frederic');
});
