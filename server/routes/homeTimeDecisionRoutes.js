/**
 * Admin decision endpoint for Driver Home Time — POST /requests/:id/decision.
 *
 * A thin HTTP wrapper over the SHARED applyHomeTimeDecision workflow (defined in
 * services/homeTimeApproval, re-exported by homeTimeRequestService) so an admin
 * approve/decline produces the exact same complete business result as the
 * Telegram approval buttons: atomic pending→decided guard, decided-by/decided-at
 * recorded, reminders stopped, the Telegram card settled in place, and — for an
 * approval — the employee-group announcement.
 *
 * Kept in its own module so homeTimeRoutes.js stays within the size limit, and so
 * the service (and, transitively, the bot) is required LAZILY inside the handler
 * — the route file can be required in tests without pulling in config/bot.
 *
 * `resolveTelegramFn` is injectable so tests can run without loading bot/bot.js.
 */
function resolveTelegram() {
  try {
    return require('../../bot/bot').bot?.telegram || null;
  } catch (_) {
    return null;
  }
}

// Map a typed decision-result code to an HTTP status + default message.
const HTTP_BY_CODE = {
  not_found: [404, 'Request not found.'],
  invalid_decision: [400, "decision must be 'approve' or 'decline'."],
  invalid_dates: [422, 'Set a valid arrive-home and return-to-road date before approving.'],
  outdated: [422, 'This home-time period has already passed — it can no longer be approved. You can decline or close it.'],
  already_decided: [409, 'This request was already decided.'],
  conflict: [409, 'This request was just decided by someone else.'],
};

function registerHomeTimeDecisionRoutes(router, { authMiddleware, resolveTelegramFn = resolveTelegram } = {}) {
  router.post('/requests/:id/decision', authMiddleware, async (req, res) => {
    try {
      const id = Number.parseInt(req.params.id, 10);
      if (!(id > 0)) return res.status(400).json({ error: 'Invalid request id' });

      // Lazy require: keeps this route file (and homeTimeRoutes) free of config/bot
      // at load time; the shared workflow owns all the business rules.
      const { applyHomeTimeDecision } = require('../../services/homeTimeRequestService');
      const result = await applyHomeTimeDecision(resolveTelegramFn(), id, {
        decision: req.body?.decision,
        decidedByUsername: req.admin?.username || null,
        via: 'admin',
      });

      if (result.ok) return res.json({ request: result.request });

      const [status, defaultMsg] = HTTP_BY_CODE[result.code] || [400, 'Could not decide the request.'];
      const error = result.code === 'already_decided' && result.request?.status
        ? `This request was already ${result.request.status}.`
        : defaultMsg;
      return res.status(status).json({ error, code: result.code, request: result.request || null });
    } catch (err) {
      console.error('[HOME-TIME API] decision failed:', err.message);
      return res.status(500).json({ error: 'Failed to decide the request.' });
    }
  });
}

module.exports = { registerHomeTimeDecisionRoutes };
