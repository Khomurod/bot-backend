'use strict';

/**
 * The daily Board ↔ Wenze ↔ Datatruck check: which disagreements are worth a
 * person's attention, and how each is asked. PURE — the comparison itself is
 * `compare.js`, the reads `services/operations/checks/fleetCrossCheck.js`.
 *
 * TWO OF THREE. Two sources that disagree say only that one is wrong; a third
 * says which (the owner, 5 November 2026). So every finding here needs a
 * second source on the side it would have a person change:
 *
 *   fleet.driver_not_in_wenze          the board AND Datatruck have this driver
 *                                      in this truck; Wenze has nobody in it.
 *                                      A notice: a chat or a unit is missing,
 *                                      which only a person can add.
 *   fleet.board_suffix_missing         the board writes the bare number, which
 *                                      reads as an owner-operator truck; Datatruck
 *                                      writes the same driver's truck with a fleet
 *                                      word (888 → 888 CMP). A notice for the
 *                                      dispatcher, who keeps the board.
 *   fleet.driver_type_differs_datatruck  Wenze's driver type is not Datatruck's for
 *                                      the same person in the same truck, and the
 *                                      board does not side with Wenze. A question;
 *                                      Yes records Datatruck's type in Wenze.
 *
 * NOTHING HERE CHANGES ANYTHING BY ITSELF. Datatruck and the board are other
 * people's systems; what they say is evidence for a question, never a write
 * (the owner: "never change Wenze from an outside source on its own").
 *
 * What is NOT here, because another check already owns it: a truck Wenze holds
 * under another fleet or owner (`identity.truck_from_board`), a truck still
 * recorded to a driver who left (`identity.unit_handover`), two people claiming
 * one truck (`identity.unit_contested`).
 */
const { readBoardTruck } = require('../board/truckSuffix');
const { FLEET_TYPES } = require('../drivers/fleetType');
const { ownerFromSuffix } = require('../drivers/truckIdentity');
const { nameAgreement, bestAgreement, driverTypeFromDatatruck } = require('./compare');

const CHECK_KEYS = Object.freeze([
  'fleet.driver_not_in_wenze',
  'fleet.board_suffix_missing',
  'fleet.driver_type_differs_datatruck',
]);

/** A suffix that names a fleet — not a bare number, not an owner's name. */
const FLEET_WORD_DETAILS = new Set(['company_truck', 'investor_truck', 'vendor_truck', 'lease_to_rent', 'lease_to_own']);

const unitKey = (u) => String(u || '').trim().toUpperCase();
const agrees = (a) => a === 'same' || a === 'close';
const tokens = (name) => String(name || '').toUpperCase().split(/[^A-Z]+/).filter(Boolean);

/**
 * The DRIVER's type the board's label implies, or null when it does not say.
 * COMP/CMP/V: a company driver. R: lease. L: bought the truck — an owner. A bare
 * number: the owner-operator at his own wheel. An owner's name: the owner when
 * it is the driver's own name, otherwise a driver he hired.
 */
function boardDriverType(truckRaw, driverNames = []) {
  const truck = readBoardTruck(truckRaw);
  switch (truck.detail) {
    case 'company_truck': case 'investor_truck': case 'vendor_truck': return 'company_driver';
    case 'lease_to_rent': return 'lease';
    case 'lease_to_own': return 'owner';
    case 'own_truck': {
      const owner = ownerFromSuffix(truck.suffix);
      if (!owner) return 'owner';
      const ownerWords = tokens(owner);
      const own = driverNames.some((n) => tokens(n).some((t) => ownerWords.includes(t)));
      return own ? 'owner' : 'company_driver';
    }
    default: return null;
  }
}

/** Where else Wenze has a driver of this name: the number and the chat. */
function wenzeElsewhere(names, wenze) {
  const out = [];
  for (const w of wenze) {
    const wNames = String(w.displayName || '').split('/').map((s) => s.trim()).filter(Boolean);
    if (agrees(bestAgreement(names, wNames))) out.push({ unitNumber: w.unitNumber, groupName: w.groupName || null });
  }
  return out.slice(0, 3);
}

