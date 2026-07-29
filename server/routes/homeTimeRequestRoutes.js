/**
 * Home-Time REQUEST endpoints (list / create / correct).
 *
 * Split out of homeTimeRoutes so that file stays within the per-file line limit,
 * and — more importantly — so the request endpoints and the SETTINGS endpoint
 * live in visibly different places.
 *
 * That separation is load-bearing. A refactor once collapsed the two: the
 * `PUT /requests/:id` handler ended up calling the settings validator and
 * writing home_time_settings, while `PUT /settings` vanished entirely. Editing a
 * request's dates silently rewrote global settings and the admin panel still
 * reported success. tests/homeTimeRoutesSeparationPg.test.js pins both
 * endpoints against a real database so that cannot recur.
 *
 * These handlers must only ever write home_time_requests.
 */
'use strict';

const { DateTime } = require('luxon');
const ht = require('../../database/homeTime');
const { homeTimePolicyApplies } = require('../../services/homeTimeConstants');
const { listCanonicalDriverGroups } = require('../../services/driverGroupDirectoryService');
const { parseDateInput, parseDateOnly } = require('./homeTimeRouteHelpers');

/**
 * Register the request endpoints on an existing router.
 *
 * @param {import('express').Router} router
 * @param {object} deps
 * @param {Function} deps.authMiddleware
 * @param {Function} deps.buildDirectoryIndex  group-id -> canonical identity
 * @param {Function} deps.resolveDriverType    fallback driver-type inference
 */
