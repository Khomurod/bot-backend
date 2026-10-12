'use strict';

/**
 * Gross Grand Prix: how a week of Datatruck orders becomes a race. Pure.
 *
 * Which loads count is Datatruck's driver-board rule (no booked or cancelled
 * load, the week of the DEL date). Teams race their dispatched loads against a
 * truck target; dispatchers race the loads they created, by gross alone. A
 * public page never names a driver whose truck is short of its target.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { raceLoad, standings } = require('../services/grossRace/standings');
const { raceWeek } = require('../services/grossRace/week');

let nextId = 1;
function order({
  dispatcher = "Falcon's Team", creator = 'Ann Example', pay, miles = 1000, driver = '', teammate = '',
  status = 'dispatched', at = '2026-10-13T15:00:00Z',
}) {
  return {
    id: nextId++, dispatcher__full_name: dispatcher, created_by__full_name: creator, load_pay: String(pay),
    total_miles: String(miles), status, delivery_time: at, delivery_appointment_time: at,
    trip: { driver__full_name: driver, team_driver__full_name: teammate },
  };
}
const loadsOf = (orders) => orders.map(raceLoad).filter(Boolean);
const byRank = (race) => [...race.racers].sort((a, b) => a.rank - b.rank);

test('a booked or cancelled load, or one with no DEL date, does not count', () => {
  assert.equal(raceLoad(order({ pay: 2000, status: 'booked' })), null, 'planned, not dispatched yet');
  assert.equal(raceLoad(order({ pay: 2000, status: 'Cancelled' })), null);
  assert.equal(raceLoad(order({ pay: 2000, status: 'canceled' })), null);
  assert.equal(raceLoad({ ...order({ pay: 2000 }), delivery_time: null }), null);
  for (const status of ['dispatched', 'assigned', 'in_transit', 'delivered', 'invoiced', 'paid']) {
    assert.ok(raceLoad(order({ pay: 2000, status })), status);
  }
  const load = raceLoad(order({ dispatcher: " Falcon's  Team ", pay: '2500.50', driver: 'Zed Driver', teammate: 'Amy Driver' }));
  assert.deepEqual({ ...load, at: undefined }, {
    dispatcher: "Falcon's Team", creator: 'Ann Example', truck: 'Amy Driver + Zed Driver', team: true,
    amount: 2500.5, miles: 1000, at: undefined,
  });
});

test('a load is dated by its DEL date, not its delivery appointment', () => {
  const load = raceLoad({ ...order({ pay: 1400 }), delivery_time: '2026-10-04T15:00:00Z', delivery_appointment_time: '2026-10-13T15:00:00Z' });
  assert.equal(load.at.toISOString(), '2026-10-04T15:00:00.000Z', 'last week on Datatruck’s board, so last week here');
});

test('teams race the loads they dispatched; dispatchers race the loads they created', () => {
  const loads = loadsOf([
    order({ dispatcher: "Falcon's Team", creator: 'Ann Example', pay: 3000 }),
    order({ dispatcher: "Falcon's Team", creator: 'Bo Example', pay: 2000 }),
    order({ dispatcher: 'Cy Example', creator: 'Ann Example', pay: 1000 }),
    order({ dispatcher: '', creator: "Hawk's Team", pay: 500 }),
  ]);
  assert.deepEqual(byRank(standings(loads, { view: 'teams' })).map((r) => [r.name, r.gross]), [["Falcon's Team", 5000]]);
  assert.deepEqual(byRank(standings(loads, { view: 'dispatchers' })).map((r) => [r.name, r.gross]),
    [['Ann Example', 4000], ['Bo Example', 2000]], 'a team account is not a dispatcher');
});

test('teams: $15k a solo truck and $20k a team truck, ranked by the share reached', () => {
  const loads = loadsOf([
    // Ann's Team: one solo truck, 12k of 15k = 80%.
    order({ dispatcher: "Ann's Team", pay: 12000, driver: 'Solo One' }),
    // Bo's Team: one team truck, 18k of 20k = 90%, but less gross than Cy's.
    order({ dispatcher: "Bo's Team", pay: 18000, driver: 'Team A', teammate: 'Team B' }),
    // Cy's Team: two solo trucks, 20k of 30k = 67%, the most gross.
    order({ dispatcher: "Cy's Team", pay: 16000, driver: 'Solo Two' }),
    order({ dispatcher: "Cy's Team", pay: 4000, driver: 'Solo Three' }),
  ]);
  const race = standings(loads, { view: 'teams' });
  const byName = Object.fromEntries(race.racers.map((r) => [r.name, r]));
  assert.deepEqual(race.racers.map((r) => r.name), ["Ann's Team", "Bo's Team", "Cy's Team"], 'lanes stay alphabetical');
  assert.deepEqual(byRank(race).map((r) => r.name), ["Bo's Team", "Ann's Team", "Cy's Team"]);
  assert.equal(byName["Bo's Team"].target, 20000);
  assert.equal(byName["Cy's Team"].target, 30000);
  assert.equal(race.leadPct, 0.9);
  assert.equal(byName["Cy's Team"].gap, 18000 - 20000);
  assert.equal(race.maxTarget, 30000);
  assert.equal(race.rankBy, 'percent');
});

test('teams: a driver is named only once their truck has hit its target; the rest are lights', () => {
  const race = standings(loadsOf([
    order({ pay: 15000, driver: 'Hit Driver' }),
    order({ pay: 4000, driver: 'Short Driver' }),
    order({ pay: 19000, driver: 'Pair A', teammate: 'Pair B' }),
  ]), { view: 'teams' });
  const [team] = race.racers;
  assert.deepEqual(team.hitNames, ['Hit Driver']);
  assert.deepEqual(team.lights, [
    { team: true, hit: false }, { team: false, hit: true }, { team: false, hit: false },
  ]);
  const sent = JSON.stringify(race);
  assert.ok(!sent.includes('Short Driver') && !sent.includes('Pair A'), 'no name of a truck short of its target');
});

test('dispatchers: no target, ranked by gross, and no driver is ever named', () => {
  const race = standings(loadsOf([
    order({ creator: 'Ann Example', pay: 9000, driver: 'Hit Driver' }),
    order({ creator: 'Ann Example', pay: 9000, driver: 'Hit Driver' }),
    order({ creator: 'Bo Example', pay: 25000, driver: 'Big Driver' }),
    order({ creator: 'Cy Example', pay: 1000, driver: 'Small Driver' }),
  ]), { view: 'dispatchers' });
  assert.deepEqual(byRank(race).map((r) => [r.name, r.gross, r.gap]),
    [['Bo Example', 25000, 0], ['Ann Example', 18000, 7000], ['Cy Example', 1000, 24000]]);
  assert.equal(race.rankBy, 'gross');
  assert.equal(race.lead, 25000);
  for (const racer of race.racers) {
    assert.deepEqual(Object.keys(racer).sort(), ['gap', 'gross', 'id', 'loads', 'miles', 'name', 'rank', 'rpm']);
  }
  assert.ok(!/Driver/.test(JSON.stringify(race)), 'no driver name, not even one past $15k');
});

test("the other MC's dispatcher is off the dispatchers' board; their loads still count for the team", () => {
  const loads = loadsOf([
    order({ dispatcher: "Falcon's Team", creator: 'Ayzik  Dinosour', pay: 7000 }),
    order({ dispatcher: "Falcon's Team", creator: 'Ann Example', pay: 1000 }),
  ]);
  assert.deepEqual(standings(loads, { view: 'dispatchers' }).racers.map((r) => r.name), ['Ann Example']);
  assert.equal(standings(loads, { view: 'teams' }).racers[0].gross, 8000);
});

test('top RPM needs two loads; an empty week has no leader', () => {
  const race = standings(loadsOf([
    order({ creator: 'Ann Example', pay: 5000, miles: 1000 }),
    order({ creator: 'Bo Example', pay: 3000, miles: 1000 }),
    order({ creator: 'Bo Example', pay: 3000, miles: 1000 }),
  ]), { view: 'dispatchers' });
  assert.equal(race.topRpmId, 'Bo Example', "Ann's one load is faster but does not count");
  assert.deepEqual(standings([], { view: 'teams' }), {
    racers: [], lead: 0, leadPct: 0, maxTarget: 0, topRpmId: null, rankBy: 'percent',
  });
  assert.deepEqual(standings([], { view: 'dispatchers' }), { racers: [], lead: 0, topRpmId: null, rankBy: 'gross' });
});

test('the week runs Monday to Monday in Chicago, as on Datatruck’s board, across the clock changes', () => {
  const week = raceWeek({ now: new Date('2026-10-14T18:00:00Z') });
  assert.equal(week.start.toISOString(), '2026-10-12T05:00:00.000Z');
  assert.equal(week.end.toISOString(), '2026-10-19T05:00:00.000Z', 'the Monday after is the next week');
  assert.equal(week.label, 'Oct 12–18');
  assert.equal(week.day, 3);
  assert.equal(week.dayName, 'Wed');

  const sundayNight = raceWeek({ now: new Date('2026-10-12T04:30:00Z') });
  assert.equal(sundayNight.start.toISOString(), '2026-10-05T05:00:00.000Z', '11:30 pm Sunday in Chicago');
  assert.equal(sundayNight.day, 7);

  const fallBack = raceWeek({ now: new Date('2026-11-01T12:00:00Z') });
  assert.equal(fallBack.end.toISOString(), '2026-11-02T06:00:00.000Z', 'ends at midnight CST');
  assert.equal(fallBack.label, 'Oct 26 – Nov 1');
});
