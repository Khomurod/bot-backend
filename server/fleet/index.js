/**
 * Fleet Operations Platform — mount helper.
 *
 * Wires the self-contained fleet module into an existing Express app:
 *   - JSON API at /api/v1/*
 *   - Static SPA + client-side routing at /update/*
 *
 * This is the ONLY integration point with the host application. It touches no
 * existing routes, database, or services.
 */

'use strict';

const path = require('path');
const express = require('express');
const fleetApi = require('./router');

const FLEET_BUILD_DIR = path.join(__dirname, '..', '..', 'fleet', 'build');
const FLEET_SPA_INDEX = path.join(FLEET_BUILD_DIR, 'index.html');

function mountFleet(app) {
  // API
  app.use('/api/v1', fleetApi);

  // Static assets for the SPA (base = /update/)
  app.use('/update', express.static(FLEET_BUILD_DIR));

  // Client-side routing fallback — serve index.html for any /update/* path.
  app.get(['/update', '/update/*'], (req, res) => {
    const fs = require('fs');
    if (!fs.existsSync(FLEET_SPA_INDEX)) {
      return res.status(503).send(
        'Fleet UI build is missing (fleet/build/index.html). '
        + 'From repo root run: cd fleet && npm install && npm run build.',
      );
    }
    res.sendFile(FLEET_SPA_INDEX);
  });

  // FleetView owns its own background snapshot sync (no-op unless real mode).
  // Started here — the single guarded mount — so the isolation invariant holds
  // (nothing outside server/fleet references FleetView). Self-registers a
  // shutdown hook so it stops cleanly without the main app importing it.
  try {
    const { startFleetviewSyncJob, stopFleetviewSyncJob } = require('./syncJob');
    startFleetviewSyncJob();
    const stop = () => { try { stopFleetviewSyncJob(); } catch (e) { /* noop */ } };
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
  } catch (e) {
    console.error('[FLEET] Background sync job failed to start:', e.message);
  }

  console.log('[FLEET] Operations platform mounted at /update (API: /api/v1).');
}

module.exports = { mountFleet };
