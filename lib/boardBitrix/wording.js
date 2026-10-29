'use strict';

/**
 * What a Board ↔ Bitrix question says in the group. PURE.
 *
 * Plain English, like every other notice in the group: what the Dispatcher
 * Board says, what Bitrix says, and the one thing to change in Bitrix. The
 * Board is the source of truth, so the fix is always on the Bitrix side.
 * Codes stay out of the text (lib/notifications/compose.js blanks long
 * identifiers); a deal or truck is named by its title and number.
 *
 * LINKS GO ON THEIR OWN LINES. The composer clips every line at 160
 * characters; a link at the end of a long line would lose the end of its deal
 * id — and Telegram would still link what was left, to a different deal.
 */

const { dealStageName, truckStageName, fleetLabel } = require('./vocabulary');

const ANSWER_HINT = 'Fix it in Bitrix, then reply "done" to this message and I will check again. '
  + 'Reply "skip" to come back to it tomorrow.';

function boardLine(p) {
  const bits = [p.name];
  if (p.fleetType) bits.push(fleetLabel(p.fleetType));
  if (p.truck) bits.push(`truck ${p.truck}`);
  if (p.status) bits.push(p.status);
  return `Dispatcher Board: ${bits.join(', ')}`;
}

function dealLine(d) {
  const bits = [`"${d.title}"`, dealStageName(d.stageId), d.fleetType ? fleetLabel(d.fleetType) : 'driver type not set'];
  bits.push(d.truckTitle ? `truck ${d.truckNumber || '?'}` : 'no truck');
  return `Bitrix deal: ${bits.join(', ')}`;
}

function truckLine(t) {
  return `Bitrix truck: "${t.title}", ${truckStageName(t.stageId)}`;
}

/** "Open in Bitrix: <url>", one line per deal or truck the question is about. */
function linkLines(x, links) {
  const out = [];
  const deals = [x.deal, ...(x.deals || [])].filter(Boolean);
  if (links?.dealUrl) for (const d of deals.slice(0, 3)) out.push(`Open in Bitrix: ${links.dealUrl(d.id)}`);
  if (links?.truckUrl && x.truck && !deals.length) out.push(`Open in Bitrix: ${links.truckUrl(x.truck.id)}`);
  return out;
}

