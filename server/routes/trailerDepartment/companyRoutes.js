/**
 * Trailer Department — rental companies (the counterparties trailers are rented
 * from and invoiced to).
 *
 * The read endpoints accept EITHER `trailer_rentals.view` or
 * `trailer_companies.manage`: a rental clerk must be able to see who a rental
 * belongs to without holding the permission that edits the company record.
 *
 * Split out of server/routes/trailerDepartmentRoutes.js.
 */
'use strict';

const express = require('express');
const { asyncRoute, actor } = require('./shared');

function createTrailerDepartmentCompanyRoutes({ db, requirePermission }) {
  const router = express.Router();

  router.get(
    '/api/trailer-department/companies',
    requirePermission('trailer_rentals.view', 'trailer_companies.manage'),
    asyncRoute(async (req, res) => {
      const data = await db.listTrailerCompanies({
        q: req.query.q,
        active: req.query.active == null ? undefined : req.query.active === 'true',
        page: req.query.page,
        page_size: req.query.page_size,
      });
      // Paged → the standard envelope (+ companies alias for old readers); else legacy bare array.
      res.json(Array.isArray(data) ? { companies: data } : { ...data, companies: data.items });
    }),
  );

  router.post(
    '/api/trailer-department/companies',
    requirePermission('trailer_companies.manage'),
    asyncRoute(async (req, res) => res.status(201).json({
      company: await db.createTrailerCompany(req.body || {}, actor(req)),
    })),
  );

  router.get(
    '/api/trailer-department/companies/:id',
    requirePermission('trailer_rentals.view', 'trailer_companies.manage'),
    asyncRoute(async (req, res) => {
      const company = await db.getTrailerCompany(req.params.id);
      if (!company) return res.status(404).json({ error: 'Company not found.' });
      res.json({ company });
    }),
  );

  router.put(
    '/api/trailer-department/companies/:id',
    requirePermission('trailer_companies.manage'),
    asyncRoute(async (req, res) => {
      const company = await db.updateTrailerCompany(req.params.id, req.body || {}, actor(req));
      if (!company) return res.status(404).json({ error: 'Company not found.' });
      res.json({ company });
    }),
  );

  return router;
}

module.exports = { createTrailerDepartmentCompanyRoutes };
