'use strict';

/**
 * The Dispatcher Board against Bitrix24: every difference, as data. PURE.
 *
 * THE BOARD IS THE SOURCE OF TRUTH (the owner, 29 October 2026), so every
 * discrepancy below is something to correct in Bitrix, and each one is asked
 * about on its own. Who is paired with whom is decided in three passes,
 * strongest evidence first:
 *
 *   1. the same TRUCK (fleet from the driver's deal + the number from the
 *      truck's title) and a compatible name — one word is enough here;
 *   2. the same NAME across the fleet (lib/boardBitrix/names.js namesClose);
 *   3. a truck whose Board name and Bitrix name are too different to pair —
 *      that is one question ("which name is right?"), not a "missing" and a
 *      "not on the board" about the same seat.
 *
 * A paired driver is then compared field by field: driver type, truck, stage,
 * and whether the truck itself is still on the road. What is left over is
 * "on the Board, not active in Bitrix" and "active in Bitrix, not on the
 * Board"; an active truck no active deal points at is the last kind.
 *
 * Every kind and its key are listed in KINDS. A key is what makes a question
 * the same question on the next pass: the deal, the truck or the person it is
 * about — never the values, so a question whose details change stays one
 * question and shows the new details.
 */

const {
  EXPECTED_STAGE_FOR_BOARD_STATUS, ACTIVE_TRUCK_STAGES,
} = require('./vocabulary');
const {
  tidyName, personKey, namesClose, namesCompatible, titleParts,
} = require('./names');
const { truckNumberFromTitle, sameTruckNumber } = require('./trucks');

/** Ask-order: who is missing first, then the seat, then the details. */
const KINDS = Object.freeze({
  not_on_board: 10,
  missing_in_bitrix: 10,
  inactive_in_bitrix: 10,
  name_differs: 20,
  duplicate_deals: 20,
  two_names_in_deal: 20,
  truck_differs: 30,
  truck_missing: 30,
  truck_inactive: 40,
  truck_without_driver: 40,
  status_differs: 50,
  fleet_differs: 60,
  fleet_missing: 60,
});

/** A Board line that names nobody yet ("OPEN", "AVAILABLE") is not a driver. */
const PLACEHOLDER_NAMES = new Set(['OPEN', 'EMPTY', 'AVAILABLE', 'VACANT', 'NONE', 'TBD', 'NA', 'UNASSIGNED', 'NO DRIVER']);

const ACTIVE_TRUCKS = new Set(ACTIVE_TRUCK_STAGES);

function boardPeople(rows) {
  const people = [];
  for (const row of rows || []) {
    if (!row || row.present === false) continue;
    const members = Array.isArray(row.teamMembers) && row.teamMembers.length >= 2 ? row.teamMembers : null;
    const names = members || [row.cleanName || row.driverNameRaw];
    for (const name of names) {
      const tidy = tidyName(name);
      if (!tidy || PLACEHOLDER_NAMES.has(tidy)) continue;
      people.push({
        name: tidy,
        key: personKey(name),
        fleetType: row.fleetType && row.fleetType !== 'unknown' ? row.fleetType : null,
        truck: row.truckNorm || null,
        status: String(row.status || '').toUpperCase() || null,
        team: Boolean(members),
      });
    }
  }
  return people;
}

function shapeTrucks(trucks) {
  const byId = new Map();
  for (const t of trucks || []) {
    if (!t || !t.id) continue;
    byId.set(Number(t.id), {
      id: Number(t.id),
      title: String(t.title || '').trim(),
      number: truckNumberFromTitle(t.title),
      stageId: t.stageId || null,
      active: ACTIVE_TRUCKS.has(t.stageId),
    });
  }
  return byId;
}

