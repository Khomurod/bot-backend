'use strict';

/**
 * The daily Board ↔ Wenze ↔ Datatruck check, run inside the sweep. PURE over
 * the snapshot — no I/O here.
 *
 * The board and Wenze are read live with the rest of the snapshot; Datatruck is
 * the day's read held in memory (`services/fleetCrossCheck/daily.js`), so the
 * sweep never asks Datatruck anything. When a person fixes Wenze or the
 * dispatcher fixes the board, the next sweep sees it and resolves the finding;
 * a Datatruck that changes is seen at the next daily read.
 *
 * REFUSES TO RUN WITHOUT DATATRUCK. With no day's read (not yet read after a
 * restart, not connected, failed for two days) every one of its findings would
 * vanish — three sources down to two, and "nothing to ask" read as "they
 * agree". So it throws, and the sweep leaves its keys' open findings where they
 * are (`consistencyService.js`), the same rule `checks/engineering.js` and
 * `checks/roadBonus.js` follow on an unreadable source. It also stands down on
 * an unreadable board.
 *
 * What it files, and why each needs two sources: `lib/fleetCrossCheck/findings.js`.
 */
const { compareFleet } = require('../../../lib/fleetCrossCheck/compare');
const { CHECK_KEYS, crossCheckFindings } = require('../../../lib/fleetCrossCheck/findings');

/** Wenze's open truck records with the person and the chat — `report.js` `readWenze`, from the snapshot. */
function wenzeFromSnapshot({
  units = [], people = [], personGroups = [], groups = [], profiles = [],
}) {
  const nameOf = new Map(people.map((p) => [p.id, p.display_name]));
  const activeGroup = new Map(groups.filter((g) => g.active === true).map((g) => [g.id, g]));
  const chatOf = new Map();
  for (const a of [...personGroups].sort((x, y) => Number(x.group_id) - Number(y.group_id))) {
    if (activeGroup.has(a.group_id) && !chatOf.has(a.person_id)) chatOf.set(a.person_id, a.group_id);
  }
  const profileOf = new Map(profiles.map((p) => [p.group_id, p]));
  return units.map((u) => {
    const groupId = chatOf.get(u.person_id) ?? null;
    return {
      unitNumber: u.unit_number,
      fleetType: u.fleet_type || 'unknown',
      truckOwner: u.truck_owner || null,
      displayName: nameOf.get(u.person_id) || '',
      groupId,
      groupName: groupId ? activeGroup.get(groupId)?.group_name || null : null,
      driverType: groupId ? profileOf.get(groupId)?.driver_type || null : null,
    };
  });
}

function boardFromSnapshot(boardRows) {
  return boardRows.map((r) => ({
    truckRaw: r.truck_raw,
    truckNorm: r.truck_norm,
    fleetType: r.fleet_type || 'unknown',
    fleetLabelRaw: r.fleet_label_raw ?? null,
    driverName: r.driver_name_clean,
    teamMembers: Array.isArray(r.team_members) ? r.team_members : null,
    status: r.status || null,
  }));
}

function runFleetCrossCheckChecks(snapshot) {
  const dt = snapshot.datatruckFleet;
  if (!dt || !Array.isArray(dt.orders) || !Array.isArray(dt.drivers)) {
    throw new Error('Datatruck has not been read today — the board ↔ Wenze ↔ Datatruck check stands down');
  }
  if (!Array.isArray(snapshot.boardRows)) throw new Error('the Dispatcher Board could not be read');
  const wenze = wenzeFromSnapshot(snapshot);
  const { rows } = compareFleet({
    board: boardFromSnapshot(snapshot.boardRows),
    wenze,
    datatruckOrders: dt.orders,
    datatruckDrivers: dt.drivers,
  });
  return crossCheckFindings({ rows, wenze, orders: dt.orders })
    .map((f) => ({ ...f, evidence: { ...f.evidence, datatruckReadAt: dt.readAt || null } }));
}

module.exports = { CHECK_KEYS: [...CHECK_KEYS], runFleetCrossCheckChecks, wenzeFromSnapshot };
