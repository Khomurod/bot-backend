'use strict';

/**
 * Home-time policy violations, decided by Wenze from its own home/road record
 * (owner, 11 November 2026 — the Bitrix script that used to decide is gone).
 * PURE.
 *
 * THE POLICY: a company driver is on the road at least 28 days, then home at
 * most 4 days (lib/homeTime/violations.js POLICY). A driver may have their own
 * rule ("3 weeks on the road, 3 days home") — an exception set on the Home Time
 * page — which replaces either number while it is valid.
 *
 *   came home early   the road leg that ended in this home stay was shorter
 *                     than the allowed road days
 *   overstayed        this home stay has lasted MORE than the allowed home days
 *
 * WHAT A HOME STAY IS. The record comes from the Dispatcher Board (only HOME is
 * home) and the drivers' own messages, one row per cycle (road → home →
 * back on the road). The Board flips HOME and back within hours for reasons
 * that are not a driver's week, so the 12-hour rule (lib/homeTime/
 * briefVisits.js, owner 27 November 2026) reads the record as VISITS:
 *
 *   - a stay under MIN_STAY_HOURS is no stay (a flap), and the road around it
 *     is one road leg; a stay Wenze already folded into its trip is the same;
 *   - a road segment under MIN_STAY_HOURS between two stays is no trip: the
 *     two are ONE visit, its home days counted from the FIRST arrival, and
 *     only that first arrival can have "come home early";
 *   - a visit counts once it has lasted MIN_STAY_HOURS (or closed after that);
 *   - its road leg starts where the previous visit ended — or, with none
 *     before it in the record, at the earliest road start of the flaps before
 *     it (a flap at the start of the record must not cut the leg either);
 *   - days are complete 24-hour periods (`wholeDays`), exactly as the road
 *     bonus counts them, so the bonus and the fine never disagree.
 *
 * NOT JUDGED: owner-operators and lease drivers (the policy is the company's),
 * a stay that began before Wenze started deciding (no backlog — owner), and a
 * stay linked to an APPROVED home-time request (agreed — the old "Agreed"
 * stage). A road leg whose start is not known says nothing about "early".
 */

const { DateTime } = require('luxon');
const { POLICY } = require('./violations');
const { MIN_STAY_HOURS, HOUR_MS, wholeDays } = require('./briefVisits');

const TZ = 'America/Chicago';

const ms = (value) => (value ? new Date(value).getTime() : NaN);
const isCompany = (driverType) => String(driverType || '').toLowerCase() === 'company_driver';
const isApproved = (c) => String(c.linkedRequestStatus || '').toLowerCase() === 'approved';

/** The rule for this driver on this date: their exception where it sets a number, else the policy. */
function ruleFor(exception, onDate) {
  const valid = exception && (!exception.validUntil || String(onDate) <= String(exception.validUntil));
  return {
    roadDays: valid && exception.roadDays != null ? Number(exception.roadDays) : POLICY.roadDays,
    homeDays: valid && exception.homeDays != null ? Number(exception.homeDays) : POLICY.homeDays,
    exception: Boolean(valid && (exception.roadDays != null || exception.homeDays != null)),
  };
}

/**
 * One driver group's record read as home VISITS (see the header).
 *
 * @param {object[]} cycles  rows, any order:
 *   { roadStartedAt, homeArrivedAt, returnToRoadAt, folded, linkedRequestStatus, driverType }
 * @param {number} now  epoch ms — the end of a visit still going on
 * @returns {{arrived:number, end:number, closedAt:number|null, roadStart:number|null,
 *   approved:boolean, driverType:string|null}[]}
 */
function homeVisits(cycles, now) {
  const rows = [...(cycles || [])].filter((c) => Number.isFinite(ms(c.homeArrivedAt)))
    .sort((a, b) => ms(a.homeArrivedAt) - ms(b.homeArrivedAt));
  const brief = MIN_STAY_HOURS * HOUR_MS;
  const visits = [];
  // The earliest road start of the flaps since the last visit: the trip they
  // interrupted, which the next visit's road leg is measured from when no
  // visit precedes it in the record.
  let carry = null;
  for (const c of rows) {
    const arrived = ms(c.homeArrivedAt);
    const returned = ms(c.returnToRoadAt);
    const closedAt = Number.isFinite(returned) ? returned : null;
    const end = closedAt ?? now;
    const ownRoadStart = Number.isFinite(ms(c.roadStartedAt)) ? ms(c.roadStartedAt) : null;
    const prev = visits[visits.length - 1];

    // A stay Wenze already folded into its road trip: the leg goes on.
    if (c.folded) {
      if (ownRoadStart != null && (carry == null || ownRoadStart < carry)) carry = ownRoadStart;
      continue;
    }
    // Back home within hours of leaving the previous visit: the same visit,
    // however long this part lasts — exactly as the record is written, where
    // the arrival reopens the stay before it (services/homeTime/briefVisits.js).
    if (prev && prev.closedAt != null && arrived >= prev.closedAt && arrived - prev.closedAt < brief) {
      prev.end = end;
      prev.closedAt = closedAt;
      prev.approved = prev.approved || isApproved(c);
      carry = null;
      continue;
    }
    // Too short to be a stay (or too new to count yet): a flap.
    if (end - arrived < brief) {
      if (ownRoadStart != null && (carry == null || ownRoadStart < carry)) carry = ownRoadStart;
      continue;
    }
    visits.push({
      arrived,
      end,
      closedAt,
      roadStart: prev ? prev.closedAt : (carry ?? ownRoadStart),
      approved: isApproved(c),
      driverType: c.driverType || null,
    });
    carry = null;
  }
  return visits;
}

/**
 * @param {object[]} cycles  one driver group's rows, any order (see homeVisits)
 * @param {object} opts
 * @param {number} opts.now           epoch ms
 * @param {number} opts.since         epoch ms — only stays that began at or after it are judged
 * @param {object|null} [opts.exception]  { roadDays, homeDays, validUntil }
 * @returns {{homeFrom: string, homeArrivedAt: string, violations: string[], roadDays: number|null,
 *   homeDays: number, rule: object}[]}
 */
function violationsFor(cycles, { now, since, exception = null }) {
  const out = [];
  for (const v of homeVisits(cycles, now)) {
    if (v.arrived < since || !isCompany(v.driverType) || v.approved) continue;
    const homeFrom = DateTime.fromMillis(v.arrived, { zone: TZ }).toISODate();
    const rule = ruleFor(exception, homeFrom);
    const roadDays = v.roadStart != null && v.roadStart <= v.arrived ? wholeDays(v.roadStart, v.arrived) : null;
    const homeDays = wholeDays(v.arrived, v.end);
    const violations = [];
    if (roadDays != null && roadDays < rule.roadDays) violations.push('early');
    if (homeDays > rule.homeDays) violations.push('overstay');
    if (violations.length) {
      out.push({
        homeFrom, homeArrivedAt: new Date(v.arrived).toISOString(), violations, roadDays, homeDays, rule,
      });
    }
  }
  return out;
}

module.exports = {
  MIN_STAY_HOURS, homeVisits, violationsFor, ruleFor, isCompany,
};
