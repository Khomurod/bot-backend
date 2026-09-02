/**
 * Route Control — database façade.
 *
 * RE-EXPORT ONLY. `database/db.js` spreads this module and the Route Control
 * service package imports it, so the path stays the stable public seam while
 * the queries live in focused modules:
 *
 *   ./routeControl/assignments.js     the route rows and their lifecycle
 *   ./routeControl/screenshots.js     one screenshot per assignment (UPSERT)
 *   ./routeControl/monitorState.js    what the monitor sweeps and writes back
 *   ./routeControl/driverMessages.js  which Telegram message carries the route
 *   ./routeControl/monitorEvents.js   the per-assignment audit trail
 *
 * Nothing but re-exports belongs here — see CLAUDE.md → Module design.
 */
const assignments = require('./routeControl/assignments');
const screenshots = require('./routeControl/screenshots');
const monitorState = require('./routeControl/monitorState');
const driverMessages = require('./routeControl/driverMessages');
const monitorEvents = require('./routeControl/monitorEvents');

module.exports = {
  ...assignments,
  ...screenshots,
  ...monitorState,
  ...driverMessages,
  ...monitorEvents,
};
