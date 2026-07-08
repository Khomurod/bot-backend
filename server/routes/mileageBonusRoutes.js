/**
 * Mileage Bonus (company drivers) admin routes.
 *
 * Routes use their full paths; the router is mounted at the app root so
 * matching behavior is identical to the previous inline definitions.
 */
const express = require('express');
const mileageBonusService = require('../../services/mileageBonusService');

function createMileageBonusRoutes({ authMiddleware }) {
  const router = express.Router();

  // GET /api/mileage-bonus/overview — cached progress + notifications (fast).
  router.get('/api/mileage-bonus/overview', authMiddleware, async (req, res) => {
    try {
      const overview = await mileageBonusService.getOverview();
      res.json(overview);
    } catch (err) {
      console.error('[API] Error fetching mileage bonus overview:', err.message);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // POST /api/mileage-bonus/run — recompute + send qualifying milestone cards.
  // Long-running (hits the rate-limited Datatruck API), so it runs in the
  // background; the client polls /overview for progress + results.
  router.post('/api/mileage-bonus/run', authMiddleware, async (req, res) => {
    try {
      if (await mileageBonusService.isRunActive()) {
        return res.status(409).json({ error: 'A mileage bonus run is already in progress.' });
      }
      mileageBonusService
        .runMileageBonusCheck({ trigger: 'manual', requestedBy: req.admin?.username })
        .catch((err) => console.error('[API] Mileage bonus run failed:', err.message));
      res.status(202).json({ started: true });
    } catch (err) {
      console.error('[API] Error starting mileage bonus run:', err.message);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // POST /api/mileage-bonus/refresh — recompute progress only (no notifications).
  router.post('/api/mileage-bonus/refresh', authMiddleware, async (req, res) => {
    try {
      if (await mileageBonusService.isRunActive()) {
        return res.status(409).json({ error: 'A mileage bonus run is already in progress.' });
      }
      mileageBonusService
        .refreshProgressOnly({ requestedBy: req.admin?.username })
        .catch((err) => console.error('[API] Mileage bonus refresh failed:', err.message));
      res.status(202).json({ started: true });
    } catch (err) {
      console.error('[API] Error starting mileage bonus refresh:', err.message);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // PATCH /api/mileage-bonus/drivers/:name/status — persist the admin override.
  // Deactivating also disregards and removes every open Telegram bonus card.
  router.patch('/api/mileage-bonus/drivers/:normalizedName/status', authMiddleware, async (req, res) => {
    try {
      const status = String(req.body?.status || '').toLowerCase();
      if (!['active', 'inactive'].includes(status)) {
        return res.status(400).json({ error: 'status must be active or inactive' });
      }
      const result = await mileageBonusService.setDriverActivation(
        req.params.normalizedName,
        status === 'active',
        { username: req.admin?.username }
      );
      res.json(result);
    } catch (err) {
      console.error('[API] Error updating mileage bonus driver status:', err.message);
      res.status(err.status || 500).json({ error: err.message || 'Server error' });
    }
  });

  router.post('/api/mileage-bonus/notifications/:id/resend', authMiddleware, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid notification id' });
      const result = await mileageBonusService.resendBonusNotification(id, {
        username: req.admin?.username,
      });
      res.json(result);
    } catch (err) {
      console.error('[API] Error resending mileage bonus:', err.message);
      res.status(err.status || 500).json({ error: err.message || 'Server error' });
    }
  });

  router.post('/api/mileage-bonus/notifications/:id/disregard', authMiddleware, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid notification id' });
      const result = await mileageBonusService.disregardBonusNotification(id, {
        username: req.admin?.username,
      });
      res.json(result);
    } catch (err) {
      console.error('[API] Error disregarding mileage bonus:', err.message);
      res.status(err.status || 500).json({ error: err.message || 'Server error' });
    }
  });

  return router;
}

module.exports = { createMileageBonusRoutes };
