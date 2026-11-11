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
 * back on the road). A Board flipping HOME and back within hours makes cycles
 * of a few hours; such a stay is NOT a home stay (`MIN_STAY_HOURS`), and the
 * road around it is one road leg. So:
 *
 *   - a stay counts once it has lasted MIN_STAY_HOURS (or closed after that);
 *   - its road leg starts where the previous COUNTED stay ended — or, with
 *     none before it in the record, at the cycle's own road start;
 *   - days are whole days (24 h), like `home_days` and the efficiency report.
 *
 * NOT JUDGED: owner-operators and lease drivers (the policy is the company's),
 * a stay that began before Wenze started deciding (no backlog — owner), and a
 * stay linked to an APPROVED home-time request (agreed — the old "Agreed"
 * stage). A road leg whose start is not known says nothing about "early".
 */

const { DateTime } = require('luxon');
const { POLICY } = require('./violations');

const MIN_STAY_HOURS = 12;
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const TZ = 'America/Chicago';

const ms = (value) => (value ? new Date(value).getTime() : NaN);
const isCompany = (driverType) => String(driverType || '').toLowerCase() === 'company_driver';

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
 * @param {object[]} cycles  one driver group's rows, any order:
 *   { roadStartedAt, homeArrivedAt, returnToRoadAt, linkedRequestStatus, driverType, driverName }
 * @param {object} opts
 * @param {number} opts.now           epoch ms
 * @param {number} opts.since         epoch ms — only stays that began at or after it are judged
 * @param {object|null} [opts.exception]  { roadDays, homeDays, validUntil }
 * @returns {{homeFrom: string, homeArrivedAt: string, violations: string[], roadDays: number|null,
 *   homeDays: number, rule: object}[]}
 */
function violationsFor(cycles, { now, since, exception = null }) {
  const rows = [...(cycles || [])].filter((c) => Number.isFinite(ms(c.homeArrivedAt)))
    .sort((a, b) => ms(a.homeArrivedAt) - ms(b.homeArrivedAt));
  const out = [];
  let lastCountedEnd = null;
  for (const c of rows) {
    const arrived = ms(c.homeArrivedAt);
    const end = Number.isFinite(ms(c.returnToRoadAt)) ? ms(c.returnToRoadAt) : now;
    const counted = end - arrived >= MIN_STAY_HOURS * HOUR;
    const roadStart = lastCountedEnd ?? (Number.isFinite(ms(c.roadStartedAt)) ? ms(c.roadStartedAt) : null);
    if (!counted) continue; // a flap: the road leg goes on through it
    lastCountedEnd = Number.isFinite(ms(c.returnToRoadAt)) ? ms(c.returnToRoadAt) : null;
    if (arrived < since || !isCompany(c.driverType)) continue;
    if (String(c.linkedRequestStatus || '').toLowerCase() === 'approved') continue;

    const homeFrom = DateTime.fromMillis(arrived, { zone: TZ }).toISODate();
    const rule = ruleFor(exception, homeFrom);
    const roadDays = roadStart != null && roadStart <= arrived ? Math.floor((arrived - roadStart) / DAY) : null;
    const homeDays = Math.floor((end - arrived) / DAY);
    const violations = [];
    if (roadDays != null && roadDays < rule.roadDays) violations.push('early');
    if (homeDays > rule.homeDays) violations.push('overstay');
    if (violations.length) {
      out.push({
        homeFrom, homeArrivedAt: new Date(arrived).toISOString(), violations, roadDays, homeDays, rule,
      });
    }
  }
  return out;
}

module.exports = {
  MIN_STAY_HOURS, violationsFor, ruleFor, isCompany,
};
