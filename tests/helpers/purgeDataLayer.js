/**
 * Purge every `database/**` module from require.cache.
 *
 * The data layer destructures `{ pool, query }` from database/pool at REQUIRE
 * time, so a test that repoints the shared pool at a throwaway database must
 * also drop every module that already captured the old `query` — otherwise that
 * module keeps writing to the real database and the test silently passes
 * against the wrong data.
 *
 * This exists because listing those modules by hand rots. When
 * database/homeTime.js was split into database/homeTime/*.js, the new modules
 * were absent from one suite's hand-written reload list, kept the production
 * pool, and eleven assertions failed with no obvious cause. Walking the
 * directory cannot miss a file that did not exist when the list was written —
 * the same reasoning behind the recursive purge inside trailerPgHarness.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DATABASE_DIR = path.resolve(__dirname, '../../database');
/**
 * database/pool.js is the STUB TARGET, never a capturer of `query`. Purging it
 * would delete the throwaway-database override the caller just installed and
 * hand the real pool back — so it is excluded, which also makes this helper
 * safe to call either side of installing the stub.
 */
const POOL_PATH = path.join(DATABASE_DIR, 'pool.js');

/** Absolute paths of every .js file under database/, recursively. */
function dataLayerModulePaths(dir = DATABASE_DIR) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...dataLayerModulePaths(full));
    else if (entry.name.endsWith('.js') && full !== POOL_PATH) found.push(full);
  }
  return found;
}

/**
 * Drop the whole data layer from require.cache, plus any extra ABSOLUTE paths
 * (services/routes that captured `query` transitively).
 *
 * Extras are absolute paths, not specifiers: a specifier would have to be
 * resolved relative to the caller, and `module.require` carries no `.resolve`,
 * so callers pass `require.resolve('…')` themselves.
 *
 * @param {string[]} [extraPaths] e.g. [require.resolve('../server/routes/x')]
 * @returns {string[]} every path purged, for a symmetric t.after()
 */
function purgeDataLayer(extraPaths = []) {
  const paths = [...dataLayerModulePaths(), ...extraPaths];
  for (const p of paths) delete require.cache[p];
  return paths;
}

module.exports = { DATABASE_DIR, POOL_PATH, dataLayerModulePaths, purgeDataLayer };
