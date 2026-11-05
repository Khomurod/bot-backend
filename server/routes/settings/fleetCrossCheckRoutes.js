'use strict';

/**
 * GET /api/settings/fleet-crosscheck — the Board ↔ Wenze ↔ Datatruck report
 * on Settings → Dispatcher Board. Read-only; the rules are in
 * `services/fleetCrossCheck/report.js` and `lib/fleetCrossCheck/compare.js`.
 *
 * `?refresh=1` asks for a fresh build; inside the ten-minute window the stored
 * one is returned with a note, because Datatruck's allowance is shared.
 */
const express = require('express');
const { sendFailure } = require('../../middleware/failureResponse');

function createFleetCrossCheckRouter({ authMiddleware, crossCheck = null }) {
  const router = express.Router();
  let report = crossCheck;

  router.get('/fleet-crosscheck', authMiddleware, async (req, res) => {
    try {
      if (!report) {
        // eslint-disable-next-line global-require
        report = require('../../../services/fleetCrossCheck/report').createFleetCrossCheck();
      }
      const refresh = req.query.refresh === '1' || req.query.refresh === 'true';
      res.json(await report.getReport({ refresh }));
    } catch (err) {
      sendFailure(res, err, { message: 'Failed to build the fleet comparison', logPrefix: '[SETTINGS API]' });
    }
  });

  return router;
}

module.exports = { createFleetCrossCheckRouter };