function shapeDeals(deals, trucksById) {
  return (deals || []).filter((d) => d && d.id).map((d) => {
    const truck = d.truckId ? trucksById.get(Number(d.truckId)) || null : null;
    const parts = titleParts(d.title);
    return {
      id: Number(d.id),
      title: tidyName(d.title) || String(d.title || '').trim(),
      parts: parts.map(tidyName),
      composite: parts.length > 1,
      stageId: d.stageId || null,
      active: d.semantic === 'P',
      fleetType: d.fleetType || null,
      truckId: d.truckId ? Number(d.truckId) : null,
      truck,
    };
  });
}

const fleetsAgree = (a, b) => !a || !b || a === b;
const dealView = (d) => ({
  id: d.id, title: d.title, stageId: d.stageId, fleetType: d.fleetType,
  truckId: d.truckId, truckNumber: d.truck ? d.truck.number : null, truckTitle: d.truck ? d.truck.title : null,
});
const personView = (p) => ({ name: p.name, fleetType: p.fleetType, truck: p.truck, status: p.status, team: p.team });

/**
 * Deals on this person's truck. A truck number alone is not a truck (Company
 * 001 and Lease 001 are two), so the fleet decides, and an UNKNOWN fleet never
 * wins a choice between two:
 *
 *   person's fleet known   deals of that fleet; failing those, deals whose
 *                          driver type is empty — never another known fleet;
 *   person's fleet unknown every deal on that number, but only while they are
 *                          all one fleet — otherwise no seat at all, and the
 *                          name has to do the pairing on its own.
 */
function sameSeat(person, deals) {
  if (!person.truck) return [];
  const onNumber = deals.filter((d) => d.truck && d.truck.number && sameTruckNumber(d.truck.number, person.truck));
  if (person.fleetType) {
    const sameFleet = onNumber.filter((d) => d.fleetType === person.fleetType);
    return sameFleet.length ? sameFleet : onNumber.filter((d) => !d.fleetType);
  }
  const fleets = new Set(onNumber.map((d) => d.fleetType).filter(Boolean));
  return fleets.size > 1 ? [] : onNumber;
}

function pickOne(person, matches) {
  if (matches.length <= 1) return matches[0] || null;
  const sameFleet = matches.filter((d) => person.fleetType && d.fleetType === person.fleetType);
  return sameFleet.length === 1 ? sameFleet[0] : null;
}

/** Field-by-field differences of one paired driver. */
function comparePair(person, deal, add) {
  const board = personView(person);
  const bitrix = dealView(deal);
  if (person.fleetType && !deal.fleetType) add('fleet_missing', `deal:${deal.id}`, { board, deal: bitrix });
  else if (person.fleetType && deal.fleetType !== person.fleetType) add('fleet_differs', `deal:${deal.id}`, { board, deal: bitrix });

  let truckAgrees = false;
  if (person.truck) {
    if (!deal.truckId || !deal.truck) add('truck_missing', `deal:${deal.id}`, { board, deal: bitrix });
    else if (!sameTruckNumber(deal.truck.number, person.truck)) add('truck_differs', `deal:${deal.id}`, { board, deal: bitrix });
    else truckAgrees = true;
  }

  const expected = EXPECTED_STAGE_FOR_BOARD_STATUS[person.status] || null;
  if (expected && deal.stageId !== expected) add('status_differs', `deal:${deal.id}`, { board, deal: bitrix, expectedStageId: expected });

  // A driver on vacation may have handed the truck back; nothing to say then.
  if (truckAgrees && !deal.truck.active && person.status !== 'VACATION') {
    add('truck_inactive', `truck:${deal.truck.id}`, { board, deal: bitrix, truck: { ...deal.truck } });
  }
}

/**
 * @param {{ boardRows: object[], deals: object[], trucks: object[] }} input
 *   boardRows — present `dispatch_board_rows` (database/dispatchBoard.js mapRow);
 *   deals — `{ id, title, stageId, semantic, fleetType, truckId }`;
 *   trucks — `{ id, title, stageId }`
 * @returns {{ discrepancies: object[], counts: object }}
 */
