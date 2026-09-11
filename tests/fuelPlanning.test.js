'use strict';

/**
 * Can this truck reach the stop it was given.
 *
 * THE PROPERTY THIS FILE GUARDS IS A REFUSAL. When the assigned stop is out of
 * reach, nothing here names an alternative — Wenze knows the stops dispatch
 * names and has no database of fuel prices, truck-accessible stations or
 * opening hours, so "stop at the Pilot in Effingham" would be an invented fact
 * wearing the clothes of a plan.
 *
 * A confident wrong suggestion about where to fuel a truck four hundred miles
 * from anywhere is worse than a clear statement of the problem.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { planFuelStop, priorityFactsFor } = require('../lib/fuel/planning');
const { priorityFor, LEVELS } = require('../lib/notifications/priority');

test('a truck that cannot reach the stop is told so, with both numbers', () => {
  const out = planFuelStop({ rangeMiles: 80, milesToStation: 200, stationName: 'Effingham' });
  assert.equal(out.reachable, false);
  assert.match(out.advice, /about 80 miles in the tank and 200 to the stop at Effingham/);
  assert.match(out.advice, /will not get there/);
});

test('AND NO ALTERNATIVE IS NAMED, because there is none to name', () => {
  const out = planFuelStop({ rangeMiles: 80, milesToStation: 200, stationName: 'Effingham' });
  assert.match(out.advice, /Somebody needs to pick a closer stop/,
    'the decision goes to the person who can actually see one');
  // Nothing that could be read as a recommendation of a specific place.
  assert.equal(/stop at the [A-Z]/.test(out.advice.replace('the stop at Effingham', '')), false);
});

test('a thin margin reaches it, and says why that is still worth knowing', () => {
  const out = planFuelStop({ rangeMiles: 230, milesToStation: 200 });
  assert.equal(out.reachable, true);
  assert.equal(out.marginMiles, 30);
  assert.match(out.advice, /a detour or a queue would end the trip early/);
});

test('a comfortable margin says so plainly', () => {
  const out = planFuelStop({ rangeMiles: 600, milesToStation: 100 });
  assert.equal(out.reachable, true);
  assert.match(out.advice, /comfortably/);
});

test('the leg AFTER fuelling is mentioned only when it is actually known', () => {
  const tight = planFuelStop({ rangeMiles: 280, milesToStation: 200, milesToNextStop: 300 });
  assert.match(tight.advice, /300 more to run afterwards/);
  const unknown = planFuelStop({ rangeMiles: 280, milesToStation: 200 });
  assert.equal(/more to run afterwards/.test(unknown.advice), false);
});

// ── missing is unknown, never zero ──────────────────────────────────────────

test('NO FUEL READING IS UNKNOWN, NOT AN EMPTY TANK', () => {
  const out = planFuelStop({ rangeMiles: null, milesToStation: 200 });
  assert.equal(out.known, false);
  assert.equal(out.reachable, null);
  assert.match(out.advice, /no fuel reading for this truck/);
  assert.equal(out.reachable === false, false,
    'a truck whose tank we cannot read is not a truck with an empty tank');
});

test('no distance to the stop is equally unknown, and says which piece is missing', () => {
  const out = planFuelStop({ rangeMiles: 400, milesToStation: null });
  assert.equal(out.known, false);
  assert.match(out.advice, /no distance to the assigned stop/);
});

test('a stop with no name still reads as a sentence', () => {
  const out = planFuelStop({ rangeMiles: 80, milesToStation: 200 });
  assert.match(out.advice, /the assigned stop/);
});

// ── the numbers the notice is prioritised by are the ones it was written from ─

test('THE PLAN AND ITS PRIORITY ARE COMPUTED FROM THE SAME NUMBERS', () => {
  const plan = planFuelStop({ rangeMiles: 80, milesToStation: 200 });
  const priority = priorityFor({ severity: 'serious', facts: priorityFactsFor(plan) });
  assert.equal(priority.level, LEVELS.NOW);
  // Two places computing "how urgent is this" from the same inputs is two
  // places to get it different.
  assert.equal(priority.reasons.join(' ').includes('200 miles to go'), true);
});

test('a comfortable plan does not produce an urgent notice', () => {
  const plan = planFuelStop({ rangeMiles: 600, milesToStation: 100 });
  const priority = priorityFor({ severity: 'serious', facts: priorityFactsFor(plan) });
  assert.equal(priority.level, LEVELS.WHENEVER);
});

test('an UNKNOWN plan hands over no facts, so it cannot manufacture urgency', () => {
  const plan = planFuelStop({ rangeMiles: null, milesToStation: 200 });
  assert.deepEqual(priorityFactsFor(plan), {});
  const priority = priorityFor({ severity: 'serious', facts: priorityFactsFor(plan) });
  assert.equal(priority.level, LEVELS.WHENEVER);
});

test('numbers are rounded, because range is an order of magnitude not a promise', () => {
  const out = planFuelStop({ rangeMiles: 182.47, milesToStation: 200.31 });
  assert.match(out.advice, /about 182 miles/);
  assert.equal(/182\.4/.test(out.advice), false,
    'a number given to three significant figures will be trusted to three');
});

test('a plan is plain data', () => {
  const out = planFuelStop({ rangeMiles: 400, milesToStation: 100 });
  for (const v of Object.values(out)) assert.notEqual(typeof v, 'function');
});
