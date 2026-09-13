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
const weeklyReport = require('../../services/finance/weeklyReportService');
const captureService = require('../../services/finance/captureService');
const { wakeFinanceDocumentReader } = require('../../services/finance/documentReader');
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
   * What Monday's report would say, for the period that has just ended.
   *
   * It sends nothing and records nothing, which is the point: somebody deciding
   * whether to switch the weekly summary on can read the figures first.
   */
  router.get('/reports/preview', authMiddleware, async (req, res) => {
    try {
      res.json(await weeklyReport.previewReport());
    } catch (err) {
      fail(res, err, 'Failed to build the report preview');
    }
  });

  /**
   * Send that report now, because a person asked.
   *
   * Recorded as `manual`, so it neither collides with the scheduled row nor
   * stands in for it — Monday morning still goes out. A refusal here is a real
   * answer ("no chat is set"), so it is a 400 with the reason rather than a 500.
   */
  router.post('/reports/send-now', authMiddleware, async (req, res) => {
    try {
      const out = await weeklyReport.sendReportNow({ telegram });
      if (!out.sent) return res.status(400).json({ error: out.reason });
      return res.json(out);
    } catch (err) {
      return fail(res, err, 'Failed to send the report');
    }
  });

  /**
   * Re-read one captured message with the CURRENT parser.
   *
   * This is what makes "capture first, codify second" a real workflow rather
   * than a slogan: the text was kept verbatim precisely so a tightened parser
   * could be run over it. Nothing is supplied by the caller — the message id is
   * the whole request, and the parser decides.
   *
   * IT GOES THROUGH THE CAPTURE SERVICE, NOT STRAIGHT TO THE TABLE. A code the
   * re-read recognises has to be recorded through the same duplicate decision a
   * live capture uses, or the message leaves the unclear pile while the Money
   * codes tab and every weekly total stay exactly as wrong as before.
   */
  router.post('/messages/:id/reparse', authMiddleware, async (req, res) => {
    try {
      const out = await captureService.reparseCapturedMessage(Number(req.params.id));
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
   *
   * AND IT POKES THE READER, exactly as capture does. After an empty drain the
   * queue scheduler holds no retry timer — only the 15-minute idle sweep — so
   * without the poke a row made due right now sits untouched for a quarter of
   * an hour while the screen says it will be read within a few minutes.
   */
  router.post('/documents/:id/retry', authMiddleware, async (req, res) => {
    try {
      const requeued = await financeDocuments.requeueDocument(Number(req.params.id));
      if (!requeued) return res.status(404).json({ error: 'No such document, or it is already queued.' });
      wakeFinanceDocumentReader();
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