function compareBoardWithBitrix({ boardRows, deals, trucks }) {
  const found = new Map();
  const add = (kind, subject, data) => {
    const key = `${kind}:${subject}`;
    if (!found.has(key)) found.set(key, { kind, key, priority: KINDS[kind], ...data });
  };

  const people = boardPeople(boardRows);
  const trucksById = shapeTrucks(trucks);
  const allDeals = shapeDeals(deals, trucksById);
  const active = allDeals.filter((d) => d.active);
  const pairable = active.filter((d) => !d.composite);
  const used = new Set();
  const free = () => pairable.filter((d) => !used.has(d.id));
  const pairs = [];
  let open = [];

  // 1. Same truck, compatible name.
  for (const person of people) {
    const seat = sameSeat(person, free()).filter((d) => namesCompatible(person.name, d.title));
    const deal = pickOne(person, seat);
    if (deal) { used.add(deal.id); pairs.push([person, deal]); } else open.push(person);
  }

  // 2. Same name anywhere in the fleet.
  const afterName = [];
  for (const person of open) {
    const matches = free().filter((d) => namesClose(person.name, d.title));
    const deal = pickOne(person, matches);
    if (deal) { used.add(deal.id); pairs.push([person, deal]); continue; }
    if (matches.length > 1) {
      for (const d of matches) used.add(d.id);
      add('duplicate_deals', `person:${person.key}`, { board: personView(person), deals: matches.map(dealView) });
      continue;
    }
    afterName.push(person);
  }
  open = afterName;

  // 3. One seat, two different names: ask which is right, once per truck —
  // every Board name on that truck in one question, none of them also "missing".
  const inSeatQuestion = new Set();
  for (const person of open) {
    if (inSeatQuestion.has(person)) continue;
    const seat = sameSeat(person, free());
    if (!seat.length) continue;
    const onTruck = open.filter((p) => p.truck && sameTruckNumber(p.truck, person.truck)
      && fleetsAgree(p.fleetType, person.fleetType));
    for (const p of onTruck) inSeatQuestion.add(p);
    for (const d of seat) used.add(d.id);
    add('name_differs', `truck:${person.fleetType || 'any'}:${person.truck}`, {
      board: onTruck.map(personView), deals: seat.map(dealView),
    });
  }
  open = open.filter((p) => !inSeatQuestion.has(p));

  // A deal titled with two people is its own question; the people it names are
  // accounted for by it rather than reported missing.
  for (const d of active.filter((x) => x.composite)) {
    add('two_names_in_deal', `deal:${d.id}`, { deal: dealView(d), parts: d.parts });
    open = open.filter((p) => !d.parts.some((part) => namesClose(p.name, part)));
  }

  // 4. On the Board, not active in Bitrix.
  const inactive = allDeals.filter((d) => !d.active);
  for (const person of open) {
    const closed = inactive.filter((d) => namesClose(person.name, d.title)).sort((a, b) => b.id - a.id);
    if (closed.length) add('inactive_in_bitrix', `deal:${closed[0].id}`, { board: personView(person), deal: dealView(closed[0]) });
    else add('missing_in_bitrix', `person:${person.key}`, { board: personView(person) });
  }

  // 5. Active in Bitrix, not on the Board.
  for (const d of pairable.filter((x) => !used.has(x.id))) add('not_on_board', `deal:${d.id}`, { deal: dealView(d) });

  for (const [person, deal] of pairs) comparePair(person, deal, add);

  // 6. An active truck no active deal points at.
  const pointedAt = new Set(active.map((d) => d.truckId).filter(Boolean));
  for (const t of trucksById.values()) {
    if (t.active && !pointedAt.has(t.id)) add('truck_without_driver', `truck:${t.id}`, { truck: { ...t } });
  }

  const discrepancies = [...found.values()].sort((a, b) => a.priority - b.priority || a.key.localeCompare(b.key));
  return {
    discrepancies,
    counts: {
      boardPeople: people.length,
      activeDeals: active.length,
      activeTrucks: [...trucksById.values()].filter((t) => t.active).length,
      paired: pairs.length,
      discrepancies: discrepancies.length,
    },
  };
}

module.exports = { compareBoardWithBitrix, boardPeople, KINDS };
