/**
 * /api/operations — the Needs Attention page's server side.
 *
 * A façade over two sub-routers, split by the only line that matters here:
 *
 *   findingsRoutes.js      reads, and decisions about the system's own notes
 *                          (dismiss, snooze, run a sweep) — `admin.full_access`
 *   correctionsRoutes.js   everything that changes a real fleet record
 *                          (apply, revert, grant auto-apply) —
 *                          `operations.corrections.apply`
 *
 * The two gates are passed in rather than built here, matching the rest of
 * `server/api.js`, so a test can mount this router with whatever authorization
 * it wants to exercise.
 *
 * | path                          | method | gate    |
 * |-------------------------------|--------|---------|
 * | /summary                      | GET    | read    |
 * | /findings                     | GET    | read    |
 * | /findings/:id                 | GET    | read    |
 * | /findings/:id/dismiss         | POST   | read    |
 * | /findings/:id/snooze          | POST   | read    |
 * | /sweep                        | POST   | read    |
 * | /corrections                  | GET    | read    |
 * | /corrections/:id              | GET    | read    |
 * | /auto-apply/preview           | GET    | read    |
 * | /checks                       | GET    | read    |
 * | /findings/:id/apply           | POST   | APPLY   |
 * | /corrections/:id/revert       | POST   | APPLY   |
 * | /checks/:checkKey             | PUT    | APPLY   |
 */
const express = require('express');

const { createFindingsRouter } = require('./operations/findingsRoutes');
const { createCorrectionsRouter } = require('./operations/correctionsRoutes');

/**
 * @param {object} deps
 * @param {Function|Array} deps.authMiddleware   the read gate (admin.full_access)
 * @param {Function|Array} deps.applyMiddleware  the write gate (operations.corrections.apply)
 */
function createOperationsRouter({ authMiddleware, applyMiddleware }) {
  const router = express.Router();
  router.use(createFindingsRouter({ authMiddleware }));
  router.use(createCorrectionsRouter({ authMiddleware, applyMiddleware }));
  return router;
}

module.exports = { createOperationsRouter };
