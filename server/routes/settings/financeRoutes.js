/**
 * Finance Monitor — admin API.
 *
 * Money codes are issued in a Telegram group and then exist nowhere else, so
 * "did we already send that one?" is answered by scrolling. This is where an
 * administrator points Wenze at that group.
 *
 * THE ENABLE SWITCH IS GUARDED, AND THAT IS THE POINT OF THIS FILE. It cannot
 * be turned on without a chat that has been VALIDATED — the bot has been asked
 * whether it can see that chat and whether it is a group. Capturing payment
 * messages from a chat nobody confirmed is the mistake this feature must not
 * make, and a settings form is where it would be made.
 *
 * THE STATUS RESPONSE IS COUNTS ONLY. Never message text, never a code, never a
 * sender. The question a settings screen asks is "is this capturing, and does
 * it look right" — and `finance_messages.text` is the one place payment text is
 * meant to live. `server/routes/financeRoutes.js` (Stage D4) is where the rows
 * themselves get a screen, behind its own permission.
 */

const express = require('express');
const financeSettings = require('../../../database/financeSettings');
const financeMessages = require('../../../database/financeMessages');
const financeDocuments = require('../../../database/financeDocuments');
const financeReports = require('../../../database/finance/reports');
const { checkChatId } = require('../../../services/telegramChatIdCheck');
// Required directly, not taken from deps: the settings router only passes
// { authMiddleware, telegram }, so expecting it as a dep would arrive
// undefined and silently disable the sign-flip check that exists because a
// dropped minus sign once sent months of alerts to a chat that did not exist.
const { getGroupByTelegramId } = require('../../../database/groups');
const { sendFailure } = require('../../middleware/failureResponse');

function createFinanceSettingsRouter({ authMiddleware, telegram }) {
  const router = express.Router();

  router.get('/finance', authMiddleware, async (req, res) => {
    try {
      res.json(await financeSettings.getFinanceSettings());
    } catch (err) {
      sendFailure(res, err, { message: 'Failed to read the Finance Monitor settings', logPrefix: '[SETTINGS API]' });
    }
  });

  /**
   * What has been captured — counts by status, and nothing else.
   *
   * `available: false` means the table is not there yet, which is a different
   * answer from "nothing captured" and is reported as such.
   *
   * The document counts are counts too — how many are waiting, how many a
   * person still has to look at. Never a file name, never a caption, never
   * anything read out of one.
   *
   * The last few reports come back as their STATUS and their totals, never
   * their body. "What did last week's report say" is a real question and it is
   * answered on the Finance page, which has its own permission; a settings
   * screen answers "did it go out".
   */
  router.get('/finance/status', authMiddleware, async (req, res) => {
    try {
      const [settings, capture, documents, reports] = await Promise.all([
        financeSettings.getFinanceSettings(),
        financeMessages.summariseCapture(),
        financeDocuments.summariseDocuments(),
        financeReports.listReports({ limit: 8 }),
      ]);
      res.json({ settings, capture, documents, reports });
    } catch (err) {
      sendFailure(res, err, { message: 'Failed to read the Finance Monitor status', logPrefix: '[SETTINGS API]' });
    }
  });

  /**
   * Prove a CANDIDATE chat from the request body, before it is saved.
   *
   * Same shape as every other integration test in this application: the value
   * being proved comes from the body, not from storage, so a group is verified
   * before it is committed to rather than after.
   */
  router.post('/finance/validate-chat', authMiddleware, async (req, res) => {
    try {
      const result = await checkChatId(req.body?.chatId, { telegram, getGroupByTelegramId });
      if (!result.ok) {
        return res.status(400).json({
          ok: false,
          status: result.status,
          message: result.message,
          suggestion: result.suggestion ?? null,
        });
      }
      return res.json({
        ok: true,
        status: result.status,
        chatId: result.chatId,
        chatTitle: result.groupName ?? null,
        message: result.message ?? null,
      });
    } catch (err) {
      return sendFailure(res, err, { message: 'Failed to validate the finance group', logPrefix: '[SETTINGS API]' });
    }
  });

  router.put('/finance', authMiddleware, async (req, res) => {
    try {
      const patch = req.body || {};

      // Validating here as well as on the button: a PUT can arrive without one,
      // and "enabled" must never be reachable by a caller that skipped it.
      if (patch.chatId !== undefined && patch.chatId !== null && String(patch.chatId).trim() !== '') {
        const result = await checkChatId(patch.chatId, { telegram, getGroupByTelegramId });
        if (!result.ok) {
          return res.status(400).json({ message: result.message, status: result.status });
        }
        patch.chatId = result.chatId;
        if (!patch.chatTitle && result.groupName) patch.chatTitle = result.groupName;
        patch.chatValidatedAt = new Date();
      }

      // The report's own chat is validated on exactly the same terms. It is a
      // different room from the finance group often enough to matter — a
      // payment summary going to accounting rather than to the people posting
      // codes — and a dropped minus sign there fails just as silently.
      if (patch.weeklyReportChatId !== undefined && patch.weeklyReportChatId !== null
          && String(patch.weeklyReportChatId).trim() !== '') {
        const result = await checkChatId(patch.weeklyReportChatId, { telegram, getGroupByTelegramId });
        if (!result.ok) {
          return res.status(400).json({ message: result.message, status: result.status });
        }
        patch.weeklyReportChatId = result.chatId;
      }

      const saved = await financeSettings.updateFinanceSettings(patch, req.admin?.id ?? null);
      return res.json(saved);
    } catch (err) {
      if (err?.statusCode === 400) return res.status(400).json({ message: err.message });
      return sendFailure(res, err, { message: 'Failed to save the Finance Monitor settings', logPrefix: '[SETTINGS API]' });
    }
  });

  return router;
}

module.exports = { createFinanceSettingsRouter };
