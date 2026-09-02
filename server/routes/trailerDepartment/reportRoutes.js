/**
 * Trailer Department — read-only views: the map, the named reports (JSON or
 * CSV) and the audit trail.
 *
 * CSV goes out through sendCsv, which escapes formula-injection prefixes (see
 * ../csvSafe) — these exports are opened in Excel by people outside the
 * department.
 *
 * Split out of server/routes/trailerDepartmentRoutes.js.
 */
'use strict';

const express = require('express');
const { asyncRoute, sendCsv } = require('./shared');

function createTrailerDepartmentReportRoutes({ db, requirePermission }) {
  const router = express.Router();

  router.get(
    '/api/trailer-department/map',
    requirePermission('trailer_map.view'),
    asyncRoute(async (req, res) => {
      const trailers = await db.listDepartmentTrailers(req.query);
      res.json({
        trailers,
        without_coordinates: trailers.filter((t) => t.current_lat == null || t.current_lng == null),
      });
    }),
  );

  router.get(
    '/api/trailer-department/reports/:name',
    requirePermission('trailer_reports.view'),
    asyncRoute(async (req, res) => {
      const rows = await db.getTrailerReport(req.params.name, req.query);
      if (req.query.format === 'csv') return sendCsv(res, req.params.name, rows);
      res.json({ rows });
    }),
  );

  router.get(
    '/api/trailer-department/audit',
    requirePermission('trailer_reports.view'),
    asyncRoute(async (req, res) => {
      const data = await db.listTrailerAudit(req.query);
      // Paged → the standard envelope (+ audit alias for old readers); else legacy bare array.
      res.json(Array.isArray(data) ? { audit: data } : { ...data, audit: data.items });
    }),
  );

  return router;
}

module.exports = { createTrailerDepartmentReportRoutes };
