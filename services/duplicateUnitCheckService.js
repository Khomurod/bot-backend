/**
 * Duplicate truck-number sanity check.
 *
 * Every 15 minutes (and never overlapping a previous run) this scans the ACTIVE
 * driver groups for:
 *   - duplicate_unit  — the same unit number on more than one active driver group
 *   - name_mismatch   — the Samsara vehicle matched to a unit lists a DIFFERENT
 *                       driver than that group's driver
 *   - ambiguous_match — a duplicate unit where Samsara has several vehicles and
 *                       none clearly matches the group's driver (the serious case)
 *
 * The driver group's driver name is the source of truth. Findings are stored in
 * duplicate_unit_reports for admin review — this service deliberately NEVER
 * messages driver groups (no spam); the /location command surfaces ambiguity to
 * dispatchers in real time instead.
 *
 * Samsara is fetched ONCE per run (batched, rate-limit friendly); when Samsara
 * is unavailable the provider name checks are skipped (and their prior reports
 * are left untouched rather than falsely resolved).
 *
 * `analyzeDuplicateUnits` is pure (no DB / network) and unit-tested.
 */
const dup = require('../database/duplicateUnitReports');
const { getEldConfig } = require('../database/eldSettings');
const samsara = require('./samsaraLocationService');
const { driverNamesMatch, extractDriverNameFromVehicleLabel } = require('./driverGroupTitle');

const POLL_MS = 15 * 60 * 1000;
const FIRST_TICK_DELAY_MS = 90 * 1000;

let serviceTimer = null;
let serviceStopped = false;
let tickRunning = false;

function groupDriverName(row) {
  return [row?.first_name, row?.last_name].filter(Boolean).join(' ').trim();
}

/**
 * PURE. Given active driver-unit rows and (optionally) the Samsara vehicle list,
 * return the report objects that should be recorded.
 *
 * @param {Array} rows  { group_id, group_name, unit_number, first_name, last_name }
 * @param {Array|null} vehicles  Samsara vehicle stats, or null when unavailable
 * @returns {Array<object>} report objects for upsertDuplicateUnitReport
 */
function analyzeDuplicateUnits(rows, vehicles) {
  const byUnit = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const norm = samsara.normalizeUnitNumber(row.unit_number);
    if (!norm) continue;
    if (!byUnit.has(norm)) byUnit.set(norm, []);
    byUnit.get(norm).push(row);
  }

  const haveVehicles = Array.isArray(vehicles) && vehicles.length > 0;
  const reports = [];

  for (const [unit, groupRows] of byUnit) {
    // 1) Same unit number on more than one active driver group.
    if (groupRows.length > 1) {
      reports.push({
        unitNumber: unit,
        reportType: 'duplicate_unit',
        groupIds: groupRows.map((r) => r.group_id),
        groupNames: groupRows.map((r) => r.group_name || `Group ${r.group_id}`),
        groupDriverName: null,
        detail: `Unit ${unit} is on ${groupRows.length} active driver groups: `
          + `${groupRows.map((r) => r.group_name || `Group ${r.group_id}`).join(' | ')}.`,
        severity: 'warning',
      });
    }

    if (!haveVehicles) continue;

    // 2) Provider driver-name checks against the group's driver (source of truth).
    for (const row of groupRows) {
      const driver = groupDriverName(row);
      if (!driver) continue;
      const selection = samsara.selectVehicleByUnit(vehicles, unit, { driverNameHint: driver });

      if (selection.ambiguous) {
        const candidates = selection.candidates.map((v) => v?.name).filter(Boolean);
        reports.push({
          unitNumber: unit,
          reportType: 'ambiguous_match',
          groupIds: [row.group_id],
          groupNames: [row.group_name || `Group ${row.group_id}`],
          groupDriverName: driver,
          provider: 'samsara',
          providerDriverName: null,
          detail: `Unit ${unit}: ${selection.candidates.length} Samsara vehicles share this unit and none `
            + `clearly matches "${driver}". Candidates: ${candidates.join(' | ')}.`,
          severity: 'serious',
        });
        continue;
      }

      if (selection.vehicle) {
        const providerDriver = extractDriverNameFromVehicleLabel(selection.vehicle.name, unit);
        if (providerDriver && !driverNamesMatch(driver, providerDriver)) {
          reports.push({
            unitNumber: unit,
            reportType: 'name_mismatch',
            groupIds: [row.group_id],
            groupNames: [row.group_name || `Group ${row.group_id}`],
            groupDriverName: driver,
            provider: 'samsara',
            providerDriverName: providerDriver,
            detail: `Unit ${unit}: group driver "${driver}" but the Samsara vehicle label lists `
              + `"${providerDriver}".`,
            severity: 'warning',
          });
        }
      }
    }
  }

  return reports;
}

