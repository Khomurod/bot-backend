'use strict';

/**
 * Purge every module that captures the trailer monitor's collaborators.
 *
 * The monitor tests install fakes by writing into require.cache (database/db,
 * vision, geocode, the semantic verifier) and then re-requiring the monitor.
 * That only works if EVERY module which destructured those collaborators at
 * require time is purged too — otherwise it stays bound to a previous test's
 * fake and quietly records into the wrong state, which reads as a mysterious
 * "event not registered" failure several tests later.
 *
 * Purging the whole services/trailerMonitor DIRECTORY rather than a hand-written
 * list is deliberate: the list silently went stale the moment the monitor was
 * split into stage modules, and it would go stale again on the next split.
 */
const fs = require('node:fs');
const path = require('node:path');

const SERVICES = path.resolve(__dirname, '../../services');
const MONITOR_PACKAGE = path.join(SERVICES, 'trailerMonitor');

/**
 * @param {string[]} extraPaths absolute paths to purge as well (the monitor
 *   entry point, the context service, the verifier, master-list detection …).
 */
function purgeTrailerMonitorModules(extraPaths = []) {
  for (const file of fs.readdirSync(MONITOR_PACKAGE)) {
    if (file.endsWith('.js')) delete require.cache[path.join(MONITOR_PACKAGE, file)];
  }
  for (const p of extraPaths) delete require.cache[p];
}

module.exports = { purgeTrailerMonitorModules, MONITOR_PACKAGE };
