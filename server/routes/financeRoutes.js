'use strict';

/**
 * The Finance page's API — the one place captured payment text leaves the
 * database.
 *
 * EVERYTHING ELSE IN THIS FEATURE ANSWERS WITH COUNTS. The settings screen, the
 * health block and the weekly report all deliberately say how many and never
 * what. This router is the exception, and it is the exception ON PURPOSE: a
 * person reconciling money codes has to see the message, and the alternative —
 * scrolling Telegram — is the problem the whole feature exists to solve.
 *
 * So it is narrow and it is guarded:
 *
 *   `authMiddleware` on every route, the same admin gate the settings API uses;
 *   NOTHING here writes a money code, an amount or a status by hand. The three
 *     actions re-run machinery that already exists (re-read a message, re-queue
 *     a document, send a report) and nothing takes a value from the caller;
 *   a Telegram link is built SERVER-SIDE from the stored chat and message ids,
 *     never accepted from the client.
 *
 * Mounted at /api/finance by server/api.js.
 */

const express = require('express');
const financeMessages = require('../../database/financeMessages');
const financeDocuments = require('../../database/financeDocuments');
const financeReports = require('../../database/finance/reports');
const { getFinanceSettings } = require('../../database/financeSettings');
const { sendFailure } = require('../middleware/failureResponse');

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function limitFrom(query) {
  const n = Number.parseInt(String(query?.limit ?? ''), 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, n);
}

function fail(res, err, message) {
  return sendFailure(res, err, { message, logPrefix: '[FINANCE API]' });
}

function createFinanceRouter({ authMiddleware, telegram = null, buildMessageUrl = null }) {
  const router = express.Router();

  /**
   * The captured messages. THE ONE PLACE TEXT LEAVES THE DATABASE.
   *
   * `status` filters by what the parser made of it, which is how somebody works
   * through the `ambiguous` and `unparsed` pile — the two the provisional
   * parser is tightened from.
   */
  router.get('/messages', authMiddleware, async (req, res) => {
    try {
      const rows = await financeMessages.listMessages({
        limit: limitFrom(req.query),
        status: req.query.status || null,
      });
      res.json({ messages: rows.map((r) => withLink(r, buildMessageUrl)) });
    } catch (err) {
      fail(res, err, 'Failed to read the captured finance messages');
    }
  });

  router.get('/moneycodes', authMiddleware, async (req, res) => {
    try {
      res.json({
        moneycodes: await financeMessages.listMoneycodes({
          limit: limitFrom(req.query),
          duplicatesOnly: req.query.duplicates === 'true',
        }),
      });
    } catch (err) {
      fail(res, err, 'Failed to read the money codes');
    }
  });

  router.get('/documents', authMiddleware, async (req, res) => {
    try {
      res.json({
        documents: await financeDocuments.listDocuments({
          limit: limitFrom(req.query),
          status: req.query.status || null,
        }),
      });
    } catch (err) {
      fail(res, err, 'Failed to read the finance documents');
    }
  });

  router.get('/reports', authMiddleware, async (req, res) => {
    try {
      res.json({ reports: await financeReports.listReports({ limit: limitFrom(req.query) }) });
    } catch (err) {
      fail(res, err, 'Failed to read the finance reports');
    }
  });

  /**
   * Re-read one captured message with the CURRENT parser.
   *
   * This is what makes "capture first, codify second" a real workflow rather
   * than a slogan: the text was kept verbatim precisely so a tightened parser
   * could be run over it. Nothing is supplied by the caller — the message id is
   * the whole request, and the parser decides.
   */
  router.post('/messages/:id/reparse', authMiddleware, async (req, res) => {
    try {
      const out = await financeMessages.reparseMessage(Number(req.params.id));
      if (!out) return res.status(404).json({ error: 'No such captured message.' });
      return res.json(out);
    } catch (err) {
      return fail(res, err, 'Failed to re-read that message');
    }
  });

  /**
   * Put a document back in the queue.
   *
   * For the `failed` ones — the ones Wenze could not FETCH — after whatever
   * stopped it has been dealt with. It resets the attempt ladder, because a
   * person asking for a retry is new information the backoff does not have.
   */
  router.post('/documents/:id/retry', authMiddleware, async (req, res) => {
    try {
      const requeued = await financeDocuments.requeueDocument(Number(req.params.id));
      if (!requeued) return res.status(404).json({ error: 'No such document, or it is already queued.' });
      return res.json({ requeued: true });
    } catch (err) {
      return fail(res, err, 'Failed to queue that document again');
    }
  });

  return router;
}

/**
 * A Telegram deep link, built HERE from the stored ids.
 *
 * Never accepted from the client, and null for a chat Telegram has no link
 * shape for — a broken link in a payments screen is worse than none.
 */
function withLink(row, buildMessageUrl) {
  if (typeof buildMessageUrl !== 'function') return { ...row, telegramUrl: null };
  return { ...row, telegramUrl: buildMessageUrl(row.chatId, row.messageId) || null };
}

module.exports = { createFinanceRouter, DEFAULT_LIMIT, MAX_LIMIT };
