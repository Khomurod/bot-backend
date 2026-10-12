'use strict';

/**
 * Gross Grand Prix standings. Pure: Datatruck orders in, a ranked race out.
 *
 * WHICH LOADS COUNT (the owner, 12 October 2026): a load that was CREATED,
 * PICKED UP and DELIVERED inside the race week — its `created_datetime`, its PU
 * date (`pickup_time`) and its DEL date (`delivery_time`) all between Monday
 * 00:00 and the next Monday 00:00 — and that is dispatched: not booked
 * (planned, no driver yet) and not cancelled. Gross is the order's `load_pay`.
 *
 * So a load that started before Monday counts in no week: not last week, where
 * it was not delivered, and not this one, where it was not created. That is
 * deliberate, and it is why the teams' totals are lower than Datatruck's driver
 * board, which counts every dispatched load by its DEL date alone.
 *
 * WHO A LOAD COUNTS FOR depends on the display:
 *   - teams (/dispatchteam): the load's dispatcher, and only names with the
 *     word "team" race. A team's target is $15,000 for every solo truck it ran
 *     this week and $20,000 for every team truck, and the race is ranked by
 *     the share of it reached. The page is public, so a truck short of its
 *     target goes out as a light with no driver's name; the name is sent once
 *     the truck hits the target, which is when the race announces it.
 *   - dispatchers (/dispatch): whoever CREATED the load in Datatruck. No
 *     target: ranked by gross alone, and no driver is ever named.
 */

const SOLO_TARGET = 15000;
const TEAM_TARGET = 20000;
const TEAM_WORD = 'team';
const NOT_COUNTED = /^(booked|cancell?ed)$/i;

// Off the dispatchers' board at the owner's request (12 October 2026): works
// for the company's other MC. Their loads still count for a team that ran them.
const NOT_RACING = new Set(['ayzik dinosour']);

const plain = (name) => String(name || '').trim().replace(/\s+/g, ' ');
const NOON = 12 * 3600e3;

/**
 * A PU or DEL date as an instant. Datatruck sends most as real times at the
 * stop ("2026-10-12T15:00:00Z"), but a date typed without a time arrives as
 * midnight UTC — 7 pm the day before in Chicago, so a Monday pickup would read
 * as Sunday's — and a bare date ("10/12/2026", "2026-10-12") has no zone at
 * all. Each of those is a calendar day, read as noon UTC of that day: the same
 * day in Chicago. (A real stop at exactly 00:00:00 UTC is taken as a date too;
 * on 12 October 2026 that hour was three times as common as its neighbours.)
 */
function stopDate(value) {
  const text = String(value || '').trim();
  let day = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (day) return new Date(Date.UTC(+day[3], +day[1] - 1, +day[2]) + NOON);
  day = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (day) return new Date(Date.UTC(+day[1], +day[2] - 1, +day[3]) + NOON);
  const at = new Date(text || NaN);
  return at.getTime() % 86400e3 === 0 ? new Date(at.getTime() + NOON) : at;
}
const isTeam = (name) => name.toLowerCase().includes(TEAM_WORD);

/**
 * One Datatruck order as a race load, or null when it can never count: booked,
 * cancelled, or missing its created, PU or DEL date. A null still matters to
 * the caller, which must forget an order it counted before. Whether a load
 * counts THIS week is countsInWeek().
 */
function raceLoad(order) {
  const at = stopDate(order?.delivery_time);
  const created = new Date(order?.created_datetime || NaN);
  const pickedUp = stopDate(order?.pickup_time);
  if (NOT_COUNTED.test(String(order?.status || '').trim())) return null;
  if ([at, created, pickedUp].some((date) => Number.isNaN(date.getTime()))) return null;
  const trip = order.trip || (Array.isArray(order.trips) ? order.trips[0] : null) || {};
  const first = plain(trip.driver__full_name);
  const second = plain(trip.team_driver__full_name);
  return {
    dispatcher: plain(order.dispatcher__full_name),
    creator: plain(order.created_by__full_name),
    truck: first ? (second ? [first, second].sort().join(' + ') : first) : '',
    team: Boolean(first && second),
    amount: Number.parseFloat(order.load_pay) || 0,
    miles: Number.parseFloat(order.total_miles) || 0,
    at,
    created,
    pickedUp,
  };
}

