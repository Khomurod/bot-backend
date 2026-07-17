/**
 * Trailer master-list data access — package façade.
 *
 * Re-export only. database/db.js spreads this so `require('./db')` callers reach
 * every master-list helper; add new code to a focused module in this package and
 * export it here (the services/routeControl -> routeControlService pattern).
 *
 * Modules:
 *   masterTrailers.js  the trailers master list + the ONLY restricted creation path
 *   aliases.js         aliases + the authoritative resolve-never-create lookup
 *   mentions.js        the unmatched Telegram mention review queue
 *   importBatches.js   master-list snapshot staging (review before anything applies)
 *   reconciliation.js  applying approved decisions, atomically
 */
'use strict';

const masterTrailers = require('./masterTrailers');
const aliases = require('./aliases');
const mentions = require('./mentions');
const importBatches = require('./importBatches');
const reconciliation = require('./reconciliation');

module.exports = {
  ...masterTrailers,
  ...aliases,
  ...mentions,
  ...importBatches,
  ...reconciliation,
};
