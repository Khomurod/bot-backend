'use strict';

/**
 * Three sources, one truck at a time: the Dispatcher Board, Wenze and
 * Datatruck. PURE — the reads are `services/fleetCrossCheck/report.js`.
 *
 * WHY THREE. Two sources that disagree say only that one of them is wrong. A
 * third says which: when the board and Datatruck agree and Wenze does not,
 * Wenze's record is the stale one (the owner's request of 5 November 2026,
 * after eleven trucks turned out to carry an old fleet in Wenze and seven board
 * trucks were not in Wenze at all).
 *
 * A TRUCK IS (FLEET, NUMBER) — `docs/architecture/fleet-type-and-unit-identity.md`.
 * Company 313 and Owner-operator 313 are two trucks with two drivers, so every
 * comparison is keyed on both. Datatruck's truck label is written the board's
 * way ("771 JAFAR"), so it is read by the same rule (`lib/board/truckSuffix.js`).
 *
 * THIS ONLY REPORTS. Nothing here decides what is right; it says what each
 * source holds and where they part. Acting on it is a person's call.
 */
const { readBoardTruck, describeTruckSuffix } = require('../board/truckSuffix');
const { namesAgreeStrictly } = require('../identity/boardResolution');
const { namesLikelySame } = require('../drivers/nameTolerance');

/**
 * Datatruck's driver type → the DRIVER's type in Wenze's profile vocabulary
 * (`owner` / `company_driver` / `lease`). It describes the driver, not the
 * truck: `company_owner` is a driver who owns or co-owns the truck he drives
 * (an owner-operator, or a vendor or investor at his own wheel); a driver hired
 * by an owner is `company_driver` (5 November 2026: "by the truck an
 * owner-operator, by the driver a company driver"). The truck's fleet comes
 * from the board's suffix only. An unknown word is shown, never guessed.
 */
const DATATRUCK_TYPE_TO_DRIVER_TYPE = Object.freeze({
  company_driver: 'company_driver',
  company_owner: 'owner',
  owner_operator: 'owner',
  owner: 'owner',
  lease_operator: 'lease',
  lease_driver: 'lease',
  lease: 'lease',
});

function driverTypeFromDatatruck(type) {
  return DATATRUCK_TYPE_TO_DRIVER_TYPE[String(type || '').trim().toLowerCase()] || null;
}

/** A board status under which "no load this week" is expected, not a disagreement. */
const NOT_WORKING_STATUSES = Object.freeze(['HOME', 'VACATION', 'SHOP', 'REST']);
const notWorking = (status) => NOT_WORKING_STATUSES.includes(String(status || '').trim().toUpperCase().replace(/\s+/g, ' '));

const unitKey = (unit) => String(unit || '').trim().toUpperCase();
const key = (fleet, unit) => `${fleet || 'unknown'}|${unitKey(unit)}`;

/**
 * A truck label as one key: the unit and its suffix, written the same way on
 * both sides — CPM is CMP, brackets dropped. "1 ERNST", "1 ROGER" and
 * "1 RUDOLPH" are three trucks: the name after the number is the truck's OWNER
 * (owner, 5 November 2026), so a named label is matched whole, never by number.
 */
function labelKey(label) {
  const truck = readBoardTruck(label);
  if (!truck.unit) return null;
  const suffix = String(truck.suffix || '').replace(/[()[\]]/g, ' ').trim().replace(/\s+/g, ' ').toUpperCase();
  return `${unitKey(truck.unit)}|${suffix === 'CPM' ? 'CMP' : suffix}`;
}

/** True when the label's suffix names an owner rather than a fleet word. */
const namedOwner = (label) => {
  const truck = readBoardTruck(label);
  return Boolean(truck.suffix) && describeTruckSuffix(truck.suffix).detail === 'own_truck';
};

const tokens = (name) => String(name || '').toUpperCase().replace(/[^A-Z\s]/g, ' ').split(/\s+/).filter(Boolean);

/**
 * The spellings of one name with the spaces moved: "MC LEAN" and "MCLEAN",
 * in any word order. Each adjacent pair may be written as one word.
 */