/** One full scan. Never messages driver groups — records reports only. */
async function runDuplicateUnitCheck() {
  const rows = await dup.listActiveDriverUnits();

  let vehicles = null;
  try {
    const cfg = await getEldConfig();
    if (cfg.samsaraEnabled && cfg.samsaraApiKeys.length) {
      vehicles = await samsara.fetchAllVehicleStats({
        apiKey: cfg.samsaraApiKeys[0],
        apiBase: cfg.samsaraApiBase,
      });
    }
  } catch (err) {
    console.warn('[DUP-UNIT] Samsara fetch failed — provider name checks skipped:', err.message);
    vehicles = null;
  }

  const reports = analyzeDuplicateUnits(rows, vehicles);
  const keepIds = [];
  for (const report of reports) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const saved = await dup.upsertDuplicateUnitReport(report);
      if (saved) keepIds.push(saved.id);
    } catch (err) {
      console.error(`[DUP-UNIT] Failed to store report for unit ${report.unitNumber}:`, err.message);
    }
  }

  // Only auto-resolve the types we actually evaluated this run.
  const evaluatedTypes = vehicles
    ? ['duplicate_unit', 'name_mismatch', 'ambiguous_match']
    : ['duplicate_unit'];
  const resolved = await dup.resolveStaleReports(keepIds, evaluatedTypes);

  const summary = {
    scanned: rows.length,
    checkedProvider: Boolean(vehicles),
    duplicateUnits: reports.filter((r) => r.reportType === 'duplicate_unit').length,
    nameMismatches: reports.filter((r) => r.reportType === 'name_mismatch').length,
    ambiguous: reports.filter((r) => r.reportType === 'ambiguous_match').length,
    resolved,
  };
  if (reports.length || resolved) {
    console.log(`[DUP-UNIT] Scan: ${summary.scanned} units, `
      + `${summary.duplicateUnits} duplicate, ${summary.nameMismatches} name-mismatch, `
      + `${summary.ambiguous} ambiguous; ${resolved} cleared.`);
  }
  return summary;
}

async function tick() {
  // No-overlap guard — skip while a previous run is still active (also keeps the
  // check from piling up if the app is momentarily overloaded).
  if (tickRunning) return;
  tickRunning = true;
  try {
    await runDuplicateUnitCheck();
  } catch (err) {
    console.error('[DUP-UNIT] Scan error:', err.message);
  } finally {
    tickRunning = false;
  }
}

function startDuplicateUnitCheckService() {
  serviceStopped = false;
  console.log(`[DUP-UNIT] Service started — duplicate unit sanity check every ${POLL_MS / 60000}min`);
  setTimeout(() => { if (!serviceStopped) tick(); }, FIRST_TICK_DELAY_MS).unref?.();
  serviceTimer = setInterval(() => { if (!serviceStopped) tick(); }, POLL_MS);
  serviceTimer.unref?.();
}

function stopDuplicateUnitCheckService() {
  serviceStopped = true;
  if (serviceTimer) {
    clearInterval(serviceTimer);
    serviceTimer = null;
  }
}

module.exports = {
  analyzeDuplicateUnits,
  runDuplicateUnitCheck,
  startDuplicateUnitCheckService,
  stopDuplicateUnitCheckService,
  tick,
};
