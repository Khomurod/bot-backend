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
 * It is also the ONE place that resolves a group to a Samsara vehicle without
 * guessing, so it is where `groups.samsara_vehicle_id` finally gets a writer —
 * see `resolveVehicleLinks`.
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
const groups = require('../database/groups');
const { driverNamesMatch, extractDriverNameFromVehicleLabel } = require('../lib/drivers/driverGroupTitle');
const { withRunRecord } = require('./operations/runLedger');

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

/**
 * Which groups can be linked to a Samsara vehicle by ID, from this same scan. PURE.
 *
 * `groups.samsara_vehicle_id` has been in the schema, indexed, with a reader
 * (`getGroupBySamsaraId`) and a writer (`updateGroupSamsaraId`) — and **zero
 * callers of the writer**, so it is NULL on all 209 rows. Every cross-system
 * join therefore still resolves a driver by parsing a string out of a chat
 * title. This is what starts filling it, using a resolution the scan already
 * performs.
 *
 * A LINK IS ONLY WRITTEN WHEN IT IS NOT A GUESS. Four conditions, and the
 * second and the last are the ones that matter:
 *
 *   the unit resolves to exactly one vehicle (`ambiguous` is false — an
 *   ambiguous unit is already reported and must not be silently decided);
 *
 *   the vehicle label's driver name AGREES with the group's driver, or the
 *   label carries no name at all. A NAME MISMATCH LINKS NOTHING: that case is
 *   reported as `name_mismatch`, and writing the id anyway would cement the
 *   wrong truck against a driver in the one column meant to be authoritative.
 *   A group whose own driver is unknown counts as a mismatch against any NAMED
 *   vehicle — incomplete profile data must not become an authoritative link;
 *
 *   the vehicle has an id to store;
 *
 *   and no other group CLAIMS that vehicle — neither in this scan nor already
 *   in the database (see the comment on the exclusivity rule below).
 *
 * It also returns the CLEARS: a `vehicleId` of null for a group whose stored
 * link another group has demonstrably taken over. That is the only condition
 * under which a link is removed.
 *
 * Separate from `analyzeDuplicateUnits` rather than folded into it, so that
 * function keeps its single responsibility and its existing tests.
 *
 * @returns {Array<{groupId:number, vehicleId:string|null, previousVehicleId:string|null,
 *                  unitNumber:string|null, reason:string}>} — `vehicleId: null` is a clear
 */
function resolveVehicleLinks(rows, vehicles) {
  if (!Array.isArray(vehicles) || !vehicles.length) return [];

  const candidates = [];
  const stored = new Map();

  for (const row of Array.isArray(rows) ? rows : []) {
    const previous = row?.samsara_vehicle_id == null ? null : String(row.samsara_vehicle_id);
    if (previous) {
      if (!stored.has(previous)) stored.set(previous, []);
      stored.get(previous).push({ groupId: row.group_id, previousVehicleId: previous });
    }

    const unit = String(row?.unit_number || '').trim();
    if (!unit) continue;
    const driver = groupDriverName(row);
    const selection = samsara.selectVehicleByUnit(vehicles, unit, { driverNameHint: driver });
    if (selection.ambiguous || !selection.vehicle) continue;

    const vehicleId = selection.vehicle.id ?? selection.vehicle.vehicleId ?? null;
    if (vehicleId == null || vehicleId === '') continue;

    // A NAMED VEHICLE NEEDS A GROUP DRIVER TO AGREE WITH. An active profile can
    // carry a unit number and no name at all, and treating that as "nothing to
    // disagree with" turns incomplete profile data into an authoritative wrong
    // link. `driverNamesMatch` is false against an empty name, which is the
    // answer wanted: only a genuinely NAMELESS label is eligible here.
    const providerDriver = extractDriverNameFromVehicleLabel(selection.vehicle.name, unit);
    if (providerDriver && !driverNamesMatch(driver, providerDriver)) continue;

    candidates.push({
      groupId: row.group_id,
      vehicleId: String(vehicleId),
      previousVehicleId: previous,
      unitNumber: unit,
      reason: selection.reason,
    });
  }

  // THE EXCLUSIVITY RULE, and it has to count the claims already in the
  // database — not just the ones this scan proposes.
  //
  // Two active groups sharing unit 001 can both resolve to the same vehicle:
  // `selectVehicleByUnit` is called once per group and neither call knows about
  // the other. That is the duplicate-unit problem wearing a different hat, and
  // `getGroupBySamsaraId` would answer it with `LIMIT 1` — an arbitrary driver,
  // silently. So a vehicle claimed by more than one group links to none of
  // them, and the existing `duplicate_unit` report is left to say why.
  //
  // A STORED LINK IS THE SAME KIND OF CLAIM, and it outlives the scan that made
  // it. When unit 305 moves from one group to another, the old group keeps
  // holding v-305 and simply stops resolving to it — so counting candidates
  // alone would let the new group take v-305 while the old one still holds it,
  // producing exactly the duplicate the rule above exists to prevent.
  const groupsPerVehicle = new Map();
  const vehiclesPerGroup = new Map();
  for (const c of candidates) {
    groupsPerVehicle.set(c.vehicleId, (groupsPerVehicle.get(c.vehicleId) || 0) + 1);
    vehiclesPerGroup.set(c.groupId, (vehiclesPerGroup.get(c.groupId) || 0) + 1);
  }

  const writes = [];
  /** groupId → the vehicle it lost. Keyed by both, so a coincidence cannot clear. */
  const handedOver = new Map();

  for (const c of candidates) {
    if (groupsPerVehicle.get(c.vehicleId) !== 1) continue;
    if (vehiclesPerGroup.get(c.groupId) !== 1) continue;

    // Whoever else is still holding this vehicle has demonstrably lost it: this
    // group resolves to it, uniquely, from the provider's own data. Decided
    // BEFORE the no-op check below, because a group that is already correctly
    // linked is the strongest evidence there is that a second holder is stale —
    // and skipping straight past it is how a duplicate already in the database
    // survives every future scan.
    for (const holder of stored.get(c.vehicleId) || []) {
      if (holder.groupId === c.groupId) continue;
      handedOver.set(holder.groupId, c.vehicleId);
    }

    // Already linked to this vehicle — writing it again every fifteen minutes
    // would be 209 pointless UPDATEs an hour.
    if (c.previousVehicleId === c.vehicleId) continue;
    writes.push(c);
  }

  // A LINK IS ONLY CLEARED WHEN THE VEHICLE DEMONSTRABLY MOVED, never merely
  // because a group stopped resolving. An ambiguous scan, a half-answered
  // Samsara page or a title somebody is mid-way through editing all look like
  // "no resolution", and clearing on absence of evidence would flap the column
  // every fifteen minutes. A unique stale link is at worst the status quo — the
  // string parse it replaced would have reached the same group.
  const written = new Set(writes.map((w) => w.groupId));
  for (const [vehicleId, holders] of stored) {
    for (const holder of holders) {
      if (handedOver.get(holder.groupId) !== vehicleId || written.has(holder.groupId)) continue;
      writes.push({
        groupId: holder.groupId,
        vehicleId: null,
        previousVehicleId: vehicleId,
        unitNumber: null,
        reason: 'handed_over',
      });
      written.add(holder.groupId);
    }
  }

  return writes;
}

