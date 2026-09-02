/**
 * Trailer Department admin API — router façade.
 *
 * COMPOSITION ONLY. Each domain owns a sub-router under ./trailerDepartment/,
 * and every route keeps the FULL absolute path it always had, so the admin
 * panel's URLs and the legacy readers are untouched:
 *
 *   ./trailerDepartment/shared.js           upload sink, actor/can, CSV, storeFile
 *   ./trailerDepartment/trailerRoutes.js    dashboard, trailers, trailer overview
 *   ./trailerDepartment/companyRoutes.js    rental companies
 *   ./trailerDepartment/rentalRoutes.js     rentals, inspections, activate/return
 *   ./trailerDepartment/mediaRoutes.js      upload, signed URLs, invoice documents
 *   ./trailerDepartment/accountingRoutes.js invoices, payments, credits, reminders
 *   ./trailerDepartment/settingsRoutes.js   settings + the Telegram group test
 *   ./trailerDepartment/reportRoutes.js     map, reports, audit
 *
 * THREE THINGS HERE ARE ORDER-DEPENDENT and must not be rearranged:
 *
 *  1. GET /status is registered BEFORE the disabled-department guard, so the
 *     admin UI can tell a disabled department apart from a broken request.
 *  2. The guard is registered before every sub-router, so a disabled
 *     department answers 404 everywhere else.
 *  3. The error handler is registered LAST. Express only routes an error to a
 *     handler that comes after the layer that threw, so moving it above the
 *     sub-routers would silently turn every trailer error into an unformatted
 *     500 instead of the errorPayload() shape the panel expects.
 *
 * tests/trailerDepartmentRouteWiring.test.js pins the whole endpoint inventory
 * — path, order and guarding permission — precisely so a future split of this
 * area cannot move a route behind the wrong permission unnoticed.
 */
'use strict';

const express = require('express');
const { errorPayload } = require('../../services/trailerErrorMessages');
const { createTrailerHomeRouter } = require('./trailerDepartmentHomeRoutes');
const { storeFile, sendCsv } = require('./trailerDepartment/shared');
const { createTrailerDepartmentTrailerRoutes } = require('./trailerDepartment/trailerRoutes');
const { createTrailerDepartmentCompanyRoutes } = require('./trailerDepartment/companyRoutes');
const { createTrailerDepartmentRentalRoutes } = require('./trailerDepartment/rentalRoutes');
const { createTrailerDepartmentMediaRoutes } = require('./trailerDepartment/mediaRoutes');
const {
  createTrailerDepartmentAccountingRoutes,
} = require('./trailerDepartment/accountingRoutes');
const { createTrailerDepartmentSettingsRoutes } = require('./trailerDepartment/settingsRoutes');
const { createTrailerDepartmentReportRoutes } = require('./trailerDepartment/reportRoutes');

function createTrailerDepartmentRoutes({ db, config, authMiddleware, requirePermission, telegram }) {
  const router = express.Router();

  // Registered BEFORE the disabled-guard below so the admin UI can tell a
  // disabled department apart from a broken request. Authenticated, and it
  // reports nothing beyond the flag itself.
  router.get(
    '/api/trailer-department/status',
    authMiddleware,
    (_req, res) => res.json({ enabled: Boolean(config.trailerDepartmentEnabled) }),
  );

  router.use('/api/trailer-department', authMiddleware, (req, res, next) => {
    if (!config.trailerDepartmentEnabled) {
      return res.status(404).json({ error: 'Trailer Department is disabled.' });
    }
    next();
  });

  router.use(createTrailerHomeRouter({ requirePermission }));

  const deps = { db, requirePermission };
  router.use(createTrailerDepartmentTrailerRoutes(deps));
  router.use(createTrailerDepartmentCompanyRoutes(deps));
  router.use(createTrailerDepartmentRentalRoutes(deps));
  router.use(createTrailerDepartmentMediaRoutes(deps));
  router.use(createTrailerDepartmentAccountingRoutes(deps));
  router.use(createTrailerDepartmentSettingsRoutes({ ...deps, telegram }));
  router.use(createTrailerDepartmentReportRoutes(deps));

  // LAST — see note 3 above.
  router.use((error, _req, res, _next) => {
    console.error('[TRAILER-DEPARTMENT]', error.message);
    const { status, payload } = errorPayload(error);
    res.status(status).json(payload);
  });

  return router;
}

// storeFile and sendCsv stay on this module's surface: they were exported here
// before the split, and ./trailerDepartment/shared.js is now their home.
module.exports = { createTrailerDepartmentRoutes, storeFile, sendCsv };
