'use strict';

/**
 * Home + unified rental list for the redesigned Trailer Department.
 *
 * Mounted INSIDE createTrailerDepartmentRoutes, after its auth + disabled
 * guard, so both endpoints inherit the same gating. Thin HTTP layer: the read
 * model and home aggregates live in services.
 */

const express = require('express');
const { getTrailerHome } = require('../../services/trailerHomeService');
const readModel = require('../../services/trailerRentalReadModel');

function asyncRoute(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function createTrailerHomeRouter({ requirePermission }) {
  const router = express.Router();

  router.get('/api/trailer-department/home',
    requirePermission('trailers.view', 'trailer_rentals.view', 'trailer_payments.view'),
    asyncRoute(async (_req, res) => res.json(await getTrailerHome())));

  // The ONE rentals list the redesigned UI reads: agreements as the spine
  // (legacy rentals are mirrored in by the boot backfill), server-paginated.
  router.get('/api/trailer-department/rental-list',
    requirePermission('trailer_rentals.view', 'trailer_agreements.view'),
    asyncRoute(async (req, res) => res.json(await readModel.listRentals({
      bucket: req.query.tab || req.query.bucket,
      companyId: req.query.company_id,
      status: req.query.status,
      q: req.query.q,
      page: req.query.page,
      page_size: req.query.page_size,
    }))));

  router.get('/api/trailer-department/rental-list/:agreementId',
    requirePermission('trailer_rentals.view', 'trailer_agreements.view'),
    asyncRoute(async (req, res) => {
      const rental = await readModel.getRental(req.params.agreementId);
      if (!rental) return res.status(404).json({ error: 'Rental not found.' });
      return res.json({ rental });
    }));

  return router;
}

module.exports = { createTrailerHomeRouter };