/**
 * Write the links this scan resolved. Failures are per-row and never abort the
 * scan: an unlinked group is the status quo, and the reports are the point.
 *
 * CLEARS GO FIRST. A clear and the write that caused it are two halves of one
 * handover, and doing them in the other order leaves both groups holding the
 * same vehicle for as long as it takes — which is precisely the state
 * `getGroupBySamsaraId`'s `LIMIT 1` answers arbitrarily. If the second half then
 * fails, a cleared link is the safe half to be left with: NULL falls back to the
 * string parse that has always run, while a duplicate is believed.
 */
async function writeVehicleLinks(links) {
  let linked = 0;
  let relinked = 0;
  let cleared = 0;
  const ordered = [...links].sort((a, b) => (a.vehicleId === null ? -1 : 0) - (b.vehicleId === null ? -1 : 0));

  for (const link of ordered) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await groups.updateGroupSamsaraId(link.groupId, link.vehicleId);
      if (link.vehicleId === null) cleared += 1;
      else if (link.previousVehicleId) relinked += 1;
      else linked += 1;
    } catch (err) {
      console.error(`[DUP-UNIT] Failed to update group ${link.groupId}'s Samsara link:`, err.message);
    }
  }
  return { linked, relinked, cleared };
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

  const { linked, relinked, cleared } = vehicles
    ? await writeVehicleLinks(resolveVehicleLinks(rows, vehicles))
    : { linked: 0, relinked: 0, cleared: 0 };

  const summary = {
    scanned: rows.length,
    checkedProvider: Boolean(vehicles),
    duplicateUnits: reports.filter((r) => r.reportType === 'duplicate_unit').length,
    nameMismatches: reports.filter((r) => r.reportType === 'name_mismatch').length,
    ambiguous: reports.filter((r) => r.reportType === 'ambiguous_match').length,
    resolved,
    linked,
    relinked,
    cleared,
  };
  if (reports.length || resolved || linked || relinked || cleared) {
    console.log(`[DUP-UNIT] Scan: ${summary.scanned} units, `
      + `${summary.duplicateUnits} duplicate, ${summary.nameMismatches} name-mismatch, `
      + `${summary.ambiguous} ambiguous; ${resolved} cleared; `
      + `${linked} vehicle links written, ${relinked} re-pointed, ${cleared} handed over.`);
  }
  return summary;
}

async function tick() {
  // No-overlap guard — skip while a previous run is still active (also keeps the
  // check from piling up if the app is momentarily overloaded).
  if (tickRunning) return;
  tickRunning = true;
  try {
    await withRunRecord('duplicate_unit_scan', () => runDuplicateUnitCheck());
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
  resolveVehicleLinks,
  writeVehicleLinks,
  analyzeDuplicateUnits,
  runDuplicateUnitCheck,
  startDuplicateUnitCheckService,
  stopDuplicateUnitCheckService,
  tick,
};
