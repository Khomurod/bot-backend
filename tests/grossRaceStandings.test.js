'use strict';

/**
 * Gross Grand Prix: how a week of Datatruck orders becomes a race. Pure.
 *
 * Ported from the race display the owner approved; these pin the rules it
 * raced by, and the one thing changed for a public page: a truck that has not
 * hit its target is a light with no driver's name.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { raceLoad, standings } = require('../services/grossRace/standings');
const { raceWeek } = require('../services/grossRace/week');

let nextId = 1;
function order({ dispatcher, pay, miles = 1000, driver = '', teammate = '', status = 'delivered', at = '2026-10-13T15:00:00Z' }) {
  return {
    id: nextId++, dispatcher__full_name: dispatcher, load_pay: String(pay), total_miles: String(miles), status,
    delivery_appointment_time: at,
    trip: { driver__full_name: driver, team_driver__full_name: teammate },
  };
}
const loadsOf = (orders) => orders.map(raceLoad).filter(Boolean);

test('an order without a dispatcher, cancelled, or without a date is not a race load', () => {
  assert.equal(raceLoad(order({ dispatcher: '', pay: 2000 })), null);
  assert.equal(raceLoad(order({ dispatcher: 'Ann Example', pay: 2000, status: 'Cancelled' })), null);
  assert.equal(raceLoad(order({ dispatcher: 'Ann Example', pay: 2000, status: 'canceled' })), null);
  assert.equal(raceLoad({ ...order({ dispatcher: 'Ann Example', pay: 2000 }), delivery_appointment_time: null, created_datetime: null }), null);
  const load = raceLoad(order({ dispatcher: ' Ann Example ', pay: '2500.50', driver: 'Zed Driver', teammate: 'Amy Driver' }));
  assert.deepEqual({ ...load, at: undefined }, {
    name: 'Ann Example', truck: 'Amy Driver + Zed Driver', team: true, amount: 2500.5, miles: 1000, at: undefined,
  });
});

test('teams race on one display and dispatchers on the other, by the word "team"', () => {
  const loads = loadsOf([
    order({ dispatcher: "Falcon's Team", pay: 3000, driver: 'A One' }),
    order({ dispatcher: 'Ann Example', pay: 2000, driver: 'B Two' }),
  ]);
  assert.deepEqual(standings(loads, { view: 'teams' }).racers.map((r) => r.name), ["Falcon's Team"]);
  assert.deepEqual(standings(loads, { view: 'dispatchers' }).racers.map((r) => r.name), ['Ann Example']);
});

test('the target is $15k a solo truck and $20k a team truck, ranked by share reached', () => {
  const loads = loadsOf([
    // Ann: one solo truck, 12k of 15k = 80%.
    order({ dispatcher: 'Ann Example', pay: 12000, driver: 'Solo One' }),
    // Bo: one team truck, 18k of 20k = 90%, but less gross than Cy.
    order({ dispatcher: 'Bo Example', pay: 18000, driver: 'Team A', teammate: 'Team B' }),
    // Cy: two solo trucks, 20k of 30k = 67%, the most gross.
    order({ dispatcher: 'Cy Example', pay: 16000, driver: 'Solo Two' }),
    order({ dispatcher: 'Cy Example', pay: 4000, driver: 'Solo Three' }),
  ]);
  const race = standings(loads, { view: 'dispatchers' });
  const byName = Object.fromEntries(race.racers.map((r) => [r.name, r]));
  assert.deepEqual(race.racers.map((r) => r.name), ['Ann Example', 'Bo Example', 'Cy Example'], 'lanes stay alphabetical');
  assert.equal(byName['Bo Example'].rank, 1);
  assert.equal(byName['Ann Example'].rank, 2);
  assert.equal(byName['Cy Example'].rank, 3);
  assert.equal(byName['Bo Example'].target, 20000);
  assert.equal(byName['Cy Example'].target, 30000);
  assert.equal(race.leadPct, 0.9);
  assert.equal(byName['Cy Example'].gap, 18000 - 20000);
  assert.equal(race.maxTarget, 30000);

  const byGross = standings(loads, { view: 'dispatchers', rankBy: 'gross' });
  assert.equal(byGross.racers.find((r) => r.rank === 1).name, 'Cy Example');
  assert.equal(byGross.rankBy, 'gross');
});

test('a driver is named only once their truck has hit its target; the rest are lights', () => {
  const race = standings(loadsOf([
    order({ dispatcher: 'Ann Example', pay: 15000, driver: 'Hit Driver' }),
    order({ dispatcher: 'Ann Example', pay: 4000, driver: 'Short Driver' }),
    order({ dispatcher: 'Ann Example', pay: 19000, driver: 'Pair A', teammate: 'Pair B' }),
  ]), { view: 'dispatchers' });
  const [ann] = race.racers;
  assert.deepEqual(ann.hitNames, ['Hit Driver']);
  assert.deepEqual(ann.lights, [
    { team: true, hit: false }, { team: false, hit: true }, { team: false, hit: false },
  ]);
  const sent = JSON.stringify(race);
  assert.ok(!sent.includes('Short Driver') && !sent.includes('Pair A'), 'no name of a truck short of its target');
});

test('top RPM needs two loads; an empty week has no leader', () => {
  const race = standings(loadsOf([
    order({ dispatcher: 'Ann Example', pay: 5000, miles: 1000, driver: 'X' }),
    order({ dispatcher: 'Bo Example', pay: 3000, miles: 1000, driver: 'Y' }),
    order({ dispatcher: 'Bo Example', pay: 3000, miles: 1000, driver: 'Y' }),
  ]), { view: 'dispatchers' });
  assert.equal(race.topRpmId, 'Bo Example', "Ann's one load is faster but does not count");
  assert.deepEqual(standings([], { view: 'teams' }), {
    racers: [], lead: 0, leadPct: 0, maxTarget: 0, topRpmId: null, rankBy: 'percent',
  });
});

test('the week runs Monday to Monday in Chicago, across the clock changes', () => {
  const week = raceWeek({ now: new Date('2026-10-14T18:00:00Z') });
  assert.equal(week.start.toISOString(), '2026-10-12T05:00:00.000Z');
  assert.equal(week.end.toISOString(), '2026-10-19T05:00:00.000Z');
  assert.equal(week.countedUntil.toISOString(), '2026-10-20T05:00:00.000Z', 'the Monday after counts too');
  assert.equal(week.label, 'Oct 12–19');
  assert.equal(week.day, 3);
  assert.equal(week.dayName, 'Wed');

  const sundayNight = raceWeek({ now: new Date('2026-10-12T04:30:00Z') });
  assert.equal(sundayNight.start.toISOString(), '2026-10-05T05:00:00.000Z', '11:30 pm Sunday in Chicago');
  assert.equal(sundayNight.day, 7);

  const fallBack = raceWeek({ now: new Date('2026-11-01T12:00:00Z') });
  assert.equal(fallBack.end.toISOString(), '2026-11-02T06:00:00.000Z', 'ends at midnight CST');
  assert.equal(fallBack.label, 'Oct 26 – Nov 2');
});
