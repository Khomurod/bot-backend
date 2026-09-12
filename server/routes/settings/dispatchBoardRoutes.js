/**
 * Dispatcher Board connection — admin API.
 *
 * The Board is the authority on TODAY'S ASSIGNMENT: which driver is in which
 * truck, with which trailer, at what status. Wenze stays the authority on who a
 * person permanently is. This is where an administrator points Wenze at it.
 *
 * THREE RULES THIS FILE ENFORCES, all for the same reason — the Board's token
 * travels in a query string:
 *
 *   - the token is write-only; the GET returns a masked last-4 and nothing else;
 *   - `/test` proves a CANDIDATE from the request body, so a connection is
 *     verified before it is saved, and the candidate is never echoed back;
 *   - the test response is COUNTS AND HISTOGRAMS ONLY. Returning rows would put
 *     driver names, phone numbers and trailer numbers on a settings screen to
 *     answer a question that is really "did it connect, and does it look
 *     right". The key names of any unrecognised column ARE returned, because
 *     that is how the real shape is learned without showing the data in it.
 *
 * Split out of server/routes/settingsRoutes.js.
 */

const express = require('express');
const board = require('../../../database/dispatchBoardSettings');
const boardRows = require('../../../database/dispatchBoard');
const { fetchBoard } = require('../../../services/dispatchBoard/client');
const { parseBoardPayload, summariseBoardPayload } = require('../../../lib/board/parse');
const { stripUrls, splitCredentialsFromUrl } = require('../../../lib/security/redactUrls');
const { sendFailure } = require('../../middleware/failureResponse');

/**
 * The repo's classified failure responder, with this file's one extra rule.
 *
 * `sendFailure` gives a database outage its own 503 and a machine-readable
 * `DB_*` code, so the admin can tell "Postgres is unreachable" from "the server
 * broke" — a plain 500 collapses both into the same unhelpful screen. It also
 * echoes the error's message as `detail`, and the errors in this file can carry
 * a Board URL with its token in the query string, so the message is stripped
 * first while the classification the responder needs is kept.
 */
function boardFailure(res, err, message) {
  const safe = new Error(stripUrls(err?.message || ''));
  safe.code = err?.code;
  safe.dbFailure = err?.dbFailure;
  return sendFailure(res, safe, { message, logPrefix: '[SETTINGS API]' });
}

function createDispatchBoardSettingsRouter({ authMiddleware }) {
  const router = express.Router();

  router.get('/dispatch-board', authMiddleware, async (req, res) => {
    try {
      const settings = await board.getBoardSettingsForAdmin();
      res.json({ settings });
    } catch (err) {
      boardFailure(res, err, 'Failed to load Dispatcher Board settings');
    }
  });

  router.put('/dispatch-board', authMiddleware, async (req, res) => {
    try {
      const payload = req.body || {};
      if (payload.baseUrl !== undefined && String(payload.baseUrl).trim()
          && !board.usableBaseUrl(payload.baseUrl)) {
        res.status(400).json({
          error: 'That does not look like a web address. Paste the Apps Script URL that ends in /exec.',
          field: 'baseUrl',
        });
        return;
      }
      const settings = await board.updateBoardSettings(payload, {
        updatedBy: req.admin?.username || req.admin?.id || null,
      });
      res.json({ settings });
    } catch (err) {
      boardFailure(res, err, 'Failed to save Dispatcher Board settings');
    }
  });

  /**
   * What the poller last stored — the Feed card.
   *
   * COUNTS ONLY, for the same reason `/test` returns counts only: this answers
   * "is the feed alive and does it look right", and no part of that question
   * needs a driver's name, phone number or truck. The status histogram is
   * whatever the board actually says, not a fixed list, so a word dispatch
   * invents shows up here instead of vanishing into "other".
   */
  router.get('/dispatch-board/feed', authMiddleware, async (req, res) => {
    try {
      const [summary, settings] = await Promise.all([
        boardRows.summariseBoard(),
        board.getBoardSettingsForAdmin(),
      ]);
      res.json({
        summary,
        lastPollAt: settings.lastPollAt,
        lastPollOk: settings.lastPollOk,
        lastPollCount: settings.lastPollCount,
        lastPollBoardDate: settings.lastPollBoardDate,
        lastError: settings.lastError,
      });
    } catch (err) {
      boardFailure(res, err, 'Failed to read the Dispatcher Board feed');
    }
  });

  /**
   * Prove a connection. Uses the candidate from the body when one is supplied,
   * so a URL and token can be tested BEFORE they are saved, and falls back to
   * what is stored when the form is only re-testing.
   */
  router.post('/dispatch-board/test', authMiddleware, async (req, res) => {
    try {
      const stored = await board.getBoardConfig();
      // A credential pasted inside the candidate URL is separated the same way
      // it would be on save, so testing "the link" works and never puts the
      // token in a log line.
      const candidate = splitCredentialsFromUrl(req.body?.baseUrl || '');
      const candidateUrl = candidate.url;
      const candidateToken = String(req.body?.token || '').trim() || candidate.token || '';

      const baseUrl = candidateUrl || stored.baseUrl;
      const token = candidateToken || stored.token;

      // THE STORED TOKEN BELONGS TO THE STORED URL.
      //
      // Combining a candidate address with the saved credential hands the
      // write-only token to whatever was typed — a typo, or an address chosen
      // by somebody who can reach this form. A new address must bring its own
      // token, which is also the honest thing to ask: a different board has a
      // different credential.
      const addressChanged = Boolean(candidateUrl) && candidateUrl !== stored.baseUrl;
      if (addressChanged && !candidateToken) {
        res.json({
          connected: false,
          message: 'Enter the token for that address before testing it. '
            + 'The saved token belongs to the saved address and is not sent anywhere else.',
        });
        return;
      }

      const { json } = await fetchBoard({ baseUrl, token });
      const parsed = parseBoardPayload(json);
      const summary = summariseBoardPayload(parsed);

      res.json({
        connected: parsed.ok,
        message: parsed.ok
          ? `Read ${summary.count} row(s) from the board.`
          : 'The board answered, but no rows could be found in its reply.',
        boardDate: parsed.boardDate,
        generatedAt: parsed.generatedAt,
        ...summary,
        // Names only — this is how an unfamiliar column is discovered without
        // putting the fleet's data on a screen.
        unknownFields: [...new Set(
          parsed.problems.filter((p) => p.kind === 'unknown_field').map((p) => p.field)
        )],
      });
    } catch (err) {
      // `BoardFetchError` messages are URL-stripped at construction; anything
      // else goes through the same door on the way out.
      res.json({ connected: false, message: stripUrls(err.message) });
    }
  });

  return router;
}

module.exports = { createDispatchBoardSettingsRouter };
