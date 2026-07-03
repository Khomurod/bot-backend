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

  console.log('[FLEET] Operations platform mounted at /update (API: /api/v1).');
}

module.exports = { mountFleet };
