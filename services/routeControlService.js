/**
 * Route Control service — COMPATIBILITY FAÇADE.
 *
 * The implementation lives in `services/routeControl/` (see that package's
 * index.js for the map of modules). This file exists only so the long-standing
 * import path keeps working:
 *
 *     require('../services/routeControlService')
 *
 * for `bot/routeControlHandlers.js`, `server/routes/routeControlRoutes.js`,
 * `index.js` and the tests. It re-exports the package façade verbatim and holds
 * no logic of its own — add new code to a focused module inside
 * `services/routeControl/`, and export it from that package's index.js.
 *
 * Prefer `require('./routeControl')` in new code. Nothing inside the
 * routeControl package may require THIS file (that would be a cycle).
 */
module.exports = require('./routeControl');
