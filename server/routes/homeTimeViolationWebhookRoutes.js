'use strict';

/**
 * The webhook a Bitrix24 automation robot calls when a home-time card enters a
 * violation stage: POST (or GET) /api/integrations/bitrix/home-time-violation.
 *
 * PUBLIC, BEHIND A SHARED SECRET. Bitrix's "Webhook" robot can only call a URL,
 * so the secret travels as `?token=` and is compared in constant time with the
 * one the app generated (services/homeTime/violationWebhookSecret.js; the
 * HOME_TIME_VIOLATION_WEBHOOK_SECRET variable is the fallback). No secret
 * configured → every call is refused. The token is never logged, and nothing
 * here throws to the app's error handler, which would log the URL it carries.
 *
 * THE PAYLOAD IS A HINT. Only the deal id is taken from it; the card is read
 * again from Bitrix and its current stage decides. The answer is immediate
 * (202) and the work happens after it — a webhook that is lost or answered
 * late costs nothing, because the thirty-minute pass sees every card anyway.
 */

const express = require('express');
const { tokensMatch, dealIdFromWebhook } = require('../../lib/homeTime/violations');
const { handleWebhookDeal } = require('../../services/homeTime/violationAlerts');
const { resolveWebhookSecret } = require('../../services/homeTime/violationWebhookSecret');

function createHomeTimeViolationWebhookRoutes({
  telegram = null, handle = handleWebhookDeal, resolveSecret = () => resolveWebhookSecret(),
} = {}) {
  const router = express.Router();

  const receive = async (req, res) => {
    try {
      const given = req.query?.token ?? req.body?.token;
      if (!tokensMatch(given, await resolveSecret())) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      const dealId = dealIdFromWebhook(req.body || {}, req.query || {});
      if (!dealId) return res.status(400).json({ error: 'No deal id in the request' });
      res.status(202).json({ status: 'accepted' });
      setImmediate(() => {
        Promise.resolve(handle(dealId, { telegram })).catch(() => {});
      });
      return undefined;
    } catch (err) {
      console.warn('[HOME-TIME-VIOLATION] webhook could not be read:', String(err.message).slice(0, 120));
      if (!res.headersSent) res.status(400).json({ error: 'Bad request' });
      return undefined;
    }
  };

  router.post('/bitrix/home-time-violation', receive);
  router.get('/bitrix/home-time-violation', receive);
  return router;
}

module.exports = { createHomeTimeViolationWebhookRoutes };