/** The week's rule: created, picked up AND delivered inside `week`. */
function countsInWeek(load, week) {
  return [load.created, load.pickedUp, load.at].every((date) => date >= week.start && date < week.end);
}

/** Racers keyed by name, in alphabetical order (a stable order for the lanes). */
function tally(loads, keyOf) {
  const byName = new Map();
  for (const load of loads) {
    const name = keyOf(load);
    if (!name) continue;
    let racer = byName.get(name);
    if (!racer) {
      racer = { name, gross: 0, loads: 0, miles: 0, trucks: new Map() };
      byName.set(name, racer);
    }
    racer.gross += load.amount;
    racer.loads += 1;
    racer.miles += load.miles;
    if (load.truck) {
      const truck = racer.trucks.get(load.truck) || { name: load.truck, team: false, gross: 0 };
      truck.gross += load.amount;
      if (load.team) truck.team = true;
      racer.trucks.set(load.truck, truck);
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Ranks `racers` in place by `key`, and names the fastest with two loads or more. */
function rank(racers, key) {
  const order = [...racers].sort((a, b) => b[key] - a[key] || b.gross - a.gross || a.name.localeCompare(b.name));
  const leader = order[0];
  let topRpm = null;
  order.forEach((racer, i) => {
    racer.rank = i + 1;
    racer.gap = leader.gross - racer.gross;
    if (racer.loads >= 2 && (!topRpm || racer.rpm > topRpm.rpm)) topRpm = racer;
  });
  return { leader, topRpmId: topRpm ? topRpm.id : null };
}

function teamStandings(loads, { soloTarget = SOLO_TARGET, teamTarget = TEAM_TARGET } = {}) {
  const racers = tally(loads, (load) => (isTeam(load.dispatcher) ? load.dispatcher : '')).map((racer) => {
    const trucks = [...racer.trucks.values()].sort((a, b) => b.gross - a.gross);
    const hit = (truck) => truck.gross >= (truck.team ? teamTarget : soloTarget);
    const target = trucks.reduce((sum, truck) => sum + (truck.team ? teamTarget : soloTarget), 0);
    return {
      id: racer.name,
      name: racer.name,
      gross: racer.gross,
      loads: racer.loads,
      miles: racer.miles,
      target,
      pct: target ? racer.gross / target : 0,
      rpm: racer.miles ? racer.gross / racer.miles : 0,
      lights: trucks.map((truck) => ({ team: truck.team, hit: hit(truck) })),
      hitNames: trucks.filter(hit).map((truck) => truck.name),
    };
  });
  const { leader, topRpmId } = rank(racers, 'pct');
  racers.forEach((racer) => { racer.gapPct = leader.pct - racer.pct; });
  return {
    racers,
    lead: leader ? leader.gross : 0,
    leadPct: leader ? leader.pct : 0,
    maxTarget: Math.max(0, ...racers.map((racer) => racer.target)),
    topRpmId,
    rankBy: 'percent',
  };
}

function dispatcherStandings(loads) {
  const counts = (name) => name && !isTeam(name) && !NOT_RACING.has(name.toLowerCase());
  const racers = tally(loads, (load) => (counts(load.creator) ? load.creator : '')).map((racer) => ({
    id: racer.name,
    name: racer.name,
    gross: racer.gross,
    loads: racer.loads,
    miles: racer.miles,
    rpm: racer.miles ? racer.gross / racer.miles : 0,
  }));
  const { leader, topRpmId } = rank(racers, 'gross');
  return { racers, lead: leader ? leader.gross : 0, topRpmId, rankBy: 'gross' };
}

/**
 * @param {Array<object>} loads raceLoad() results for this week
 * @param {{ view: 'teams'|'dispatchers' }} options
 * @returns {object} `racers` in alphabetical order, each with its `rank`.
 */
function standings(loads, { view, ...targets } = {}) {
  return view === 'teams' ? teamStandings(loads, targets) : dispatcherStandings(loads);
}

module.exports = { raceLoad, countsInWeek, standings, SOLO_TARGET, TEAM_TARGET };