function joinedForms(name) {
  const t = tokens(name);
  const forms = new Set([[...t].sort().join('')]);
  for (let i = 0; i < t.length - 1; i += 1) {
    const merged = [...t.slice(0, i), t[i] + t[i + 1], ...t.slice(i + 2)];
    forms.add(merged.sort().join(''));
  }
  return forms;
}

/**
 * How close two names are: the board's strict rule first ("same" — what a
 * match may act on), then the tolerant ones ("close" — a person should look:
 * a one-letter typo, "LATRAVIA MC LEAN" against "MCLEAN LATRAVIA").
 */
function nameAgreement(a, b) {
  if (!a || !b) return null;
  if (namesAgreeStrictly(a, b)) return 'same';
  if (namesLikelySame(a, b)) return 'close';
  const formsB = joinedForms(b);
  if ([...joinedForms(a)].some((f) => f && formsB.has(f))) return 'close';
  return 'different';
}

/** The best agreement between any name on one side and any on the other. */
function bestAgreement(namesA, namesB) {
  const order = { same: 3, close: 2, different: 1 };
  let best = null;
  for (const a of namesA.filter(Boolean)) {
    for (const b of namesB.filter(Boolean)) {
      const got = nameAgreement(a, b);
      if (got && (!best || order[got] > order[best])) best = got;
    }
  }
  return best;
}

/** A team's two names, or the one name. */
const boardNames = (row) => (Array.isArray(row.teamMembers) && row.teamMembers.length
  ? row.teamMembers
  : [row.driverName]).filter(Boolean);

const splitTeam = (name) => String(name || '').split('/').map((s) => s.trim()).filter(Boolean);

/**
 * Datatruck's trucks from its recent orders: the newest order per (fleet,
 * number) and who drove it. `orders` is `{label, drivers:[name], at}`.
 */
function indexDatatruckTrucks(orders = []) {
  const byLabel = new Map();
  for (const o of orders) {
    const k = labelKey(o.label);
    if (!k) continue;
    const truck = readBoardTruck(o.label);
    const prev = byLabel.get(k);
    if (!prev || String(o.at || '') > String(prev.at || '')) {
      byLabel.set(k, {
        label: o.label, unit: truck.unit, fleetType: truck.fleetType, drivers: (o.drivers || []).filter(Boolean), at: o.at || null,
      });
    }
  }
  // A suffix may be spelled differently on the two sides (a fleet word missing
  // on one), so a truck with a FLEET-WORD label may also be found by fleet and
  // number — only when exactly one Datatruck truck has them.
  const byFleet = new Map();
  for (const t of byLabel.values()) {
    if (namedOwner(t.label)) continue;
    const k = key(t.fleetType, t.unit);
    byFleet.set(k, byFleet.has(k) ? null : t);
  }
  return { byLabel, byFleet };
}

function findDatatruckTruck(index, board) {
  const exact = index.byLabel.get(labelKey(board.truckRaw));
  if (exact) return exact;
  if (namedOwner(board.truckRaw)) return null;
  return index.byFleet.get(key(board.fleetType, board.truckNorm)) || null;
}

/** Datatruck's driver list, by name, for the driver type of whoever drove. */
function datatruckTypeOf(name, drivers = []) {
  const hit = drivers.find((d) => nameAgreement(d.name, name) === 'same');
  return hit ? { name, type: hit.driverType || null, driverType: driverTypeFromDatatruck(hit.driverType) } : null;
}

/** Wenze's driver type and Datatruck's, for the same person, when both are known and differ. */
function driverTypeConflict(holders, dtTypes) {
  for (const h of holders) {
    if (!h.driverType) continue;
    for (const t of dtTypes) {
      if (!t.driverType) continue;
      const agree = splitTeam(h.name).some((n) => ['same', 'close'].includes(nameAgreement(n, t.name)));
      if (agree && t.driverType !== h.driverType) return { wenze: h.driverType, datatruck: t.type };
    }
  }
  return null;
}

/**
 * @param {object} input
 * @param {{truckRaw:string, truckNorm:string, fleetType:string, driverName:string, teamMembers?:string[], status?:string}[]} input.board
 * @param {{unitNumber:string, fleetType:string, displayName:string, groupName?:string, driverType?:string}[]} input.wenze  open truck records
 * @param {{label:string, drivers:string[], at:string}[]|null} input.datatruckOrders  null = Datatruck not read
 * @param {{name:string, driverType:string}[]} [input.datatruckDrivers]
 * @returns {{rows:object[], summary:object}}
 */
