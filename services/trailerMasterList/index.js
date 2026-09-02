/**
 * Trailer master-list services — package façade.
 *
 * Re-export only. Add new code to a focused module here and export it from this
 * file (the services/routeControl -> routeControlService pattern).
 *
 * Modules:
 *   normalize.js    PURE unit-number normalization, confusable folding, similarity
 *   reconcile.js    PURE reconciliation decision engine (the four groups)
 *   extraction.js   the Gemini vision prompt + response normalization, per image
 *   imageIngest.js  memory-safe multi-image ingest from temp disk
 *   detection.js    the Telegram detection -> master-list resolution seam
 *   snapshot.js     orchestration: upload -> staged snapshot -> reconciliation view
 */
'use strict';

const normalize = require('../../lib/trailers/normalize');
const reconcile = require('./reconcile');
const extraction = require('./extraction');
const imageIngest = require('./imageIngest');
const detection = require('./detection');
const snapshot = require('./snapshot');

module.exports = {
  ...normalize,
  ...reconcile,
  ...extraction,
  ...imageIngest,
  ...detection,
  ...snapshot,
};
