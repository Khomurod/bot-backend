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
const { fetchBoard } = require('../../../services/dispatchBoard/client');
const { parseBoardPayload, summariseBoardPayload } = require('../../../lib/board/parse');
const { stripUrls } = require('../../../lib/security/redactUrls');

function createDispatchBoardSettingsRouter({ authMiddleware }) {
  const router = express.Router();

  router.get('/dispatch-board', authMiddleware, async (req, res) => {
    try {
      const settings = await board.getBoardSettingsForAdmin();
      res.json({ settings });
    } catch (err) {
      console.error('[SETTINGS API] dispatch board load failed:', stripUrls(err.message));
      res.status(500).json({ error: 'Failed to load Dispatcher Board settings' });
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
      console.error('[SETTINGS API] dispatch board update failed:', stripUrls(err.message));
      res.status(500).json({ error: 'Failed to save Dispatcher Board settings' });
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
      const baseUrl = String(req.body?.baseUrl || '').trim() || stored.baseUrl;
      const token = String(req.body?.token || '').trim() || stored.token;

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
