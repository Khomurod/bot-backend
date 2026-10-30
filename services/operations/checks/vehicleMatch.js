'use strict';

/**
 * Samsara's truck and the driver group disagree about WHO drives it.
 *
 * The duplicate-unit scan (`services/duplicateUnitCheckService.js`, every 15
 * minutes) is the only code that compares a group's driver with the driver name
 * on the Samsara vehicle label, and it files two kinds of report into
 * `duplicate_unit_reports`:
 *
 *   name_mismatch    the Samsara vehicle for this unit lists a different driver
 *                    than the group's driver;
 *   ambiguous_match  several Samsara vehicles share the unit number and none
 *                    clearly belongs to the group's driver — the serious case,
 *                    because Live Locations and safety alerts cannot tell which
 *                    truck is this driver's.
 *
 * Until October 2026 those reports were visible only through three
 * `/api/live-locations/duplicate-reports*` routes no screen called (the
 * hidden-functions audit). This check puts each OPEN report on Needs Attention,
 * where a person sees it. The scan stays the judge: it resolves a report once
 * the names agree, and the finding then resolves on the next sweep. A DISMISSAL
 * IS NOT THE OLD "RESOLVE": that one was undone by the next scan still seeing
 * the problem, while a dismissed finding stays dismissed for that unit even if
 * the mismatch clears and comes back (the engine reopens only resolved
 * findings) — so "not now" is Snooze, and dismissing means "known, for good". The plain duplicate_unit report is not repeated here:
 * `identity.duplicate_unit` already files that, fleet-aware.
 *
 * Nothing here is auto-correctable: only a person knows which truck a driver is
 * in, and the fix is in Samsara or the driver profile, not in this app's data.
 */

const CHECK_KEYS = ['samsara.driver_name_mismatch', 'samsara.ambiguous_unit_match'];

/** The loader's ceiling: a read this full is a partial picture, never "all clear". */
const MAX_REPORTS = 500;

const KEY_BY_TYPE = {
  name_mismatch: 'samsara.driver_name_mismatch',
  ambiguous_match: 'samsara.ambiguous_unit_match',
};

function runVehicleMatchChecks(snapshot) {
  const reports = snapshot?.vehicleMatchReports;
  // A READ THAT FAILED IS NOT "NOTHING WRONG". Throwing keeps these keys out of
  // resolution, so an outage never clears the board.
  if (!Array.isArray(reports)) throw new Error('Samsara driver-match reports could not be read');
  if (reports.length >= MAX_REPORTS) {
    throw new Error(`${reports.length} Samsara driver-match reports is at the read ceiling — the picture is partial`);
  }

  const findings = [];
  for (const r of reports) {
    const checkKey = KEY_BY_TYPE[r.report_type];
    if (!checkKey) continue;
    const unit = r.unit_number;
    const groups = (r.group_ids || []).map((id, i) => ({ groupId: id, groupName: (r.group_names || [])[i] || null }));
    const title = checkKey === 'samsara.driver_name_mismatch'
      ? `Unit ${unit}: Samsara lists ${r.provider_driver_name || 'another driver'}, the group has ${r.group_driver_name || 'no driver name'}`
      : `Unit ${unit}: several Samsara vehicles, none clearly this driver's`;
    findings.push({
      checkKey,
      subjectType: 'unit',
      subjectId: String(unit),
      title,
      severity: r.severity === 'serious' ? 'serious' : 'warning',
      tier: 'warning',
      evidence: {
        unitNumber: unit,
        groupDriverName: r.group_driver_name || null,
        samsaraDriverName: r.provider_driver_name || null,
        groups,
        detail: r.detail || null,
        scanFirstSeenAt: r.first_seen_at || null,
        scanLastSeenAt: r.last_seen_at || null,
        note: checkKey === 'samsara.driver_name_mismatch'
          ? 'Fix the driver on the Samsara vehicle or on the driver profile; the next scan '
            + 'clears this once the names agree.'
          : 'Until one Samsara vehicle clearly belongs to this driver, Live Locations and '
            + 'safety alerts cannot tell which truck is theirs. Fix the unit number or the '
            + 'driver name in Samsara.',
      },
    });
  }
  return findings;
}

module.exports = { CHECK_KEYS, MAX_REPORTS, runVehicleMatchChecks };