const TEXT = {
  missing_in_bitrix: (x) => ({
    title: `${x.board.name} is on the Dispatcher Board but has no deal in Bitrix`,
    lines: [boardLine(x.board), 'Bitrix: no deal with this name in DRIVER RELATION'],
    fix: 'Create the driver\'s deal in DRIVER RELATION (or correct the name on the existing one).',
  }),
  inactive_in_bitrix: (x) => ({
    title: `${x.board.name} is working on the Board but closed in Bitrix`,
    lines: [boardLine(x.board), dealLine(x.deal)],
    fix: 'Move the deal back to the stage that matches the Board.',
  }),
  not_on_board: (x) => ({
    title: `${x.deal.title} is active in Bitrix but not on the Dispatcher Board`,
    lines: [dealLine(x.deal), 'Dispatcher Board: no line for this driver'],
    fix: 'If they no longer work for us, close the deal (TERMINATED, LEFT or RESIGNED); if they do, correct their name in Bitrix.',
  }),
  name_differs: (x) => ({
    title: `Truck ${x.board[0].truck}: the name on the Board and in Bitrix differ`,
    lines: [...x.board.map(boardLine), ...x.deals.map((d) => dealLine(d))],
    fix: 'Correct the driver\'s name (or the truck) in Bitrix so they match the Board.',
  }),
  duplicate_deals: (x) => ({
    title: `${x.board.name} has more than one active deal in Bitrix`,
    lines: [boardLine(x.board), ...x.deals.map((d) => dealLine(d))],
    fix: 'Keep one deal for the driver and close the others.',
  }),
  two_names_in_deal: (x) => ({
    title: `One Bitrix deal is titled with two drivers: ${x.deal.title}`,
    lines: [dealLine(x.deal)],
    fix: 'Each driver needs their own deal: rename this one to one driver and give the other their own.',
  }),
  truck_differs: (x) => ({
    title: `${x.board.name}: the truck differs`,
    lines: [boardLine(x.board), dealLine(x.deal)],
    fix: `Set the deal's Assigned truck to truck ${x.board.truck}.`,
  }),
  truck_missing: (x) => ({
    title: `${x.board.name}: no truck assigned in Bitrix`,
    lines: [boardLine(x.board), dealLine(x.deal)],
    fix: `Set the deal's Assigned truck to truck ${x.board.truck}.`,
  }),
  truck_inactive: (x) => ({
    title: `Truck ${x.board.truck} is driving on the Board but not "On the road" in Bitrix`,
    lines: [boardLine(x.board), truckLine(x.truck)],
    fix: 'Move the truck to "On the road" in Bitrix.',
  }),
  truck_without_driver: (x) => ({
    title: `Truck ${x.truck.number || x.truck.title} is on the road in Bitrix with no active driver`,
    lines: [truckLine(x.truck), 'Bitrix: no active driver deal has this truck assigned'],
    fix: 'Assign the truck to its driver\'s deal, or close the truck if it is no longer in use.',
  }),
  status_differs: (x) => ({
    title: `${x.board.name}: the status differs`,
    lines: [boardLine(x.board), dealLine(x.deal)],
    fix: `Move the deal to ${dealStageName(x.expectedStageId)}.`,
  }),
  fleet_differs: (x) => ({
    title: `${x.board.name}: the driver type differs`,
    lines: [boardLine(x.board), dealLine(x.deal)],
    fix: `Set the deal's driver type to ${fleetLabel(x.board.fleetType)}.`,
  }),
  fleet_missing: (x) => ({
    title: `${x.board.name}: driver type not set in Bitrix`,
    lines: [boardLine(x.board), dealLine(x.deal)],
    fix: `Set the deal's driver type to ${fleetLabel(x.board.fleetType)}.`,
  }),
};

/** What each kind is, in a few words — for the admin card, which shows counts and no names. */
const KIND_LABELS = Object.freeze({
  missing_in_bitrix: 'On the Board, no deal in Bitrix',
  inactive_in_bitrix: 'On the Board, closed in Bitrix',
  not_on_board: 'Active in Bitrix, not on the Board',
  name_differs: 'Same truck, different name',
  duplicate_deals: 'More than one active deal',
  two_names_in_deal: 'Two drivers in one deal',
  truck_differs: 'Different truck',
  truck_missing: 'No truck assigned in Bitrix',
  truck_inactive: 'Truck not "On the road" in Bitrix',
  truck_without_driver: 'Truck on the road with no driver',
  status_differs: 'Different status',
  fleet_differs: 'Different driver type',
  fleet_missing: 'Driver type not set in Bitrix',
});

/**
 * The question for one discrepancy.
 * @param {object} details  what compare.js produced for it
 * @param {{ dealUrl?: Function, truckUrl?: Function, waiting?: number }} [links]
 * @returns {{ title: string, lines: string[], action: string }}
 */
function questionFor(details, links = {}) {
  const make = TEXT[details?.kind];
  if (!make) return { title: 'Board and Bitrix differ', lines: [], action: ANSWER_HINT };
  const text = make(details);
  const lines = [...text.lines, `What to change: ${text.fix}`, ...linkLines(details, links)];
  if (links.waiting > 0) lines.push(`${links.waiting} more difference(s) waiting after this one.`);
  return { title: `Board ↔ Bitrix: ${text.title}`, lines, action: ANSWER_HINT };
}

/** The same facts, short, for "still different" and the admin card. */
function factsFor(details, links = {}) {
  const make = TEXT[details?.kind];
  return make ? [...make(details).lines, ...linkLines(details, links)] : [];
}

module.exports = { questionFor, factsFor, ANSWER_HINT, KIND_LABELS };
