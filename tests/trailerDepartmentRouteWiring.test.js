/**
 * Characterization of the Trailer Department router's WIRING: every endpoint it
 * registers, in order, with the exact permission set guarding it.
 *
 * This is deliberately a snapshot rather than a behavior test. The router was
 * split from one 42-endpoint file into per-domain modules, and the mistake that
 * kind of change invites is silent: a route that lands behind a neighbouring
 * domain's permission, or moves after a `:id` pattern that now shadows it, still
 * answers 200 for an admin who happens to hold both permissions. Pinning the
 * full inventory makes any such drift a failing assertion instead of a
 * privilege the panel quietly grants.
 *
 * A new endpoint is EXPECTED to fail this test. Add it to the table below in
 * the position it is registered, having checked its permission is the one you
 * intend — that review is the point.
 */
'use strict';
process.env.BOT_TOKEN ||= 'test-bot-token';
process.env.TELEGRAM_BOT_TOKEN ||= 'test-bot-token';
process.env.DATABASE_URL ||= 'postgresql://user:password@localhost:5432/test';
process.env.MANAGEMENT_GROUP_ID ||= '-1001234567890';
process.env.JWT_SECRET ||= 'test-jwt-secret';
process.env.FACEBOOK_TOKEN_ENCRYPTION_KEY ||= 'test-key';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTrailerDepartmentRoutes } = require('../server/routes/trailerDepartmentRoutes');

const P = '/api/trailer-department';

/**
 * `METHOD path :: permissions`, in registration order. `-` means the endpoint
 * carries no requirePermission guard of its own (the authenticated
 * department-enabled guard still applies).
 */
const EXPECTED = [
  `GET ${P}/status :: -`,
  // Trailer Department home / navigation (./trailerDepartmentHomeRoutes.js).
  `GET ${P}/home :: trailers.view|trailer_rentals.view|trailer_payments.view`,
  `GET ${P}/rental-list :: trailer_rentals.view|trailer_agreements.view`,
  `GET ${P}/rental-list/:agreementId :: trailer_rentals.view|trailer_agreements.view`,
  `GET ${P}/dashboard :: trailers.view`,
  `GET ${P}/trailers :: trailers.view`,
  `POST ${P}/trailers :: trailers.create`,
  `GET ${P}/trailers/:id :: trailers.view`,
  `GET ${P}/trailers/:id/overview :: trailers.view`,
  `PUT ${P}/trailers/:id :: trailers.edit`,
  `GET ${P}/companies :: trailer_rentals.view|trailer_companies.manage`,
  `POST ${P}/companies :: trailer_companies.manage`,
  `GET ${P}/companies/:id :: trailer_rentals.view|trailer_companies.manage`,
  `PUT ${P}/companies/:id :: trailer_companies.manage`,
  `GET ${P}/rentals :: trailer_rentals.view`,
  `POST ${P}/rentals :: trailer_rentals.create`,
  `GET ${P}/rentals/:id :: trailer_rentals.view`,
  `PUT ${P}/rentals/:id :: trailer_rentals.edit`,
  `PUT ${P}/rentals/:id/inspections/:type :: trailer_inspections.manage`,
  `POST ${P}/rentals/:id/inspections/:type/complete :: trailer_inspections.manage`,
  `POST ${P}/rentals/:id/activate :: trailer_rentals.create`,
  `POST ${P}/rentals/:id/return :: trailer_rentals.close`,
  `GET ${P}/rentals/:id/estimate :: trailer_rentals.view`,
  `POST ${P}/rentals/:id/status :: trailer_rentals.edit`,
  `POST ${P}/rentals/:id/link-event/:eventId :: trailer_rentals.edit`,
  `POST ${P}/media :: trailer_inspections.manage|trailer_payments.record`,
  `GET ${P}/media/:id/signed-url :: trailers.view|trailer_receipts.view`,
  `GET ${P}/invoices/:id/media :: trailer_payments.view`,
  `GET ${P}/invoices :: trailer_payments.view`,
  `GET ${P}/invoices/:id :: trailer_payments.view`,
  `POST ${P}/invoices/:id/adjustments :: trailer_payments.record`,
  `POST ${P}/payments :: trailer_payments.record`,
  `POST ${P}/payments/:id/reverse :: trailer_payments.reverse`,
  `GET ${P}/companies/:id/credits :: trailer_payments.view`,
  `GET ${P}/companies/:id/media :: trailer_payments.view`,
  `GET ${P}/companies/:id/reminder-history :: trailer_payments.view`,
  `POST ${P}/credits/:id/apply :: trailer_payments.record`,
  `POST ${P}/notifications/:id/retry :: trailer_payments.record|trailer_settings.manage`,
  `POST ${P}/invoices/:id/reminder-action :: trailer_payments.record`,
  `GET ${P}/settings :: trailer_settings.manage`,
  `PUT ${P}/settings :: trailer_settings.manage`,
  `POST ${P}/settings/test/:target :: trailer_settings.manage`,
  `GET ${P}/map :: trailer_map.view`,
  `GET ${P}/reports/:name :: trailer_reports.view`,
  `GET ${P}/audit :: trailer_reports.view`,
];

/**
 * Build the router with a requirePermission that TAGS the middleware it returns,
 * then read the tags back off each layer's handler stack. Reading Express's own
 * stack is what makes this a wiring assertion: it sees the router as the app
 * does, including sub-routers mounted with router.use().
 */
function collectWiring() {
  const permissionsFor = new WeakMap();
  const requirePermission = (...needed) => {
    const middleware = (_req, _res, next) => next();
    permissionsFor.set(middleware, needed);
    return middleware;
  };

  const router = createTrailerDepartmentRoutes({
    db: {},
    config: { trailerDepartmentEnabled: true },
    authMiddleware: (_req, _res, next) => next(),
    requirePermission,
    telegram: { sendMessage: async () => ({ message_id: 1 }) },
  });

  const rows = [];
  const walk = (stack, prefix) => {
    for (const layer of stack) {
      if (layer.route) {
        const method = Object.keys(layer.route.methods)[0].toUpperCase();
        const permissions = layer.route.stack
          .map((s) => permissionsFor.get(s.handle))
          .find(Boolean);
        rows.push(`${method} ${prefix}${layer.route.path} :: ${permissions ? permissions.join('|') : '-'}`);
      } else if (layer.handle?.stack) {
        walk(layer.handle.stack, prefix);
      }
    }
  };
  walk(router.stack, '');
  return rows;
}

test('every Trailer Department endpoint keeps its path, order and permission', () => {
  assert.deepEqual(collectWiring(), EXPECTED);
});

test('no endpoint is registered twice', () => {
  const seen = new Map();
  for (const row of collectWiring()) {
    const key = row.split(' :: ')[0];
    assert.equal(seen.has(key), false, `${key} is registered more than once`);
    seen.set(key, true);
  }
});

test('every endpoint outside the status probe is permission-guarded', () => {
  const unguarded = collectWiring()
    .filter((row) => row.endsWith(':: -'))
    .map((row) => row.split(' :: ')[0]);
  // Only the enabled-flag probe may answer without a department permission: the
  // panel calls it to decide whether to render the section at all.
  assert.deepEqual(unguarded, [`GET ${P}/status`]);
});