function registerHomeTimeRequestRoutes(router, {
  authMiddleware, buildDirectoryIndex, resolveDriverType,
}) {
  // GET /requests — every home-time request (for red-flag review).
  router.get('/requests', authMiddleware, async (req, res) => {
    try {
      const [rows, directory] = await Promise.all([
        ht.listHomeTimeRequests({ limit: 200 }),
        listCanonicalDriverGroups({ operational: true, includeNonDrivers: false }),
      ]);
      const directoryByGroupId = buildDirectoryIndex(directory);
      const requests = rows.map((row) => {
        const identity = directoryByGroupId.get(Number(row.group_id)) || null;
        const driverType = identity?.driver_type || resolveDriverType(row);
        return {
          ...row,
          group_id: identity?.canonical_group_id || row.group_id,
          source_group_id: row.group_id,
          driver_name: identity?.display_name || row.driver_name || null,
          unit_number: identity?.unit_number || row.unit_number || null,
          driver_type: driverType,
          policy_applies: homeTimePolicyApplies(driverType),
        };
      });
      res.json({ requests });
    } catch (err) {
      console.error('[HOME-TIME API] requests load failed:', err.message);
      res.status(500).json({ error: 'Failed to load requests.' });
    }
  });

  // POST /requests — manually register a home-time request (admin entry).
  router.post('/requests', authMiddleware, async (req, res) => {
    try {
      const b = req.body || {};
      const groupId = b.group_id != null ? Number.parseInt(b.group_id, 10) : null;
      const homeFrom = parseDateOnly(b.home_from);
      const homeTo = parseDateOnly(b.home_to);
      if (!homeFrom || !homeTo) {
        return res.status(400).json({ error: 'home_from and home_to must be YYYY-MM-DD' });
      }
      if (homeTo < homeFrom) {
        return res.status(400).json({ error: 'home_to must be on or after home_from' });
      }
      const allowedStatus = ['pending', 'approved', 'denied'];
      const status = allowedStatus.includes(b.status) ? b.status : 'approved';

      let driverName = b.driver_name || null;
      let unitNumber = b.unit_number || null;
      let telegramGroupId = null;
      let driverType = null;
      if (groupId) {
        const profile = await db.getDriverProfileByGroupId(groupId).catch(() => null);
        if (profile) {
          driverName = driverName || [profile.first_name, profile.last_name].filter(Boolean).join(' ').trim() || null;
          unitNumber = unitNumber || profile.unit_number || null;
          telegramGroupId = profile.telegram_group_id || null;
          driverType = profile.driver_type || inferDriverType(profile.group_name || '');
        }
      }
      const policyMet = homeTimePolicyApplies(driverType)
        ? (typeof b.policy_met === 'boolean' ? b.policy_met : null)
        : null;

      // Always insert as pending, then decide() so decided_by/decided_at are set
      // consistently for approved/denied manual entries.
      let request = await ht.insertHomeTimeRequest({
        groupId: groupId || null,
        telegramGroupId,
        driverName,
        unitNumber,
        requestedByUsername: req.admin?.username || null,
        policyMet,
        homeFrom,
        homeTo,
        status: 'pending',
        source: 'manual',
        aiReasoning: b.note || null,
      });
      if (status !== 'pending') {
        const decided = await ht.decideHomeTimeRequest(request.id, {
          status, username: req.admin?.username || null,
        });
        if (decided) request = decided;
      }
      res.json({ request });
    } catch (err) {
      console.error('[HOME-TIME API] manual request failed:', err.message);
      res.status(500).json({ error: 'Failed to register request.' });
    }
  });

  // PUT /requests/:id — admin correction: fix the dates and/or resolve the status
  // (e.g. close an unanswered clarification, cancel a flow). At least one field.
  router.put('/requests/:id', authMiddleware, async (req, res) => {
    try {
      const id = Number.parseInt(req.params.id, 10);
      if (!(id > 0)) return res.status(400).json({ error: 'Invalid request id' });
      const existing = await ht.getHomeTimeRequestById(id);
      if (!existing) return res.status(404).json({ error: 'Request not found' });

      const b = req.body || {};
      const patch = {};
      if (b.home_from !== undefined) {
        const v = parseDateOnly(b.home_from);
        if (b.home_from && !v) return res.status(400).json({ error: 'home_from must be YYYY-MM-DD' });
        patch.homeFrom = v;
      }
      if (b.return_to_road_date !== undefined) {
        const v = parseDateOnly(b.return_to_road_date);
        if (b.return_to_road_date && !v) return res.status(400).json({ error: 'return_to_road_date must be YYYY-MM-DD' });
        patch.returnToRoadDate = v;
        // Keep home_to (last day home) consistent when a return date is supplied.
        patch.homeTo = v ? DateTime.fromISO(v).minus({ days: 1 }).toISODate() : null;
      }
      if (b.home_to !== undefined && b.return_to_road_date === undefined) {
        const v = parseDateOnly(b.home_to);
        if (b.home_to && !v) return res.status(400).json({ error: 'home_to must be YYYY-MM-DD' });
        patch.homeTo = v;
      }
      if (b.status !== undefined) {
        const allowed = ['pending', 'approved', 'denied', 'cancelled', 'expired', 'clarification_unanswered',
          'awaiting_dates', 'awaiting_home_start', 'awaiting_return_to_road'];
        if (!allowed.includes(b.status)) return res.status(400).json({ error: 'invalid status' });
        patch.status = b.status;
        // Resolving a flow stops any pending reminders.
        if (['cancelled', 'expired', 'approved', 'denied'].includes(b.status)) patch.nextReminderAt = null;
      }
      if (b.note !== undefined) patch.aiReasoning = b.note ? String(b.note).slice(0, 1000) : null;
      if (Object.keys(patch).length === 0) {
        return res.status(400).json({ error: 'Provide at least one field to update' });
      }
      // Guard: if both dates are present after the patch, the return must be after the start.
      const finalFrom = patch.homeFrom !== undefined ? patch.homeFrom : existing.home_from;
      const finalReturn = patch.returnToRoadDate !== undefined ? patch.returnToRoadDate : existing.return_to_road_date;
      if (finalFrom && finalReturn && String(finalReturn) <= String(finalFrom).slice(0, 10)) {
        return res.status(400).json({ error: 'return_to_road_date must be after home_from' });
      }
      const request = await ht.updateHomeTimeRequestFields(id, patch);
      res.json({ request });
    } catch (err) {
      console.error('[HOME-TIME API] request update failed:', err.message);
      res.status(500).json({ error: 'Failed to update request.' });
    }
  });
}

module.exports = { registerHomeTimeRequestRoutes };
