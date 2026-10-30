/**
 * Samsara driver-match reports on Needs Attention (checks/vehicleMatch.js).
 *
 * The duplicate-unit scan files name_mismatch and ambiguous_match reports into
 * duplicate_unit_reports; until the October 2026 audit only three admin routes
 * no screen called could list them. The sweep now turns each OPEN one into a
 * finding. What has to hold:
 *   - one finding per report, keyed by unit, with the names a person needs;
 *   - the plain duplicate_unit report is NOT repeated (identity.duplicate_unit
 *     already files it, fleet-aware);
 *   - a failed or full read throws, so the sweep never resolves these findings
 *     on a partial picture.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { CHECK_KEYS, MAX_REPORTS, runVehicleMatchChecks } = require('../services/operations/checks/vehicleMatch');

const report = (over) => ({
  id: 1, unit_number: '101', report_type: 'name_mismatch', group_ids: [7], group_names: ['UNIT 101 JOHN CARTER'],
  group_driver_name: 'John Carter', provider_driver_name: 'Sam Wilson', detail: 'Unit 101: group driver "John Carter" but the Samsara vehicle label lists "Sam Wilson".',
  severity: 'warning', first_seen_at: '2026-10-01T00:00:00Z', last_seen_at: '2026-10-30T00:00:00Z', ...over,
});

test('a name mismatch becomes one warning finding that names both drivers and the group', () => {
  const [f] = runVehicleMatchChecks({ vehicleMatchReports: [report()] });
  assert.equal(f.checkKey, 'samsara.driver_name_mismatch');
  assert.equal(f.subjectType, 'unit');
  assert.equal(f.subjectId, '101');
  assert.equal(f.title, 'Unit 101: Samsara lists Sam Wilson, the group has John Carter');
  assert.equal(f.severity, 'warning');
  assert.equal(f.tier, 'warning');
  assert.deepEqual(f.evidence.groups, [{ groupId: 7, groupName: 'UNIT 101 JOHN CARTER' }]);
  assert.equal(f.evidence.samsaraDriverName, 'Sam Wilson');
  assert.equal(f.proposedChange, undefined, 'nothing here is auto-correctable');
});

test('an ambiguous match keeps its serious severity; a plain duplicate and an unknown type are not filed', () => {
  const findings = runVehicleMatchChecks({ vehicleMatchReports: [
    report({ id: 2, unit_number: '202', report_type: 'ambiguous_match', provider_driver_name: null, severity: 'serious' }),
    report({ id: 3, unit_number: '303', report_type: 'duplicate_unit' }),
    report({ id: 4, unit_number: '404', report_type: 'something_new' }),
  ] });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].checkKey, 'samsara.ambiguous_unit_match');
  assert.equal(findings[0].severity, 'serious');
  assert.equal(findings[0].title, "Unit 202: several Samsara vehicles, none clearly this driver's");
});

test('a failed read or a read at the ceiling throws, so nothing is resolved on a partial picture', () => {
  assert.throws(() => runVehicleMatchChecks({ vehicleMatchReports: null }), /could not be read/);
  const full = Array.from({ length: MAX_REPORTS }, (_, i) => report({ id: i, unit_number: String(i) }));
  assert.throws(() => runVehicleMatchChecks({ vehicleMatchReports: full }), /read ceiling/);
  assert.deepEqual(runVehicleMatchChecks({ vehicleMatchReports: [] }), []);
});

test('the sweep runs this check: its keys are registered and labelled for the admin page', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const sweep = fs.readFileSync(path.join(__dirname, '../services/operations/consistencyService.js'), 'utf8');
  assert.match(sweep, /vehicleMatch\.runVehicleMatchChecks/);
  const labels = fs.readFileSync(path.join(__dirname, '../admin/src/pages/operations/labels.js'), 'utf8');
  for (const key of CHECK_KEYS) assert.ok(labels.includes(`'${key}'`), `${key} has a plain-language label`);
});
