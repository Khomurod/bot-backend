/**
 * Trailer Department — the trailers themselves: the dashboard, the list, and
 * one trailer's detail/overview and edits.
 *
 * Split out of server/routes/trailerDepartmentRoutes.js. Paths are absolute
 * because the façade mounts this router at the app root.
 */
'use strict';

const express = require('express');
const { asyncRoute, actor, can } = require('./shared');

function createTrailerDepartmentTrailerRoutes({ db, requirePermission }) {
  const router = express.Router();

  router.get(
    '/api/trailer-department/dashboard',
    requirePermission('trailers.view'),
    asyncRoute(async (req, res) => res.json({ dashboard: await db.getTrailerDashboard(req.query) })),
  );

  router.get(
    '/api/trailer-department/trailers',
    requirePermission('trailers.view'),
    asyncRoute(async (req, res) => {
      const data = await db.listDepartmentTrailers(req.query);
      // Paged → the standard envelope (+ trailers alias for old readers); else legacy bare array.
      res.json(Array.isArray(data) ? { trailers: data } : { ...data, trailers: data.items });
    }),
  );

  router.post(
    '/api/trailer-department/trailers',
    requirePermission('trailers.create'),
    asyncRoute(async (req, res) => res.status(201).json({
      trailer: await db.createDepartmentTrailer(req.body || {}, actor(req)),
    })),
  );

  router.get(
    '/api/trailer-department/trailers/:id',
    requirePermission('trailers.view'),
    asyncRoute(async (req, res) => {
      const trailer = await db.getDepartmentTrailer(req.params.id);
      if (!trailer) return res.status(404).json({ error: 'Trailer not found.' });
      res.json({ trailer });
    }),
  );

  // The trailer detail page: rentals from both systems, movements, documents
  // (metadata only), invoices, aliases and the audit trail in one response.
  router.get(
    '/api/trailer-department/trailers/:id/overview',
    requirePermission('trailers.view'),
    asyncRoute(async (req, res) => {
      const overview = await db.getTrailerOverview(req.params.id);
      if (!overview) return res.status(404).json({ error: 'Trailer not found.' });
      res.json(overview);
    }),
  );

  router.put(
    '/api/trailer-department/trailers/:id',
    requirePermission('trailers.edit'),
    asyncRoute(async (req, res) => {
      // Archiving is a SEPARATE permission from editing: `trailers.edit` may
      // change a trailer's details but not take it out of service.
      if (req.body?.active === false && !can(req, 'trailers.delete_or_archive')) {
        return res.status(403).json({ error: 'Trailer archive permission required.' });
      }
      const trailer = await db.updateDepartmentTrailer(req.params.id, req.body || {}, actor(req));
      if (!trailer) return res.status(404).json({ error: 'Trailer not found.' });
      res.json({ trailer });
    }),
  );

  return router;
}

module.exports = { createTrailerDepartmentTrailerRoutes };