function compareFleet({
  board = [], wenze = [], datatruckOrders = null, datatruckDrivers = [],
}) {
  const wenzeByUnit = new Map();
  for (const w of wenze) {
    const u = unitKey(w.unitNumber);
    if (!wenzeByUnit.has(u)) wenzeByUnit.set(u, []);
    wenzeByUnit.get(u).push(w);
  }
  const dtRead = Array.isArray(datatruckOrders);
  const dtTrucks = dtRead ? indexDatatruckTrucks(datatruckOrders) : null;

  const rows = board.map((b) => {
    const names = boardNames(b);
    const onNumber = wenzeByUnit.get(unitKey(b.truckNorm)) || [];
    const sameFleet = onNumber.filter((w) => w.fleetType === b.fleetType);
    const wenzeNames = sameFleet.flatMap((w) => splitTeam(w.displayName));
    const otherFleets = onNumber.filter((w) => w.fleetType !== b.fleetType);

    const dt = dtRead ? findDatatruckTruck(dtTrucks, b) : null;
    const dtTypes = dt ? dt.drivers.map((n) => datatruckTypeOf(n, datatruckDrivers)).filter(Boolean) : [];
    const typeConflict = driverTypeConflict(sameFleet.map((w) => ({ name: w.displayName, driverType: w.driverType || null })), dtTypes);

    const problems = [];
    if (!onNumber.length) problems.push('not_in_wenze');
    else if (!sameFleet.length) problems.push('fleet_differs_wenze');
    const wenzeName = sameFleet.length ? bestAgreement(names, wenzeNames) : null;
    if (wenzeName === 'different') problems.push('name_differs_wenze');
    if (wenzeName === 'close') problems.push('name_close_wenze');
    // No load in a week is expected of a driver at home, on vacation, resting
    // or in the shop — it is a disagreement only for a truck the board says works.
    if (dtRead && !dt && !notWorking(b.status)) problems.push('not_in_datatruck');
    const dtName = dt ? bestAgreement(names, dt.drivers) : null;
    if (dtName === 'different') problems.push('name_differs_datatruck');
    if (typeConflict) problems.push('driver_type_differs_datatruck');

    return {
      truck: b.truckRaw,
      unit: b.truckNorm,
      status: b.status || null,
      board: { fleetType: b.fleetType, names },
      wenze: {
        holders: sameFleet.map((w) => ({
          fleetType: w.fleetType, name: w.displayName, groupName: w.groupName || null, driverType: w.driverType || null,
        })),
        otherFleets: otherFleets.map((w) => ({ fleetType: w.fleetType, name: w.displayName })),
        name: wenzeName,
      },
      datatruck: dtRead
        ? {
          read: true,
          label: dt?.label || null,
          drivers: dt?.drivers || [],
          lastLoadAt: dt?.at || null,
          driverTypes: dtTypes.map((t) => t.type).filter(Boolean),
          driverTypeConflict: typeConflict,
          name: dtName,
        }
        : { read: false },
      problems,
    };
  });

  const count = (p) => rows.filter((r) => r.problems.includes(p)).length;
  return {
    rows,
    summary: {
      boardRows: rows.length,
      allAgree: rows.filter((r) => r.problems.length === 0).length,
      notInWenze: count('not_in_wenze'),
      fleetDiffersWenze: count('fleet_differs_wenze'),
      nameDiffersWenze: count('name_differs_wenze'),
      nameCloseWenze: count('name_close_wenze'),
      datatruckRead: dtRead,
      notInDatatruck: count('not_in_datatruck'),
      driverTypeDiffersDatatruck: count('driver_type_differs_datatruck'),
      nameDiffersDatatruck: count('name_differs_datatruck'),
    },
  };
}

module.exports = {
  compareFleet, nameAgreement, driverTypeFromDatatruck, indexDatatruckTrucks, labelKey, DATATRUCK_TYPE_TO_DRIVER_TYPE,
};
