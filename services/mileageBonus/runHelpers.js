/**
 * Pure helpers for the mileage bonus run.
 *
 * Extracted from services/mileageBonusService.js to keep that orchestrator
 * under the file-size limit, following the services/routeControl/* pattern:
 * decisions and shaping live here as plain functions, while the database
 * writes and Telegram sends stay in the orchestrator. Nothing in this module
 * performs I/O, so every rule below is testable directly.
 */
'use strict';

const { DateTime } = require('luxon');
const { randomUUID } = require('node:crypto');

const { toMiles, INCLUDE_EMPTY_MILES } = require('../mileageBonusConstants');

/** An Error carrying the API code/status the routes surface to the admin panel. */
function serviceError(code, message, status = 400) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  return err;
}

/** Unique key for one run attempt, so concurrent runs can never share a lease. */
function makeRunKey(trigger, mode) {
  return `${trigger}:${mode}:${DateTime.now().toUTC().toFormat('yyyyLLdd-HHmmss')}:${randomUUID()}`;
}

/** Exponential backoff for a failed notification, capped at an hour. */
function retryDelayMinutes(attemptCount) {
  return Math.min(60, 5 * (2 ** Math.max(0, Number(attemptCount || 1) - 1)));
}

/** First usable timestamp on a Datatruck order, in its documented precedence. */
function getOrderPickupIso(order) {
  return order.pickup_time
    || order.pickup_appointment_time
    || order.delivery_time
    || order.created_datetime
    || null;
}

/** Billable miles for one order: loaded, plus empty only when the program counts it. */
function tripMiles(order) {
  const trip = order.trip || {};
  const loaded = toMiles(trip.mile ?? order.total_miles);
  const empty = INCLUDE_EMPTY_MILES ? toMiles(trip.empty_mile) : 0;
  return loaded + empty;
}

module.exports = {
  serviceError,
  makeRunKey,
  retryDelayMinutes,
  getOrderPickupIso,
  tripMiles,
};
