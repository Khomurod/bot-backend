const test = require('node:test');
const assert = require('node:assert/strict');

// Minimal env so requiring the service (→ db pool, eldSettings → crypto/config)
// does not exit. No DB/network is touched by analyzeDuplicateUnits itself.
process.env.DATABASE_URL ||= 'postgresql://user:password@localhost:5432/test';
process.env.BOT_TOKEN ||= 'test';
process.env.TELEGRAM_BOT_TOKEN ||= 'test';
process.env.JWT_SECRET ||= 'test';
process.env.FACEBOOK_TOKEN_ENCRYPTION_KEY ||= '0123456789abcdef0123456789abcdef';

const { analyzeDuplicateUnits } = require('../services/duplicateUnitCheckService');

function row(groupId, unit, first, last) {
  return {
    group_id: groupId, group_name: `WENZE UNIT # ${unit} ${first} ${last}`,
    unit_number: unit, first_name: first, last_name: last,
  };
}

test('no duplicates and no provider data → no reports', () => {
  const rows = [row(1, '100', 'John', 'Doe'), row(2, '200', 'Jane', 'Roe')];
  assert.deepEqual(analyzeDuplicateUnits(rows, null), []);
});

test('same unit number on two active groups → a duplicate_unit report', () => {
  const rows = [row(1, '100', 'John', 'Doe'), row(2, '100', 'Mike', 'Smith')];
  const reports = analyzeDuplicateUnits(rows, null);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].reportType, 'duplicate_unit');
  assert.equal(reports[0].unitNumber, '100');
  assert.deepEqual(reports[0].groupIds.sort(), [1, 2]);
  assert.equal(reports[0].severity, 'warning');
});

test('provider label lists a different driver → a name_mismatch report', () => {
  const rows = [row(1, '200', 'John', 'Doe')];
  const vehicles = [{ id: 'v', name: '200 JANE ROE', gps: { time: '2026-05-01T00:00:00Z' } }];
  const reports = analyzeDuplicateUnits(rows, vehicles);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].reportType, 'name_mismatch');
  assert.equal(reports[0].groupDriverName, 'John Doe');
  assert.equal(reports[0].providerDriverName, 'JANE ROE');
});

test('matching driver name → no report', () => {
  const rows = [row(1, '400', 'Maria', 'Lopez')];
  const vehicles = [{ id: 'v', name: '400 MARIA LOPEZ', gps: { time: '2026-05-01T00:00:00Z' } }];
  assert.deepEqual(analyzeDuplicateUnits(rows, vehicles), []);
});

test('duplicate provider vehicles with no confident match → a serious ambiguous_match report', () => {
  const rows = [row(1, '300', 'Someone', 'Else')];
  const vehicles = [
    { id: 'a', name: '300 NIKE AUGUSTE', gps: { time: '2026-05-01T00:00:00Z' } },
    { id: 'b', name: '300 TESFAMARIAM YOSIEF', gps: { time: '2026-05-01T01:00:00Z' } },
  ];
  const reports = analyzeDuplicateUnits(rows, vehicles);
  const ambiguous = reports.find((r) => r.reportType === 'ambiguous_match');
  assert.ok(ambiguous, 'expected an ambiguous_match report');
  assert.equal(ambiguous.severity, 'serious');
  assert.equal(ambiguous.unitNumber, '300');
});

test('same-driver duplicate provider entries (stale+fresh) are NOT a mismatch', () => {
  const rows = [row(1, '500', 'Prodnet', 'Lubin')];
  const vehicles = [
    { id: 'old', name: '500 PRODNET LUBIN', gps: { time: '2026-05-01T00:00:00Z' } },
    { id: 'new', name: '500 PRODNET LUBIN', gps: { time: '2026-05-01T02:00:00Z' } },
  ];
  assert.deepEqual(analyzeDuplicateUnits(rows, vehicles), []);
});
