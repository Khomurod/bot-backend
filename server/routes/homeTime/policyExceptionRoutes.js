'use strict';

/**
 * Drivers' own home-time rules — /api/home-time/policy-exceptions.
 *
 *   GET    /policy-exceptions                 the rules, the driver groups, the policy
 *   PUT    /policy-exceptions                 set (or replace) one driver's rule
 *   DELETE /policy-exceptions/:id             remove one
 *   GET    /policy-exceptions/bitrix-preview  the old exceptions on pipeline-33 cards (read only)
 *
 * The logic is services/homeTime/policyExceptionsAdmin.js.
 */

const express = require('express');
const service = require('../../../services/homeTime/policyExceptionsAdmin');

function failed(res, err, what) {
  if (err.statusCode === 400) return res.status(400).json({ error: err.message });
  console.error(`[HOME-TIME API] policy exceptions ${what} failed:`, String(err.message).slice(0, 200));
  return res.status(500).json({ error: `Could not ${what} the drivers' rules.` });
}

const who = (req) => req.admin?.username || req.user?.username || null;

function createPolicyExceptionRoutes({ authMiddleware, adminService = service }) {
  const router = express.Router();
  router.get('/policy-exceptions', authMiddleware, async (req, res) => {
    try { return res.json(await adminService.view()); } catch (err) { return failed(res, err, 'load'); }
  });
  router.put('/policy-exceptions', authMiddleware, async (req, res) => {
    try { return res.json({ exception: await adminService.save(req.body || {}, who(req)) }); } catch (err) { return failed(res, err, 'save'); }
  });
  router.delete('/policy-exceptions/:id', authMiddleware, async (req, res) => {
    try { return res.json({ removed: await adminService.remove(req.params.id) }); } catch (err) { return failed(res, err, 'remove'); }
  });
  router.get('/policy-exceptions/bitrix-preview', authMiddleware, async (req, res) => {
    try { return res.json({ cards: await adminService.bitrixPreview() }); } catch (err) { return failed(res, err, 'read Bitrix for'); }
  });
  return router;
}

module.exports = { createPolicyExceptionRoutes };
