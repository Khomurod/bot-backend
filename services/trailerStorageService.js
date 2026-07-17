/**
 * Trailer Department storage — compatibility façade.
 *
 * RE-EXPORT ONLY. The implementation lives in services/trailerStorage/*:
 *
 *   index.js            backend selection (supabase when configured, else database)
 *   databaseBackend.js  bytes in Postgres — no bucket, no configuration
 *   supabaseBackend.js  the original Supabase Storage logic, unchanged
 *   mediaReference.js   short-lived HMAC-signed URLs for Telegram delivery
 *
 * Add new code to a focused module in that package and export it from its
 * index — never here. Mirrors services/routeControlService.js -> routeControl/*,
 * the reference example in CLAUDE.md.
 *
 * This file exists so `require('../services/trailerStorageService')` keeps
 * resolving for existing importers.
 */
'use strict';

module.exports = require('./trailerStorage');
