'use strict';

/**
 * Trailer Tracking (Beta) — data access.
 *
 * Re-export only. The implementation lives in ./trailerTracking/, one module per
 * table it owns; see that package's index for the layering and the correctness
 * notes for this ledger.
 *
 * This file exists so `require('./trailers')` and db.js keep working unchanged.
 * Do not add code here — add it to the module in ./trailerTracking that owns the
 * table, and export it from ./trailerTracking/index.js.
 */
module.exports = require('./trailerTracking');
