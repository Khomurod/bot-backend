'use strict';

/**
 * Gross Grand Prix standings. Pure: Datatruck orders in, a ranked race out.
 *
 * Each racer is a dispatcher, or a dispatch team: a dispatcher name that
 * contains the word "team" races on the Teams display, every other name on
 * the Dispatchers display. Gross is the order's `load_pay`. A racer's target
 * is $15,000 for every solo truck it dispatched this week and $20,000 for
 * every team truck, and the race is ranked by the share of that target
 * reached. Ported from the race display the owner approved (October 2026).
 *
 * ONE DEPARTURE FROM THE DESIGN, ON PURPOSE: the standings are served to a
 * public page, so a truck that has not hit its target goes out as a light
 * only, with no driver name. A driver's name is sent once their truck has hit
 * the weekly target, which is exactly when the race announces it.
 */

const SOLO_TARGET = 15000;
const TEAM_TARGET = 20000;
const TEAM_WORD = 'team';

/**
 * One Datatruck order as a race load, or null when it does not count: no
 * dispatcher, cancelled, or no delivery date. A null still matters to the
 * caller, which must forget an order it counted before.
 */
function raceLoad(order) {
  const trip = order?.trip || (Array.isArray(order?.trips) ? order.trips[0] : null) || {};
  const first = String(trip.driver__full_name || '').trim();
  const second = String(trip.team_driver__full_name || '').trim();
  const name = String(order?.dispatcher__full_name || '').trim();
  const at = new Date(order?.delivery_appointment_time || order?.created_datetime || NaN);
  if (!name || /^cancel+ed$/i.test(String(order?.status || '')) || Number.isNaN(at.getTime())) return null;
  return {
    name,
    truck: first ? (second ? [first, second].sort().join(' + ') : first) : '',
    team: Boolean(first && second),
    amount: Number.parseFloat(order.load_pay) || 0,
    miles: Number.parseFloat(order.total_miles) || 0,
    at,
  };
}

function racersFor(loads, view, teamWord) {
  const word = teamWord.toLowerCase();
  const byName = new Map();
  for (const load of loads) {
    if ((view === 'teams') !== load.name.toLowerCase().includes(word)) continue;
    let racer = byName.get(load.name);
    if (!racer) {
      racer = { name: load.name, gross: 0, loads: 0, miles: 0, trucks: new Map() };
      byName.set(load.name, racer);
    }
    racer.gross += load.amount;
    racer.loads += 1;
    racer.miles += load.miles;
    if (load.truck) {
      let truck = racer.trucks.get(load.truck);
      if (!truck) {
        truck = { name: load.truck, team: false, gross: 0 };
        racer.trucks.set(load.truck, truck);
      }
      truck.gross += load.amount;
      if (load.team) truck.team = true;
    }
  }
  return [...byName.values()];
}

/**
 * @param {Array<object>} loads raceLoad() results for this week
 * @returns {{ racers: Array<object>, lead: number, leadPct: number,
 *             maxTarget: number, topRpmId: string|null, rankBy: string }}
 *   `racers` in alphabetical order (a stable order for the lanes), each with
 *   its `rank`.
 */
function standings(loads, {
  view, rankBy = 'percent', soloTarget = SOLO_TARGET, teamTarget = TEAM_TARGET, teamWord = TEAM_WORD,
} = {}) {
  const racers = racersFor(loads, view, teamWord)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((racer) => {
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

  const key = rankBy === 'gross' ? 'gross' : 'pct';
  const ranked = [...racers].sort((a, b) => b[key] - a[key] || b.gross - a.gross || a.name.localeCompare(b.name));
  const leader = ranked[0];
  let topRpm = null;
  ranked.forEach((racer, i) => {
    racer.rank = i + 1;
    racer.gap = leader.gross - racer.gross;
    racer.gapPct = leader.pct - racer.pct;
    if (racer.loads >= 2 && (!topRpm || racer.rpm > topRpm.rpm)) topRpm = racer;
  });

  return {
    racers,
    lead: leader ? leader.gross : 0,
    leadPct: leader ? leader.pct : 0,
    maxTarget: Math.max(0, ...racers.map((racer) => racer.target)),
    topRpmId: topRpm ? topRpm.id : null,
    rankBy: key === 'gross' ? 'gross' : 'percent',
  };
}

module.exports = { raceLoad, standings, SOLO_TARGET, TEAM_TARGET };
