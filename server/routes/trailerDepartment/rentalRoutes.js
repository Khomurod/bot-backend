/**
 * Trailer Department — rentals and their inspections: create, edit, the pickup
 * and return inspections, activation, return, the cost estimate, status changes
 * and linking a tracker event to a rental movement.
 *
 * SAFETY RULES LIVE HERE (see docs/architecture/trailer-invariants.md):
 *   - saving inspection answers can only ever produce a DRAFT;
 *   - completing one is transactional and checks the required photo's bytes;
 *   - a manual-days billing override needs the rental CLOSE permission, not
 *     merely edit, because it changes what the company is charged.
 *
 * Split out of server/routes/trailerDepartmentRoutes.js.
 */
'use strict';

const express = require('express');
const { asyncRoute, actor, can } = require('./shared');

function createTrailerDepartmentRentalRoutes({ db, requirePermission }) {
  const router = express.Router();

  router.get(
    '/api/trailer-department/rentals',
    requirePermission('trailer_rentals.view'),
    asyncRoute(async (req, res) => res.json({ rentals: await db.listTrailerRentals(req.query) })),
  );

  router.post(
    '/api/trailer-department/rentals',
    requirePermission('trailer_rentals.create'),
    asyncRoute(async (req, res) => res.status(201).json({
      rental: await db.createTrailerRental(req.body || {}, actor(req)),
    })),
  );

  router.get(
    '/api/trailer-department/rentals/:id',
    requirePermission('trailer_rentals.view'),
    asyncRoute(async (req, res) => {
      const rental = await db.getTrailerRental(req.params.id);
      if (!rental) return res.status(404).json({ error: 'Rental not found.' });
      res.json({ rental });
    }),
  );

  router.put(
    '/api/trailer-department/rentals/:id',
    requirePermission('trailer_rentals.edit'),
    asyncRoute(async (req, res) => {
      // A manual day count overrides the billed duration, so it is gated on the
      // close permission rather than plain edit.
      if (req.body?.billing_method === 'manual_days' && !can(req, 'trailer_rentals.close')) {
        return res.status(403).json({ error: 'Manual day overrides require rental close permission.' });
      }
      const rental = await db.updateTrailerRental(req.params.id, req.body || {}, actor(req));
      if (!rental) return res.status(404).json({ error: 'Rental not found.' });
      res.json({ rental });
    }),
  );

  // Saving answers ALWAYS produces a draft — `completed` in the body is ignored.
  // The frontend used to be able to mark an inspection complete before its photo
  // upload had succeeded, leaving a "completed" inspection with no photo that
  // then blocked activation.
  router.put(
    '/api/trailer-department/rentals/:id/inspections/:type',
    requirePermission('trailer_inspections.manage'),
    asyncRoute(async (req, res) => {
      const inspection = await db.saveInspection(
        { ...req.body, rental_id: req.params.id, inspection_type: req.params.type },
        actor(req),
      );
      res.json({ inspection });
    }),
  );

  // The only way to complete one: transactional, and only after the required
  // fields are answered and the required photo's bytes genuinely exist.
  router.post(
    '/api/trailer-department/rentals/:id/inspections/:type/complete',
    requirePermission('trailer_inspections.manage'),
    asyncRoute(async (req, res) => {
      res.json({
        inspection: await db.completeInspection(req.params.id, req.params.type, actor(req)),
      });
    }),
  );

  router.post(
    '/api/trailer-department/rentals/:id/activate',
    requirePermission('trailer_rentals.create'),
    asyncRoute(async (req, res) => res.json(
      await db.activateTrailerRental(req.params.id, actor(req)),
    )),
  );

  router.post(
    '/api/trailer-department/rentals/:id/return',
    requirePermission('trailer_rentals.close'),
    asyncRoute(async (req, res) => res.json(
      await db.returnTrailerRental(req.params.id, req.body || {}, actor(req)),
    )),
  );

  router.get(
    '/api/trailer-department/rentals/:id/estimate',
    requirePermission('trailer_rentals.view'),
    asyncRoute(async (req, res) => res.json({
      estimate: await db.estimateTrailerRental(
        req.params.id, req.query.end_at, req.query.timezone,
      ),
    })),
  );

  router.post(
    '/api/trailer-department/rentals/:id/status',
    requirePermission('trailer_rentals.edit'),
    asyncRoute(async (req, res) => res.json({
      rental: await db.changeTrailerRentalStatus(
        req.params.id, req.body?.status, req.body?.reason, actor(req),
      ),
    })),
  );

  router.post(
    '/api/trailer-department/rentals/:id/link-event/:eventId',
    requirePermission('trailer_rentals.edit'),
    asyncRoute(async (req, res) => {
      const event = await db.linkTrailerEventToRental(
        req.params.eventId, req.params.id, actor(req),
        { movementId: req.body?.movement_id },
      );
      if (!event) return res.status(404).json({ error: 'Event or rental movement not found.' });
      res.json({ event });
    }),
  );

  return router;
}

module.exports = { createTrailerDepartmentRentalRoutes };
