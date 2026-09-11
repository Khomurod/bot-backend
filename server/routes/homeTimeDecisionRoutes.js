/**
 * POST /requests/:id/decision — RETIRED. Answers 410 Gone.
 *
 * This was the admin panel's Approve / Do Not Approve endpoint, a thin wrapper
 * over the same workflow the Telegram approval buttons ran. Home Time no longer
 * asks permission: a driver's stay is REPORTED to three managers as it happens
 * and a completed request settles as `recorded`. The buttons are gone from the
 * admin panel and from Telegram.
 *
 * The route is kept, rather than deleted, for one reason: an admin tab opened
 * before the deploy still holds the old buttons, and a bare 404 would leave
 * whoever clicks one guessing. A 410 with a sentence is the difference between
 * "this is finished" and "something is broken".
 *
 * NOTHING IS ERASED. The historical `approved` / `denied` rows stay exactly as
 * they are, `homeTimeEfficiency` still reads them to classify an approved
 * exception, and the driver timeline still shows who decided and when. Retiring
 * the decision is not the same as retracting the decisions already taken.
 */
const RETIRED = {
  code: 'approval_retired',
  error: 'Home time is no longer approved or declined. A stay is recorded and reported '
    + 'to the managers as it happens; a completed request settles as "recorded". '
    + 'Existing approved and denied requests are unchanged and still shown.',
};

function registerHomeTimeDecisionRoutes(router, { authMiddleware } = {}) {
  const guard = authMiddleware || ((req, _res, next) => next());
  router.post('/requests/:id/decision', guard, (req, res) => res.status(410).json(RETIRED));
  return router;
}

module.exports = { registerHomeTimeDecisionRoutes, RETIRED };
