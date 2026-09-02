/**
 * Fuel Monitor tuning constants and the two cheap message filters.
 *
 * Every number the fuel poller reasons with lives here so the operational
 * behaviour is readable in one place — the notify radius, the ETA-based
 * scheduling knobs, and the poll-gap floor/ceiling that keep the poller cheap
 * when the truck is far away and tight when it is nearly there.
 *
 * Split out of services/fuelStopAlertService.js, which re-exports the public
 * surface so existing importers are unchanged.
 */

const POLL_INTERVAL_MS = 150 * 1000; // due-scan cadence (cheap; most ticks no-op).

const ALERT_MAX_BATCH = 10;

// Notify the driver when the truck comes within 50 miles of the assigned fuel
// stop (was 10) so they get the heads-up with enough road left to plan the stop.
const DEFAULT_RADIUS_MILES = 50;

// ETA-based scheduling knobs. We estimate when the truck will reach the radius
// from straight-line distance ÷ speed (no extra routing API), then wake up
// ~PRE_ARRIVAL_LEAD_MIN before that, polling tightly only near arrival.
const AVG_SPEED_MPH = 50;          // assumed when the truck is stopped / no speed

const ROAD_FACTOR = 1.2;           // roads are longer than straight line

const PRE_ARRIVAL_LEAD_MIN = 20;   // re-verify ~20 min before predicted arrival

const NEAR_GAP_MIN = 3;            // tight polling once close to the boundary

const MIN_GAP_MIN = 2;             // never schedule sooner than this

const MAX_GAP_MIN = 360;           // never sleep longer than 6h between checks

const RETRY_GAP_MIN = 5;           // truck offline / no GPS → retry soon

const SPEED_MIN_MPH = 5;

const SPEED_MAX_MPH = 75;

// Admin "Refresh" re-scans fuel messages the bot saw in this recent window and
// retries any whose live detection failed. (The Telegram Bot API cannot fetch
// older history, so the inbox table is the only record we can re-scan.)
const REFRESH_WINDOW_HOURS = 12;

const REFRESH_MAX_ROWS = 50;

// The ONLY trigger: the Fuel Monitoring team always opens their instruction
// with the "FUEL MONITORING DEPARTMENT" banner (surrounded by emojis). We gate
// strictly on this header so ordinary chatter and load-location updates (which
// also contain addresses/maps links) are never mistaken for a fuel stop.
const FUEL_HEADER_RE = /fuel\s*monitoring\s*department/i;

// Loose US street-address shape: "<number> <words>, <city>, ST <zip?>" — used
// only to pull the address OUT of a message already confirmed by the header.
const ADDRESS_RE = /\d{1,6}\s+[A-Za-z0-9 .'\-/]+,\s*[A-Za-z .'\-]+,?\s*[A-Z]{2}\b(?:[, ]+\d{5}(?:-\d{4})?)?/;

module.exports = {
  POLL_INTERVAL_MS,
  ALERT_MAX_BATCH,
  DEFAULT_RADIUS_MILES,
  AVG_SPEED_MPH,
  ROAD_FACTOR,
  PRE_ARRIVAL_LEAD_MIN,
  NEAR_GAP_MIN,
  MIN_GAP_MIN,
  MAX_GAP_MIN,
  RETRY_GAP_MIN,
  SPEED_MIN_MPH,
  SPEED_MAX_MPH,
  REFRESH_WINDOW_HOURS,
  REFRESH_MAX_ROWS,
  FUEL_HEADER_RE,
  ADDRESS_RE,
};
