'use strict';

/**
 * The Board ↔ Wenze ↔ Datatruck report — the reads. The comparison is pure:
 * `lib/fleetCrossCheck/compare.js`.
 *
 * READ-ONLY, all three ways. The board rows and Wenze's truck records are two
 * SELECTs; Datatruck is asked for its driver list and the last week of orders,
 * GET only, through the shared client (`services/datatruckApiService.js`).
 * Nothing is written anywhere — this is a report a person reads (the owner's
 * request of 5 November 2026), not a check that acts.
 *
 * DATATRUCK'S ALLOWANCE IS SHARED. It allows 20 requests a minute at 25 orders
 * a page, and the Gross Grand Prix spends the same allowance
 * (`docs/architecture/gross-race.md`). So the report is built at most once per
 * `TTL_MS` and kept in memory; a second press inside that window gets the same
 * answer, and only one build runs at a time. A week of orders is about ten
 * pages, the driver list a handful.
 *
 * A DATATRUCK THAT CANNOT BE READ IS SAID, NOT HIDDEN. No token, a refused
 * request or a timeout leaves the Datatruck column empty with the reason, and
 * the board ↔ Wenze half still stands — never a blank that reads as "agrees".
 */
const { compareFleet } = require('../../lib/fleetCrossCheck/compare');

const TTL_MS = 10 * 60 * 1000;
const ORDER_DAYS = 7;

function defaultDeps() {
  /* eslint-disable global-require */
  return {
    boardRows: require('../../database/dispatchBoard'),
    db: require('../../database/pool'),
    datatruck: require('../datatruckApiService'),
    now: () => Date.now(),
  };
  /* eslint-enable global-require */
}

/** Wenze's open truck records, with who holds them and their chat. */
async function readWenze(db) {
  const res = await db.query(
    `SELECT u.unit_number, u.fleet_type, p.display_name, g.group_name
       FROM driver_units u
       JOIN driver_people p ON p.id = u.person_id
       LEFT JOIN driver_person_groups pg ON pg.person_id = u.person_id AND pg.ended_at IS NULL
       LEFT JOIN groups g ON g.id = pg.group_id AND g.active = TRUE
      WHERE u.ended_at IS NULL`
  );
  return res.rows.map((r) => ({
    unitNumber: r.unit_number, fleetType: r.fleet_type || 'unknown', displayName: r.display_name, groupName: r.group_name || null,
  }));
}

function fullName(account = {}) {
  return account.full_name || [account.first_name, account.last_name].filter(Boolean).join(' ') || null;
}

/** Datatruck: who is which type, and which truck each recent load ran on. */
async function readDatatruck(datatruck, nowMs) {
  if (!datatruck.isConfigured()) return { read: false, reason: 'Datatruck is not connected (no token in Settings → Secrets).' };
  try {
    const startIso = new Date(nowMs - ORDER_DAYS * 86_400_000).toISOString();
    const endIso = new Date(nowMs + 86_400_000).toISOString();
    const [drivers, orders] = [await datatruck.fetchAllDrivers(), await datatruck.fetchOrdersByPickupWindow(startIso, endIso)];
    return {
      read: true,
      drivers: (drivers || []).map((d) => ({ name: fullName(d.account), driverType: d.driver_type || null })).filter((d) => d.name),
      orders: (orders || []).map((o) => ({
        label: o?.trip?.truck__unit_number || o?.assigned_driver_n_truck?.truck_unit_number || null,
        drivers: [o?.trip?.driver__full_name, o?.trip?.team_driver__full_name].filter(Boolean),
        at: o?.pickup_time || o?.pickup_appointment_time || null,
      })).filter((o) => o.label),
    };
  } catch (err) {
    // The reason in words a page may show: a status code, never the URL or the token.
    const status = err && (err.status || err.statusCode);
    return { read: false, reason: `Datatruck could not be read${status ? ` (HTTP ${status})` : ''}.` };
  }
}

function createFleetCrossCheck(deps = defaultDeps()) {
  let cached = null;
  let building = null;

  async function build() {
    const nowMs = deps.now();
    const [board, wenze, dt] = [
      await deps.boardRows.listBoardRows({ presentOnly: true }),
      await readWenze(deps.db),
      await readDatatruck(deps.datatruck, nowMs),
    ];
    const result = compareFleet({
      board: board.map((r) => ({
        truckRaw: r.truckRaw, truckNorm: r.truckNorm, fleetType: r.fleetType,
        driverName: r.cleanName, teamMembers: r.teamMembers, status: r.status,
      })),
      wenze,
      datatruckOrders: dt.read ? dt.orders : null,
      datatruckDrivers: dt.read ? dt.drivers : [],
    });
    return {
      ...result,
      builtAt: new Date(nowMs).toISOString(),
      datatruck: dt.read ? { read: true, orderDays: ORDER_DAYS } : { read: false, reason: dt.reason },
    };
  }

  /** The report, from memory when it is fresh; `refresh` rebuilds once the window allows. */
  async function getReport({ refresh = false } = {}) {
    const fresh = cached && deps.now() - Date.parse(cached.builtAt) < TTL_MS;
    if (fresh && !refresh) return { ...cached, fromCache: true };
    if (fresh && refresh) return { ...cached, fromCache: true, refreshRefused: 'Built less than 10 minutes ago — Datatruck is not asked again yet.' };
    if (!building) {
      building = build().then((r) => { cached = r; return r; }).finally(() => { building = null; });
    }
    return { ...(await building), fromCache: false };
  }

  return { getReport };
}

module.exports = { createFleetCrossCheck, TTL_MS, ORDER_DAYS };
