'use strict';

/**
 * System diagnostics the admin panel needs: how much of the hosted database's
 * monthly data-transfer allowance this month has used.
 *
 * WHY: the deployment reached 4.222 GB of a 5 GB allowance with nothing in the
 * app aware of it, and running out means reads start failing. This endpoint is
 * what lets the panel show a warning at 80/90/95% while there is still time to
 * act — see services/databaseUsageService.js for the meter itself.
 *
 * IT COSTS NOTHING TO CALL: the numbers are in-memory counters, so this handler
 * performs no database query. A meter whose own reads consumed the allowance it
 * measures would be a poor joke.
 */
const express = require('express');
const { currentUsage } = require('../../services/databaseUsageService');
const { sendFailure } = require('../middleware/failureResponse');

function createSystemRoutes({ authMiddleware }) {
  const router = express.Router();

  router.get('/api/system/database-usage', authMiddleware, (req, res) => {
    try {
      // `estimated: true` travels with the payload: whoever reads a percentage
      // must know it is this app's own sampling, not the provider's invoice.
      res.json(currentUsage());
    } catch (err) {
      sendFailure(res, err, { message: 'Failed to read database usage', logPrefix: '[DB-USAGE]' });
    }
  });

  return router;
}

module.exports = { createSystemRoutes };
