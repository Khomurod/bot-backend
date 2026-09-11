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
 *   identityRoutes.js      the person layer: coverage, one person's history,
 *                          and the backfill (preview on the read gate, apply
 *                          on the APPLY gate)
 *   retentionRoutes.js     who the company may be about to lose, and one
 *                          acknowledgement. Read-only about the DRIVER: there
 *                          is no endpoint here that records an opinion of one.
 *   learningRoutes.js      what Wenze has suggested about its OWN rules, and a
 *                          person's decision. Accepting records agreement; it
 *                          does not apply anything.
 *   systemsRoutes.js       whether each worker and integration is actually
 *                          RUNNING — the question every other screen answers
 *                          with the same silence whether it is or not.
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
 * | /identity/coverage            | GET    | read    |
 * | /identity/people/:id          | GET    | read    |
 * | /identity/backfill/preview    | GET    | read    |
 * | /identity/backfill            | POST   | APPLY   |
 * | /systems                      | GET    | read    |
 * | /learning/:id/accept          | POST   | APPLY   |
 * | /learning/:id/revert          | POST   | APPLY   |
 */
const express = require('express');

const { createFindingsRouter } = require('./operations/findingsRoutes');
const { createCorrectionsRouter } = require('./operations/correctionsRoutes');
const { createIdentityRouter } = require('./operations/identityRoutes');
const { createRetentionRouter } = require('./operations/retentionRoutes');
const { createLearningRouter } = require('./operations/learningRoutes');
const { createSystemsRouter } = require('./operations/systemsRoutes');

/**
 * @param {object} deps
 * @param {Function|Array} deps.authMiddleware   the read gate (admin.full_access)
 * @param {Function|Array} deps.applyMiddleware  the write gate (operations.corrections.apply)
 */
function createOperationsRouter({ authMiddleware, applyMiddleware }) {
  const router = express.Router();
  router.use(createFindingsRouter({ authMiddleware }));
  router.use(createCorrectionsRouter({ authMiddleware, applyMiddleware }));
  router.use(createIdentityRouter({ authMiddleware, applyMiddleware }));
  router.use(createRetentionRouter({ authMiddleware }));
  router.use(createLearningRouter({ authMiddleware, applyMiddleware }));
  router.use(createSystemsRouter({ authMiddleware }));
  return router;
}

module.exports = { createOperationsRouter };