function notInWenze(row, wenze) {
  if (!row.problems.includes('not_in_wenze') || !row.datatruck?.read || !agrees(row.datatruck.name)) return null;
  const elsewhere = wenzeElsewhere(row.board.names, wenze);
  const driver = row.board.names.join(' / ');
  return {
    checkKey: 'fleet.driver_not_in_wenze',
    subjectType: 'board_truck',
    subjectId: row.truck,
    title: `${row.truck}: the board and Datatruck have ${driver}; Wenze has nobody in this truck`
      + (elsewhere.length ? ` (Wenze has this driver on ${elsewhere.map((e) => e.unitNumber).join(', ')})` : ''),
    severity: 'warning',
    tier: 'warning',
    confidence: 85,
    evidence: {
      boardTruck: row.truck,
      boardDriver: driver,
      boardStatus: row.status || null,
      datatruckLabel: row.datatruck.label,
      datatruckDriver: (row.datatruck.drivers || []).join(' / ') || null,
      lastLoadAt: row.datatruck.lastLoadAt || null,
      wenzeElsewhere: elsewhere,
    },
    proposedChange: null,
  };
}

function suffixMissing(row, orders) {
  const truck = readBoardTruck(row.truck);
  if (truck.suffix || row.board.fleetType !== FLEET_TYPES.OWNER_OPERATOR) return null;
  const hit = (orders || []).find((o) => {
    const t = readBoardTruck(o.label);
    return unitKey(t.unit) === unitKey(row.unit) && FLEET_WORD_DETAILS.has(t.detail)
      && (o.drivers || []).some((d) => row.board.names.some((n) => agrees(nameAgreement(n, d))));
  });
  if (!hit) return null;
  const dt = readBoardTruck(hit.label);
  return {
    checkKey: 'fleet.board_suffix_missing',
    subjectType: 'board_truck',
    subjectId: row.truck,
    title: `${row.truck}: the board writes no suffix (read as owner-operator); Datatruck writes ${hit.label} for the same driver`,
    severity: 'warning',
    tier: 'warning',
    confidence: 85,
    evidence: {
      boardTruck: row.truck,
      boardDriver: row.board.names.join(' / '),
      datatruckLabel: hit.label,
      datatruckSuffix: dt.suffix,
      datatruckFleet: dt.fleetType,
      lastLoadAt: hit.at || null,
    },
    proposedChange: null,
  };
}

function driverTypeDiffers(row, wenze) {
  const c = row.datatruck?.driverTypeConflict;
  if (!row.problems.includes('driver_type_differs_datatruck') || !c || !c.groupId) return null;
  const to = c.datatruckDriverType || driverTypeFromDatatruck(c.datatruck);
  if (!to || to === c.wenze) return null;
  const boardType = boardDriverType(row.truck, row.board.names);
  // The board on Wenze's side makes it two against Datatruck: not Wenze's to change.
  if (boardType && boardType === c.wenze) return null;
  const chat = wenze.find((w) => w.groupId === c.groupId);
  return {
    checkKey: 'fleet.driver_type_differs_datatruck',
    subjectType: 'group',
    subjectId: c.groupId,
    title: `${chat?.groupName || `Group ${c.groupId}`}: Wenze says ${c.wenze}, Datatruck says ${c.datatruck} for ${c.name}`,
    severity: 'info',
    tier: 'approval',
    confidence: boardType === to ? 80 : 60,
    evidence: {
      groupId: c.groupId,
      groupName: chat?.groupName || null,
      driverName: c.name,
      datatruckName: c.datatruckName || null,
      boardTruck: row.truck,
      wenzeType: c.wenze,
      datatruckType: c.datatruck,
      toDriverType: to,
      boardType,
    },
    proposedChange: {
      table: 'driver_profiles', groupId: c.groupId, from: c.wenze, to,
    },
  };
}

/**
 * @param {object} input
 * @param {object[]} input.rows     `compareFleet(...).rows`, Datatruck read
 * @param {object[]} input.wenze    the comparison's Wenze input (with `groupId`)
 * @param {object[]} input.orders   Datatruck's orders, as `compareFleet` took them
 * @returns {object[]} findings
 */
function crossCheckFindings({ rows = [], wenze = [], orders = [] }) {
  const out = [];
  const seen = new Set();
  for (const row of rows) {
    for (const f of [notInWenze(row, wenze), suffixMissing(row, orders), driverTypeDiffers(row, wenze)]) {
      if (!f) continue;
      const k = `${f.checkKey}|${f.subjectType}|${f.subjectId}`;
      if (seen.has(k)) continue; // a team's two seats on one chat: one question
      seen.add(k);
      out.push(f);
    }
  }
  return out;
}

module.exports = { CHECK_KEYS, crossCheckFindings, boardDriverType };
